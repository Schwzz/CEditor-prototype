// Stage 1.5 smoke test: launch the real Tauri Framecode executable (not a
// probe page) and verify through WebView2's DevTools protocol that the
// existing frontend boots to the Home screen with the truthful desktop
// adapter installed and no uncaught startup errors.
//
// Prerequisite: a built Tauri binary AND the Microsoft Edge WebView2
// Runtime (desktop Windows ships it in-box; Windows Server does not - the
// CI workflow installs it in a dedicated step). Resolution order for the
// executable:
//   1. FRAMECODE_TAURI_EXE environment variable (local runs that redirect
//      CARGO_TARGET_DIR, CI artifact paths, etc.)
//   2. src-tauri/target/release/framecode.exe (plain CI / default builds)
//
// The tab is driven over CDP exactly like scripts/test-desktop.mjs drives
// Electron; the app itself is launched the way a real user launches it.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

// The WebView2 Evergreen runtime records its version under this key. If it
// is absent the Tauri webview cannot exist: the app process then stays
// alive with no window and no CDP endpoint (verified experimentally), so
// failing fast here with the real cause beats a blind CDP timeout.
const WEBVIEW2_REG_KEY =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

function webview2RuntimeVersion() {
  if (process.platform !== "win32") return null;
  const { status, stdout } = spawnSync("reg", ["query", WEBVIEW2_REG_KEY, "/v", "pv"], {
    encoding: "utf8",
  });
  if (status !== 0) return null;
  const match = stdout.match(/pv\s+REG_SZ\s+(\S+)/);
  return match ? match[1] : null;
}

const runtimeVersion = webview2RuntimeVersion();
if (!runtimeVersion) {
  console.error("TAURI SMOKE FAIL: Microsoft Edge WebView2 Runtime is not installed.");
  console.error(
    "The Tauri app cannot create a webview without it (the process would stay " +
      "alive with no window and no CDP endpoint). Desktop Windows ships the " +
      "runtime in-box; Windows Server runners must install it first - see the " +
      "'Install WebView2 Runtime' step in .github/workflows/check.yml.",
  );
  process.exit(1);
}
console.log(`WebView2 Runtime: ${runtimeVersion}`);

const exePath =
  process.env.FRAMECODE_TAURI_EXE ??
  join(process.cwd(), "src-tauri", "target", "release", "framecode.exe");

if (!existsSync(exePath)) {
  console.error(`TAURI SMOKE FAIL: executable not found at ${exePath}`);
  console.error("Build it first with: npm run build:tauri");
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const debugPort = await freePort();
console.log(`Launching ${exePath} with CDP on port ${debugPort}`);

// Capture the app's own output; Tauri/wry panics (e.g. webview creation
// failures) surface on stderr and belong in the failure report.
const stdoutPath = join(tmpdir(), "framecode-tauri-smoke-stdout.log");
const stderrPath = join(tmpdir(), "framecode-tauri-smoke-stderr.log");
const stdoutFd = openSync(stdoutPath, "w");
const stderrFd = openSync(stderrPath, "w");
const app = spawn(exePath, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
  stdio: ["ignore", stdoutFd, stderrFd],
});

const appState = () => {
  const exited = app.exitCode !== null || app.signalCode !== null;
  if (!exited) return "alive";
  return (
    `exited (code ${app.exitCode ?? "?"}` +
    `${app.signalCode ? `, signal ${app.signalCode}` : ""})`
  );
};
const appLogs = () => {
  const lines = [];
  for (const [label, path] of [["stdout", stdoutPath], ["stderr", stderrPath]]) {
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content) lines.push(`--- app ${label} ---\n${content}`);
    } catch {
      // A missing/empty log file needs no reporting.
    }
  }
  return lines.join("\n");
};

// Failure-path evidence for the CDP endpoint itself: the actual browser
// process command lines (shows whether --remote-debugging-port survived
// into the WebView2 environment) and the TCP state of the chosen port.
const cdpDiagnostics = () => {
  const lines = [];
  try {
    const { status, stdout } = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    if (status === 0 && stdout.trim()) {
      lines.push(`--- msedgewebview2 command lines ---\n${stdout.trim()}`);
      lines.push(
        `remote-debugging-port in browser args: ${
          stdout.includes("--remote-debugging-port") ? "present" : "DROPPED"
        }`,
      );
    } else {
      lines.push("no msedgewebview2 processes found (webview never created)");
    }
  } catch {
    // Diagnostics are best-effort; never mask the real failure.
  }
  try {
    const { status, stdout } = spawnSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      timeout: 20000,
    });
    if (status === 0) {
      const rows = stdout
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${debugPort} `))
        .map((line) => line.trim());
      lines.push(
        `port ${debugPort} tcp state: ${
          rows.length ? rows.join(" | ") : "not listening"
        }`,
      );
    }
  } catch {
    // Diagnostics are best-effort; never mask the real failure.
  }
  return lines.join("\n");
};

let exitCode = 0;
try {
  const crashed = new Promise((_, reject) => {
    app.once("exit", () => {
      reject(
        new Error(
          `Tauri app ${appState()} before the smoke test could drive it\n${appLogs()}`,
        ),
      );
    });
  });
  const cdpAvail = (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (app.exitCode !== null || app.signalCode !== null)
        throw new Error(
          `Tauri app ${appState()} while waiting for CDP\n${appLogs()}`,
        );
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await res.json();
        // Wait for the app's real page, not the transient about:blank
        // target that can exist before the Tauri webview navigates.
        const page = targets.find(
          (t) => t.type === "page" && /tauri/.test(t.url),
        );
        if (page) return page;
      } catch {
        // WebView2 not listening yet; keep waiting.
      }
      await sleep(250);
    }
    throw new Error(
      "WebView2 CDP endpoint never became reachable\n" +
        `app process: ${appState()}\n${appLogs()}\n${cdpDiagnostics()}\n` +
        "If 'remote-debugging-port: DROPPED' above, the host process is " +
        "elevated and WebView2 Runtime >=150 discards the env var by design " +
        "(WebView2Feedback#5645, tauri-apps/wry#1782); the CI workflow runs " +
        "this test de-elevated via gsudo --integrity Medium for that reason.",
    );
  })();

  const page = await Promise.race([cdpAvail, crashed]);
  console.log(`CDP page target: ${page.title || "(untitled)"}`);

  const checks = await new Promise((resolveChecks, rejectChecks) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) rejectChecks(new Error(`CDP ${data.error.message}`));
      else entry.resolve(data.result);
    });
    ws.addEventListener("error", () =>
      rejectChecks(new Error("CDP WebSocket failed")),
    );
    ws.addEventListener("open", async () => {
      try {
        // Wait for the renderer to finish booting: app.mjs sets
        // data-ready="true" on <body> only after boot() completes. A false
        // result is an explicit failure, not a fallthrough into checks that
        // would fail with unrelated symptoms.
        const ready = await send("Runtime.evaluate", {
          expression: `(async () => {
            for (let i = 0; i < 200; i++) {
              if (document.body?.dataset?.ready === "true") return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (ready?.result?.value !== true) {
          const stage = await send("Runtime.evaluate", {
            expression: "String(document.body?.dataset?.stage ?? null)",
            returnByValue: true,
          });
          ws.close();
          rejectChecks(
            new Error(
              "renderer never signaled readiness: body[data-ready] did not " +
                `become "true" within 20s (stage=${stage?.result?.value})`,
            ),
          );
          return;
        }
        const results = {};
        const evaluate = async (name, expression) => {
          const { result } = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          results[name] = result?.value ?? result?.description ?? null;
        };
        await evaluate("title", "document.title");
        await evaluate("stage", "document.body.dataset.stage");
        await evaluate("probe", "document.documentElement.dataset.tauri");
        await evaluate(
          "bridgeType",
          "typeof window.framecodeDesktop",
        );
        await evaluate(
          "bridgeMethods",
          `(() => {
            const b = window.framecodeDesktop;
            if (!b || typeof b !== "object") return null;
            const required = [
              "openProject","openRecentProject","listRecents","removeRecent",
              "getSettings","setSetting","resetSettings","appInfo","saveProject",
              "newProject","confirmUnsaved","setDirty","setStage","setCodePanel",
              "readRecovery","writeRecovery","clearRecovery","relinkRecoveryAssets",
              "importImage","readClipboard","writeClipboard","editClipboard",
              "finishClose","onCommand",
            ];
            return required.every(
              (m) => typeof b[m] === "function",
            ) && b.assetToken === "" && typeof b.platform === "string";
          })()`,
        );
        await evaluate(
          "startupErrors",
          "JSON.stringify(window.__framecodeStartupErrors ?? null)",
        );
        // Real IPC round trip: the adapter must reach the Rust command.
        await evaluate(
          "ipcRoundTrip",
          `(async () => {
            try {
              const info = await window.framecodeDesktop.appInfo();
              return "ok:" + info.name + ":" + info.version;
            } catch (error) {
              return "error:" + error.message;
            }
          })()`,
        );
        ws.close();
        resolveChecks(results);
      } catch (error) {
        ws.close();
        rejectChecks(error);
      }
    });
  });

  const failures = [];
  const expect = (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " — " + detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  expect("Home screen title", checks.title === "Framecode", `title=${checks.title}`);
  expect(
    "renderer reached Home",
    checks.stage === "home",
    `stage=${checks.stage}`,
  );
  expect(
    "desktop_info round trip (probe)",
    String(checks.probe ?? "").startsWith("ok:"),
    `dataset.tauri=${checks.probe}`,
  );
  expect(
    "desktop bridge installed",
    checks.bridgeType === "object",
    `typeof=${checks.bridgeType}`,
  );
  expect(
    "bridge mirrors preload surface",
    checks.bridgeMethods === true,
    `methods=${JSON.stringify(checks.bridgeMethods)}`,
  );
  expect(
    "no uncaught startup errors",
    checks.startupErrors === "[]",
    `errors=${checks.startupErrors}`,
  );
  expect(
    "appInfo IPC round trip",
    String(checks.ipcRoundTrip ?? "").startsWith("ok:"),
    `result=${checks.ipcRoundTrip}`,
  );

  if (failures.length) {
    exitCode = 1;
    console.error("TAURI SMOKE FAIL: " + failures.length + " check(s) failed");
  } else {
    console.log("TAURI SMOKE COMPLETE: all checks passed.");
  }
} catch (error) {
  exitCode = 1;
  console.error("TAURI SMOKE FAIL: " + error.message);
} finally {
  // Kill the whole process tree (Tauri spawns WebView2 helper processes).
  spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  await sleep(1000);
  process.exit(exitCode);
}
