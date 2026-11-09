// Stage 1.5 smoke test: launch the real Tauri Framecode executable (not a
// probe page) and verify through WebView2's DevTools protocol that the
// existing frontend boots to the Home screen with the truthful desktop
// adapter installed and no uncaught startup errors.
//
// Prerequisite: a built Tauri binary. Resolution order:
//   1. FRAMECODE_TAURI_EXE environment variable (local runs that redirect
//      CARGO_TARGET_DIR, CI artifact paths, etc.)
//   2. src-tauri/target/release/framecode.exe (plain CI / default builds)
//
// The tab is driven over CDP exactly like scripts/test-desktop.mjs drives
// Electron; the app itself is launched the way a real user launches it.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

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
const app = spawn(exePath, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
  stdio: "ignore",
});

let exitCode = 0;
try {
  const crashed = new Promise((_, reject) => {
    app.once("exit", (code) =>
      reject(new Error(`Tauri app exited early with code ${code}`)),
    );
  });
  const cdpAvail = (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await res.json();
        const page = targets.find((t) => t.type === "page");
        if (page) return page;
      } catch {
        // WebView2 not listening yet; keep waiting.
      }
      await sleep(250);
    }
    throw new Error("WebView2 CDP endpoint never became reachable");
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
      if (data.error) reject(new Error(`CDP ${data.error.message}`));
      else entry.resolve(data.result);
    });
    ws.addEventListener("error", () =>
      rejectChecks(new Error("CDP WebSocket failed")),
    );
    ws.addEventListener("open", async () => {
      try {
        // Wait for the renderer to finish booting: app.mjs sets
        // data-ready="true" on <body> only after boot() completes.
        await send("Runtime.evaluate", {
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
