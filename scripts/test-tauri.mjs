// Stage 1.5 smoke test: launch the real Tauri Framecode executable (not a
// probe page) and verify through WebView2's DevTools protocol that the
// existing frontend boots to the Home screen with the truthful desktop
// adapter installed and no uncaught startup errors. Since Stage 3 it also
// drives the file operations end to end, since Stage 4 the asset
// pipeline: token delivery, the same-origin asset request matrix, a
// same-origin canvas pixel read, and the recovery relink command path,
// and since Stage 5 the window lifecycle commands: the dirty/title state,
// stage validation, the templates delivery, the close-handshake refusal
// on a dirty document, and a clean attestation that really closes the app.
//
// Prerequisite: a built Tauri binary AND the Microsoft Edge WebView2
// Runtime (desktop Windows ships it in-box; Windows Server does not - the
// CI workflow installs it in a dedicated step). Resolution order for the
// executable:
//   1. FRAMECODE_TAURI_EXE environment variable (local runs that redirect
//      CARGO_TARGET_DIR, CI artifact paths, etc.)
//   2. src-tauri/target/release/framecode.exe (plain CI / default builds)
//
// The tab is driven over CDP exactly like the retired
// scripts/test-desktop.mjs drove Electron; the app itself is launched the
// way a real user launches it.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

// Stage 3 smoke fixture: a real project file on disk so the file-operation
// commands can be exercised end to end (Open Recent -> Save -> recents).
// Native dialogs cannot be driven by an automated test, so the dialog-free
// paths are what the smoke test covers; the dialog wrappers are exercised
// by the Rust unit tests with fixture dialogs, like the Electron suite.
const fixturePath = join(
  tmpdir(),
  `framecode-stage3-smoke-${process.pid}.framecode.json`,
);
const fixtureSource = 'composition("Stage3Smoke").duration(5)';
const savedSource = 'composition("Stage3Smoke").duration(7)';
writeFileSync(
  fixturePath,
  JSON.stringify(
    {
      format: "framecode-project",
      version: 1,
      source: fixtureSource,
      lastValid: fixtureSource,
    },
    null,
    2,
  ) + "\n",
);

// Stage 4 smoke fixtures: a 1x1 green PNG (same bytes as the Electron
// desktop suite) referenced by a second project fixture, so Open Recent
// authorizes it through the scan and the same-origin asset route can be
// exercised end to end.
const testImgPath = join(tmpdir(), `framecode-stage4-smoke-${process.pid}.png`);
const unauthorizedImgPath = join(
  tmpdir(),
  `framecode-stage4-smoke-unauthorized-${process.pid}.png`,
);
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngBytes = Buffer.from(pngBase64, "base64");
writeFileSync(testImgPath, pngBytes);
writeFileSync(unauthorizedImgPath, pngBytes);
const assetFixturePath = join(
  tmpdir(),
  `framecode-stage4-smoke-${process.pid}.framecode.json`,
);
const assetFixtureSource =
  'composition("Stage4Smoke").duration(5)\nimage("hero").at(0).for(5).source(' +
  JSON.stringify(testImgPath) +
  ")";
writeFileSync(
  assetFixturePath,
  JSON.stringify(
    {
      format: "framecode-project",
      version: 1,
      source: assetFixtureSource,
      lastValid: assetFixtureSource,
    },
    null,
    2,
  ) + "\n",
);

// Stage 6 smoke fixtures: a media project referencing a synthetic .mp4
// container, plus a real decodable MP4 for the seek/paint half. The
// synthetic file proves the parts an automated run can prove without
// decoding: media clips are authorized by the project scan, byte ranges
// are served on the app origin, the Range guard chain still answers 403
// first, a media project saves with the clip intact, and probing refuses
// non-media bytes with a structured error instead of a panic. The
// decodable fixture then drives the real UI through a recent-project open,
// seeks the transport, and reads the canvas pixels.
const testVideoPath = join(tmpdir(), `framecode-stage6-smoke-${process.pid}.mp4`);
const testVideoBytes = Buffer.alloc(4096);
for (let i = 0; i < testVideoBytes.length; i += 1) testVideoBytes[i] = i % 251;
writeFileSync(testVideoPath, testVideoBytes);
const mediaFixturePath = join(
  tmpdir(),
  `framecode-stage6-smoke-${process.pid}.framecode.json`,
);
const mediaFixtureSource =
  'composition("Stage6Smoke").duration(6)\nvideo("clip").at(0).for(5).source(' +
  JSON.stringify(testVideoPath) +
  ").sourceDuration(5)";
writeFileSync(
  mediaFixturePath,
  JSON.stringify(
    {
      format: "framecode-project",
      version: 1,
      source: mediaFixtureSource,
      lastValid: mediaFixtureSource,
    },
    null,
    2,
  ) + "\n",
);

// Stage 6 decode fixture: a real 2-second H.264 MP4 (160x90, 10 fps) whose
// first second is red and second second is blue. Committed under
// tests/fixtures so the smoke run decodes actual video: seek to 0.5 s must
// paint red and 1.5 s blue, which is only possible if the range-served
// file decoded and the canvas accepted the frame (a tainted canvas would
// also throw on getImageData).
const decodeVideoPath = join(
  process.cwd(),
  "tests",
  "fixtures",
  "stage6-seek.mp4",
);
const decodeFixturePath = join(
  tmpdir(),
  `framecode-stage6-decode-${process.pid}.framecode.json`,
);
const decodeFixtureSource =
  'composition("Stage6Decode").duration(6)\nvideo("clip").at(0).for(2).source(' +
  JSON.stringify(decodeVideoPath) +
  ").sourceDuration(2).position(960, 540)";
writeFileSync(
  decodeFixturePath,
  JSON.stringify(
    {
      format: "framecode-project",
      version: 1,
      source: decodeFixtureSource,
      lastValid: decodeFixtureSource,
    },
    null,
    2,
  ) + "\n",
);

// Stage 6 memory fixture: a 512 MiB media file (not decodable - only its
// size matters) behind a project that authorizes it. `Range: bytes=0-` on
// it is the request a media element makes; the response must be a bounded
// 206 prefix, so the app process must not grow by the file size.
const LARGE_VIDEO_BYTES = 512 * 1024 * 1024;
const largeVideoPath = join(
  tmpdir(),
  `framecode-stage6-large-${process.pid}.mp4`,
);
{
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  const fd = openSync(largeVideoPath, "w");
  for (let written = 0; written < LARGE_VIDEO_BYTES; written += chunk.length)
    writeSync(fd, chunk);
  closeSync(fd);
}
const largeFixturePath = join(
  tmpdir(),
  `framecode-stage6-large-${process.pid}.framecode.json`,
);
const largeFixtureSource =
  'composition("Stage6Large").duration(6)\nvideo("big").at(0).for(2).source(' +
  JSON.stringify(largeVideoPath) +
  ").sourceDuration(2)";
writeFileSync(
  largeFixturePath,
  JSON.stringify(
    {
      format: "framecode-project",
      version: 1,
      source: largeFixtureSource,
      lastValid: largeFixtureSource,
    },
    null,
    2,
  ) + "\n",
);

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
        // Wait for the app's real page target: the URL must be the Tauri app
        // document (http://tauri.localhost on Windows, or a tauri:// custom
        // protocol) and never the transient about:blank target that exists
        // before and during the first navigation.
        const page = targets.find(
          (t) =>
            t.type === "page" &&
            !/^about:blank/i.test(t.url) &&
            /tauri\.localhost|^tauri:\/\//i.test(t.url),
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
  console.log(
    `CDP page target: ${page.title || "(untitled)"} (${page.url})`,
  );

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
      // Reject the individual command, not the whole run: the caller decides
      // whether the error is fatal or retryable (see evaluateStable).
      if (data.error) entry.reject(new Error(`CDP ${data.error.message}`));
      else entry.resolve(data.result);
    });
    // The webview navigates from the transient blank page to the app's
    // tauri.localhost document; an evaluate issued mid-navigation gets
    // "Execution context was destroyed". Retry on the freshly created
    // execution context instead of failing the smoke run on the race.
    const evaluateStable = async (name, expression) => {
      // Wall-clock cap so retries cannot stretch the run unboundedly.
      const deadline = Date.now() + 30000;
      for (let attempt = 0; ; attempt++) {
        try {
          const { result } = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          return result?.value ?? result?.description ?? null;
        } catch (error) {
          if (
            Date.now() > deadline ||
            attempt >= 40 ||
            !/Execution context was destroyed/i.test(String(error.message))
          ) {
            throw error;
          }
          await sleep(250);
        }
      }
    };
    ws.addEventListener("error", () =>
      rejectChecks(new Error("CDP WebSocket failed")),
    );
    ws.addEventListener("open", async () => {
      try {
        // Wait for the renderer to finish booting: app.mjs sets
        // data-ready="true" on <body> only after boot() completes. A false
        // result is an explicit failure, not a fallthrough into checks that
        // would fail with unrelated symptoms.
        const ready = await evaluateStable("ready", `(async () => {
            for (let i = 0; i < 200; i++) {
              if (document.body?.dataset?.ready === "true") return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          })()`);
        if (ready !== true) {
          // Report what the page actually looks like when readiness never
          // arrives: current URL, DOM readyState, boot stage.
          const detail = await evaluateStable(
            "detail",
            `JSON.stringify({
              href: String(location.href),
              readyState: document.readyState,
              stage: String(document.body?.dataset?.stage ?? null),
            })`,
          );
          ws.close();
          rejectChecks(
            new Error(
              "renderer never signaled readiness: body[data-ready] did not " +
                `become "true" within 20s (page state: ${detail})`,
            ),
          );
          return;
        }
        const results = {};
        const evaluate = (name, expression) =>
          evaluateStable(name, expression).then(
            (value) => (results[name] = value),
          );
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
              "setTemplates","readRecovery","writeRecovery","clearRecovery",
              "relinkRecoveryAssets","importImage","readClipboard","writeClipboard",
              "editClipboard","finishClose","onCommand",
            ];
            return required.every(
              (m) => typeof b[m] === "function",
            ) && typeof b.assetToken === "string" && typeof b.platform === "string";
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
        // Stage 3 file operations, end to end through the Rust commands:
        // New clears the session path, Open Recent loads the fixture and
        // records it, Save writes it back through the current path (no
        // dialog), and the recents list reflects both — then the entry is
        // removed again so the run leaves the app data as it found it.
        await evaluate(
          "fileOps",
          `(async () => {
            const invoke = window.__TAURI__.core.invoke;
            const fixture = ${JSON.stringify(fixturePath)};
            const steps = {};
            try {
              steps.newProject = await invoke("project_new");
              const loaded = await invoke("project_open_recent", { path: fixture });
              steps.loaded = {
                name: loaded?.name,
                path: loaded?.path,
                format: loaded?.project?.format,
                source: loaded?.project?.source,
              };
              const next = {
                ...loaded.project,
                source: ${JSON.stringify(savedSource)},
                lastValid: ${JSON.stringify(savedSource)},
              };
              steps.saved = await invoke("project_save", {
                project: next,
                saveAs: false,
              });
              const before = await window.framecodeDesktop.listRecents();
              steps.recentsBefore = before.filter((r) => r.path === fixture).length;
              const removed = await window.framecodeDesktop.removeRecent(fixture);
              steps.remaining = removed.filter((r) => r.path === fixture).length;
              const after = await window.framecodeDesktop.listRecents();
              steps.recentsAfter = after.filter((r) => r.path === fixture).length;
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            return JSON.stringify(steps);
          })()`,
        );
        // Stage 4 asset features. The capability token is delivered
        // asynchronously, so wait for it before building any asset URL.
        await evaluate(
          "assetTokenWait",
          `(async () => {
            for (let i = 0; i < 200; i++) {
              const token = window.framecodeDesktop?.assetToken;
              if (token) return token;
              await new Promise((r) => setTimeout(r, 50));
            }
            return "";
          })()`,
        );
        await evaluate(
          "assetMatrix",
          `(async () => {
            const token = window.framecodeDesktop.assetToken;
            const base = location.origin + "/assets/?path=";
            const enc = encodeURIComponent;
            const invoke = window.__TAURI__.core.invoke;
            const img = ${JSON.stringify(testImgPath)};
            const stranger = ${JSON.stringify(unauthorizedImgPath)};
            const steps = {};
            const status = async (u, init) => {
              try { return (await fetch(u, init)).status; }
              catch { return "fetch-error"; }
            };
            try {
              // Opening the image-bearing fixture authorizes its scanned
              // asset paths for this webview (and drops prior ones).
              const loaded = await invoke("project_open_recent", { path: ${JSON.stringify(assetFixturePath)} });
              steps.scanOpen = loaded?.project?.source === ${JSON.stringify(assetFixtureSource)};
              // Authorized + this window's token serves the real bytes.
              steps.authorized = await status(base + enc(img) + "&token=" + token);
              steps.wrongToken = await status(base + enc(img) + "&token=forged");
              steps.noToken = await status(base + enc(img));
              steps.missingPath = await status(location.origin + "/assets/");
              steps.relative = await status(base + enc("relative.png") + "&token=" + token);
              steps.post = await status(base + enc(img) + "&token=" + token, { method: "POST" });
              steps.unauthorized = await status(base + enc(stranger) + "&token=" + token);
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            await invoke("recents_remove", { path: ${JSON.stringify(assetFixturePath)} });
            return JSON.stringify(steps);
          })()`,
        );
        // Same-origin canvas proof: the authorized image decodes, draws,
        // and getImageData succeeds on it (a tainted canvas would throw
        // SecurityError), and the drawn pixel is the green source color.
        await evaluate(
          "canvasPixel",
          `(async () => {
            const token = window.framecodeDesktop.assetToken;
            const img = new Image();
            img.src =
              location.origin + "/assets/?path=" +
              encodeURIComponent(${JSON.stringify(testImgPath)}) +
              "&token=" + token;
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = () => reject(new Error("image failed to load"));
            });
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const { data } = ctx.getImageData(0, 0, 1, 1);
            return JSON.stringify({ r: data[0], g: data[1], b: data[2] });
          })()`,
        );
        // Recovery relinking, safe for an unattended run: with no recovery
        // data there is no candidate and no consent dialog, so the command
        // path is exercised without ever blocking on native UI.
        await evaluate(
          "relink",
          `(async () => {
            const invoke = window.__TAURI__.core.invoke;
            try {
              await invoke("recovery_clear");
              const result = await invoke("relink_recovery_assets");
              return JSON.stringify(result);
            } catch (error) {
              return JSON.stringify({ error: error?.message ?? String(error) });
            }
          })()`,
        );
        // Stage 6: the media half of the asset pipeline, driven end to end.
        // A Range request on an unauthorized media path must still be 403
        // (authorization runs before byte accounting); once the media
        // project is open, ranges are served with the spec headers, HEAD
        // mirrors GET, unsatisfiable ranges are 416, the media project
        // saves with its clip intact, and probing junk bytes fails with a
        // structured error instead of crashing.
        await evaluate(
          "mediaRange",
          `(async () => {
            const token = window.framecodeDesktop.assetToken;
            const base = location.origin + "/assets/?path=";
            const enc = encodeURIComponent;
            const invoke = window.__TAURI__.core.invoke;
            const video = ${JSON.stringify(testVideoPath)};
            const url = base + enc(video) + "&token=" + token;
            const steps = {};
            const get = async (init) => {
              try {
                const response = await fetch(url, init);
                const body = await response.arrayBuffer();
                return {
                  status: response.status,
                  length: body.byteLength,
                  contentRange: response.headers.get("content-range"),
                  acceptRanges: response.headers.get("accept-ranges"),
                  contentLength: response.headers.get("content-length"),
                };
              } catch (error) {
                return { status: "fetch-error", error: String(error) };
              }
            };
            try {
              steps.beforeOpen = (await get({ headers: { Range: "bytes=0-1023" } })).status;
              const loaded = await invoke("project_open_recent", {
                path: ${JSON.stringify(mediaFixturePath)},
              });
              steps.scanOpen = loaded?.project?.source === ${JSON.stringify(mediaFixtureSource)};
              steps.partial = await get({ headers: { Range: "bytes=0-1023" } });
              steps.head = await get({ method: "HEAD", headers: { Range: "bytes=0-1023" } });
              steps.suffix = await get({ headers: { Range: "bytes=-16" } });
              steps.unsatisfiable = (await get({ headers: { Range: "bytes=99999-" } })).status;
              steps.full = (await get({})).status;
              const saved = await invoke("project_save", {
                project: { ...loaded.project },
                saveAs: false,
              });
              steps.savedPath = saved?.path ?? null;
              try {
                await invoke("probe_media", { path: video });
                steps.probe = "MISSING — non-media bytes were accepted";
              } catch (error) {
                steps.probe = error?.message ?? String(error);
              }
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            await invoke("recents_remove", { path: ${JSON.stringify(mediaFixturePath)} });
            return JSON.stringify(steps);
          })()`,
        );
        // Stage 6 decode proof: open the decodable fixture through the real
        // Home -> Recents flow, then drive the transport slider. The canvas
        // center pixel must be red at 0.5 s and blue at 1.5 s, which means
        // the range-served MP4 decoded, the pool seeked to the real source
        // time, and the frame was painted on the app-origin canvas.
        await evaluate(
          "mediaDecode",
          `(async () => {
            const invoke = window.__TAURI__.core.invoke;
            const fixture = ${JSON.stringify(decodeFixturePath)};
            const steps = {};
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            try {
              // Seed Recents and authorize the fixture's scanned asset path.
              await invoke("project_open_recent", { path: fixture });
              steps.probe = await invoke("probe_media", {
                path: ${JSON.stringify(decodeVideoPath)},
              });
              // Reload the Home list through the real settings handler
              // without changing the value: opening the dialog fills the
              // persisted value, and dispatching change runs
              // changeSetting -> renderRecents.
              document.getElementById("homeSettings").click();
              const max = document.getElementById("settingsMaxRecents");
              max.dispatchEvent(new Event("change"));
              const settingsDialog = document.getElementById("settingsDialog");
              let open = null;
              for (let i = 0; i < 100 && !open; i += 1) {
                await wait(50);
                open = [...document.querySelectorAll(".recent-open")].find(
                  (button) => button.textContent.includes(fixture),
                );
              }
              if (settingsDialog.open) settingsDialog.close();
              if (!open)
                throw new Error("the fixture never appeared in Recents");
              open.click();
              for (let i = 0; i < 100; i += 1) {
                if (document.body.dataset.stage === "editor") break;
                await wait(50);
              }
              steps.stage = document.body.dataset.stage;
              steps.provenance = document.getElementById("mediaProvenance").hidden
                ? "hidden"
                : document.getElementById("mediaProvenance").textContent;
              const canvas = document.getElementById("canvas");
              const ctx = canvas.getContext("2d");
              const center = () => {
                const { data } = ctx.getImageData(
                  Math.floor(canvas.width / 2),
                  Math.floor(canvas.height / 2),
                  1,
                  1,
                );
                return { r: data[0], g: data[1], b: data[2] };
              };
              const seek = document.getElementById("seek");
              const seekAndRead = async (time, test) => {
                seek.value = String(time);
                seek.dispatchEvent(new Event("input"));
                let pixel = center();
                for (let i = 0; i < 100; i += 1) {
                  await wait(50);
                  pixel = center();
                  if (test(pixel)) return pixel;
                }
                return pixel;
              };
              steps.blue = await seekAndRead(
                1.5,
                (p) => p.b > 120 && p.b > p.r + 80 && p.b > p.g + 80,
              );
              steps.red = await seekAndRead(
                0.5,
                (p) => p.r > 120 && p.r > p.g + 80 && p.r > p.b + 80,
              );
              await invoke("recents_remove", { path: fixture });
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            return JSON.stringify(steps);
          })()`,
        );
        // Stage 6 memory bound: a 512 MiB clip behind an authorized
        // project, requested the way a media element asks (`bytes=0-`).
        // The response must be an 8 MiB 206 prefix, and the app process
        // must not grow by anything close to the file size.
        const workingSet = () => {
          const { status, stdout } = spawnSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${app.pid}).WorkingSet64`,
            ],
            { encoding: "utf8", timeout: 20000 },
          );
          const value = status === 0 ? Number(String(stdout).trim()) : NaN;
          return Number.isFinite(value) ? value : null;
        };
        const memoryBefore = workingSet();
        await evaluate(
          "mediaMemory",
          `(async () => {
            const token = window.framecodeDesktop.assetToken;
            const invoke = window.__TAURI__.core.invoke;
            const steps = {};
            try {
              await invoke("project_open_recent", {
                path: ${JSON.stringify(largeFixturePath)},
              });
              const response = await fetch(
                location.origin +
                  "/assets/?path=" +
                  encodeURIComponent(${JSON.stringify(largeVideoPath)}) +
                  "&token=" +
                  token,
                { headers: { Range: "bytes=0-" } },
              );
              const body = await response.arrayBuffer();
              steps.status = response.status;
              steps.length = body.byteLength;
              steps.contentRange = response.headers.get("content-range");
              steps.contentLength = response.headers.get("content-length");
              steps.acceptRanges = response.headers.get("accept-ranges");
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            await invoke("recents_remove", {
              path: ${JSON.stringify(largeFixturePath)},
            });
            return JSON.stringify(steps);
          })()`,
        );
        const memoryAfter = workingSet();
        results.memory = {
          before: memoryBefore,
          after: memoryAfter,
          growth:
            memoryBefore !== null && memoryAfter !== null
              ? memoryAfter - memoryBefore
              : null,
        };
        // Stage 5 window lifecycle, driven through the real Rust
        // commands: the dirty/title state accepts updates, the stage
        // validation rejects the bogus value like the Electron handler
        // did, the code-panel and template deliveries install the editor
        // menu state, and the state returns to Home afterwards. The
        // unsaved-change prompt itself is a blocking native dialog and
        // cannot be driven unattended; it is covered by the Rust unit
        // tests and manual validation.
        await evaluate(
          "lifecycleOps",
          `(async () => {
            const invoke = window.__TAURI__.core.invoke;
            const steps = {};
            try {
              await invoke("project_dirty", { dirty: true, name: "Stage5Smoke" });
              steps.dirty = "ok";
              await invoke("app_stage", { stage: "editor" });
              steps.stage = "ok";
              try {
                await invoke("app_stage", { stage: "bogus" });
                steps.badStage = "MISSING — the invalid stage was accepted";
              } catch (error) {
                steps.badStage = error?.message ?? String(error);
              }
              await invoke("app_code", { open: true });
              steps.codePanel = "ok";
              await invoke("app_templates", { names: ["Demo", "Grid"] });
              steps.templates = "ok";
              await invoke("project_dirty", { dirty: false, name: "" });
              await invoke("app_stage", { stage: "home" });
              steps.reset = "ok";
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            return JSON.stringify(steps);
          })()`,
        );
        // Stage 5 close handshake, end to end: a dirty document refuses
        // the close with the Electron error text; the clean attestation
        // then closes the window for real (the app process exit is
        // asserted below).
        await evaluate(
          "closeHandshake",
          `(async () => {
            const invoke = window.__TAURI__.core.invoke;
            const steps = {};
            try {
              await invoke("project_dirty", { dirty: true, name: "Stage5Close" });
              try {
                await invoke("window_finish_close");
                steps.refusal = "MISSING — a dirty document was allowed to close";
              } catch (error) {
                steps.refusal = error?.message ?? String(error);
              }
              if (steps.refusal !== "Newer unsaved changes remain.")
                return JSON.stringify(steps);
              await invoke("project_dirty", { dirty: false, name: "Stage5Close" });
              // The clean attestation closes the window; the page may die
              // before the response returns, which is success, not failure.
              invoke("window_finish_close").catch(() => {});
              steps.close = "sent";
            } catch (error) {
              steps.error = error?.message ?? String(error);
            }
            return JSON.stringify(steps);
          })()`,
        );
        ws.close();
        resolveChecks(results);
      } catch (error) {
        ws.close();
        // Annotate evaluation failures with the picked target so a stale or
        // wrong page is immediately visible in CI logs.
        rejectChecks(
          error instanceof Error
            ? new Error(
                `${error.message}\n(CDP target: ${page.url}, title: ${
                  page.title || "(untitled)"
                })`,
              )
            : error,
        );
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

  // Stage 3 file operations: the page returns a JSON step log; every step
  // must have happened, and the saved file must hold what Save wrote.
  let fileOps = null;
  try {
    fileOps = JSON.parse(checks.fileOps ?? "null");
  } catch {
    // A missing/unparsable step log is reported as the failure below.
  }
  expect("file operations ran without errors", !!fileOps && !fileOps.error, `steps=${checks.fileOps}`);
  if (fileOps && !fileOps.error) {
    expect(
      "project_new reports the Untitled name",
      fileOps.newProject?.name === "Untitled.framecode.json",
      `newProject=${JSON.stringify(fileOps.newProject)}`,
    );
    expect(
      "project_open_recent loads the fixture project",
      fileOps.loaded?.format === "framecode-project" &&
        fileOps.loaded?.path === fixturePath &&
        fileOps.loaded?.source === fixtureSource,
      `loaded=${JSON.stringify(fileOps.loaded)}`,
    );
    expect(
      "project_save writes through the session's current path",
      fileOps.saved?.path === fixturePath,
      `saved=${JSON.stringify(fileOps.saved)}`,
    );
    let savedSourceOnDisk = null;
    try {
      savedSourceOnDisk = JSON.parse(readFileSync(fixturePath, "utf8")).source;
    } catch {
      // Reported as the failure below.
    }
    expect(
      "saved file holds the Save payload",
      savedSourceOnDisk === savedSource,
      `onDisk=${JSON.stringify(savedSourceOnDisk)}`,
    );
    expect(
      "Open Recent recorded the fixture in recents",
      fileOps.recentsBefore === 1,
      `recentsBefore=${JSON.stringify(fileOps.recentsBefore)}`,
    );
    expect(
      "removeRecent removed the fixture entry",
      fileOps.remaining === 0 && fileOps.recentsAfter === 0,
      `remaining=${JSON.stringify(fileOps.remaining)}, recentsAfter=${JSON.stringify(fileOps.recentsAfter)}`,
    );
  }

  // Stage 4: the capability token must actually arrive; without it no
  // asset URL can ever be built, so this is the first hard gate.
  expect(
    "asset token delivered by the Rust backend",
    typeof checks.assetTokenWait === "string" &&
      /^[0-9a-f]{64}$/.test(checks.assetTokenWait),
    `assetToken=${JSON.stringify(checks.assetTokenWait)}`,
  );

  // Stage 4 asset request matrix, driven in the real app over CDP.
  let assetMatrix = null;
  try {
    assetMatrix = JSON.parse(checks.assetMatrix ?? "null");
  } catch {
    // A missing/unparsable step log is reported as the failure below.
  }
  expect("asset matrix ran without errors", !!assetMatrix && !assetMatrix.error, `steps=${checks.assetMatrix}`);
  if (assetMatrix && !assetMatrix.error) {
    expect(
      "Open Recent scan authorized the fixture image",
      assetMatrix.scanOpen === true,
      `scanOpen=${JSON.stringify(assetMatrix.scanOpen)}`,
    );
    expect(
      "authorized asset serves HTTP 200 on the app origin",
      assetMatrix.authorized === 200,
      `authorized=${JSON.stringify(assetMatrix.authorized)}`,
    );
    expect(
      "forged token receives HTTP 403",
      assetMatrix.wrongToken === 403,
      `wrongToken=${JSON.stringify(assetMatrix.wrongToken)}`,
    );
    expect(
      "missing token receives HTTP 403",
      assetMatrix.noToken === 403,
      `noToken=${JSON.stringify(assetMatrix.noToken)}`,
    );
    expect(
      "missing path receives HTTP 400",
      assetMatrix.missingPath === 400,
      `missingPath=${JSON.stringify(assetMatrix.missingPath)}`,
    );
    expect(
      "relative path receives HTTP 400",
      assetMatrix.relative === 400,
      `relative=${JSON.stringify(assetMatrix.relative)}`,
    );
    expect(
      "POST receives HTTP 405",
      assetMatrix.post === 405,
      `post=${JSON.stringify(assetMatrix.post)}`,
    );
    expect(
      "unauthorized image path receives HTTP 403",
      assetMatrix.unauthorized === 403,
      `unauthorized=${JSON.stringify(assetMatrix.unauthorized)}`,
    );
  }

  // Stage 4 same-origin canvas proof: a tainted canvas would throw on
  // getImageData, so a decoded green pixel is the real evidence.
  let canvasPixel = null;
  try {
    canvasPixel = JSON.parse(checks.canvasPixel ?? "null");
  } catch {
    // Reported as the failure below.
  }
  expect(
    "authorized image draws untainted with the green source pixel",
    !!canvasPixel &&
      canvasPixel.g > 100 &&
      canvasPixel.g > canvasPixel.r + 40 &&
      canvasPixel.g > canvasPixel.b + 40,
    `canvasPixel=${checks.canvasPixel}`,
  );

  // Stage 4 recovery relink: with no recovery data there are no candidates
  // and no consent dialog, so the command path must answer empty.
  let relink = null;
  try {
    relink = JSON.parse(checks.relink ?? "null");
  } catch {
    // Reported as the failure below.
  }
  expect(
    "relink_recovery_assets answers empty without recovery data",
    !!relink && !relink.error && Array.isArray(relink.authorized) && relink.authorized.length === 0,
    `relink=${checks.relink}`,
  );

  // Stage 6 media pipeline: ranges, authorization order, media save, probe.
  let mediaRange = null;
  try {
    mediaRange = JSON.parse(checks.mediaRange ?? "null");
  } catch {
    // Reported as the failure below.
  }
  expect(
    "media range probe ran without errors",
    !!mediaRange && !mediaRange.error,
    `steps=${checks.mediaRange}`,
  );
  if (mediaRange && !mediaRange.error) {
    expect(
      "a Range request on unauthorized media still receives HTTP 403",
      mediaRange.beforeOpen === 403,
      `beforeOpen=${JSON.stringify(mediaRange.beforeOpen)}`,
    );
    expect(
      "the media project scan authorized the video clip",
      mediaRange.scanOpen === true,
      `scanOpen=${JSON.stringify(mediaRange.scanOpen)}`,
    );
    expect(
      "a byte range returns 206 with Content-Range, Accept-Ranges and exact bytes",
      mediaRange.partial?.status === 206 &&
        mediaRange.partial.length === 1024 &&
        mediaRange.partial.contentRange === "bytes 0-1023/4096" &&
        mediaRange.partial.acceptRanges === "bytes" &&
        mediaRange.partial.contentLength === "1024",
      `partial=${JSON.stringify(mediaRange.partial)}`,
    );
    expect(
      "HEAD mirrors the range headers without a body",
      mediaRange.head?.status === 206 &&
        mediaRange.head.length === 0 &&
        mediaRange.head.contentLength === "1024",
      `head=${JSON.stringify(mediaRange.head)}`,
    );
    expect(
      "a suffix range resolves from the end of the file",
      mediaRange.suffix?.status === 206 &&
        mediaRange.suffix.length === 16 &&
        mediaRange.suffix.contentRange === "bytes 4080-4095/4096",
      `suffix=${JSON.stringify(mediaRange.suffix)}`,
    );
    expect(
      "an unsatisfiable range receives 416",
      mediaRange.unsatisfiable === 416,
      `unsatisfiable=${JSON.stringify(mediaRange.unsatisfiable)}`,
    );
    expect(
      "a range-less request still serves the whole file",
      mediaRange.full === 200,
      `full=${JSON.stringify(mediaRange.full)}`,
    );
    expect(
      "a media project saves without dropping its video clip",
      mediaRange.savedPath === mediaFixturePath,
      `savedPath=${JSON.stringify(mediaRange.savedPath)}`,
    );
    expect(
      "probing non-media bytes fails with a structured error",
      typeof mediaRange.probe === "string" &&
        /Unreadable media container|Could not read the media duration/.test(
          mediaRange.probe,
        ),
      `probe=${JSON.stringify(mediaRange.probe)}`,
    );
  }
  let savedMediaProject = null;
  try {
    savedMediaProject = JSON.parse(readFileSync(mediaFixturePath, "utf8"));
  } catch {
    // Reported as the failure below.
  }
  expect(
    "the saved media project keeps the video clip in source and lastValid",
    savedMediaProject?.source === mediaFixtureSource &&
      savedMediaProject?.lastValid === mediaFixtureSource,
    `onDisk=${JSON.stringify(savedMediaProject)}`,
  );

  // Stage 6 decode proof: the real UI opened the decodable fixture through
  // Recents, the probe read its real container, the C4 provenance is shown,
  // and the transport painted the red then blue source frames.
  let mediaDecode = null;
  try {
    mediaDecode = JSON.parse(checks.mediaDecode ?? "null");
  } catch {
    // Reported as the failure below.
  }
  expect(
    "the decodable media project opened through the real Recents flow",
    !!mediaDecode &&
      !mediaDecode.error &&
      mediaDecode.stage === "editor" &&
      mediaDecode.provenance === "Media · requires Framecode 0.4+",
    `steps=${checks.mediaDecode}`,
  );
  expect(
    "probing the real MP4 reports its duration and display size",
    !!mediaDecode &&
      Math.abs((mediaDecode.probe?.duration ?? 0) - 2) < 0.15 &&
      mediaDecode.probe?.width === 160 &&
      mediaDecode.probe?.height === 90,
    `probe=${JSON.stringify(mediaDecode?.probe)}`,
  );
  expect(
    "seeking to 1.5 s paints the blue source frame",
    !!mediaDecode &&
      mediaDecode.blue?.b > 120 &&
      mediaDecode.blue.b > mediaDecode.blue.r + 80 &&
      mediaDecode.blue.b > mediaDecode.blue.g + 80,
    `blue=${JSON.stringify(mediaDecode?.blue)}`,
  );
  expect(
    "seeking back to 0.5 s paints the red source frame",
    !!mediaDecode &&
      mediaDecode.red?.r > 120 &&
      mediaDecode.red.r > mediaDecode.red.g + 80 &&
      mediaDecode.red.r > mediaDecode.red.b + 80,
    `red=${JSON.stringify(mediaDecode?.red)}`,
  );

  // Stage 6 memory bound: `bytes=0-` on a 512 MiB file is a bounded prefix,
  // and the app process does not grow by the file size.
  let mediaMemory = null;
  try {
    mediaMemory = JSON.parse(checks.mediaMemory ?? "null");
  } catch {
    // Reported as the failure below.
  }
  const memory = checks.memory ?? {};
  console.log(
    `512 MiB range response: status=${mediaMemory?.status} bytes=${mediaMemory?.length} ` +
      `contentRange=${mediaMemory?.contentRange} app growth=` +
      `${memory.growth === null || memory.growth === undefined ? "unknown" : (memory.growth / (1024 * 1024)).toFixed(1) + " MiB"}`,
  );
  expect(
    "an open-ended range on a 512 MiB clip returns a bounded 8 MiB 206 prefix",
    !!mediaMemory &&
      !mediaMemory.error &&
      mediaMemory.status === 206 &&
      mediaMemory.length === 8 * 1024 * 1024 &&
      mediaMemory.contentRange === "bytes 0-8388607/536870912" &&
      mediaMemory.contentLength === "8388608" &&
      mediaMemory.acceptRanges === "bytes",
    `mediaMemory=${checks.mediaMemory}`,
  );
  expect(
    "serving that range does not grow the app process by the file size",
    typeof memory.growth === "number" &&
      memory.growth < 192 * 1024 * 1024,
    `memory=${JSON.stringify(memory)}`,
  );

  // Stage 5 window lifecycle: every command answered, the bogus stage was
  // rejected with the Electron validation message.
  let lifecycleOps = null;
  try {
    lifecycleOps = JSON.parse(checks.lifecycleOps ?? "null");
  } catch {
    // A missing/unparsable step log is reported as the failure below.
  }
  expect(
    "window lifecycle commands ran and validated",
    !!lifecycleOps &&
      !lifecycleOps.error &&
      lifecycleOps.dirty === "ok" &&
      lifecycleOps.stage === "ok" &&
      lifecycleOps.badStage === "Invalid stage." &&
      lifecycleOps.codePanel === "ok" &&
      lifecycleOps.templates === "ok" &&
      lifecycleOps.reset === "ok",
    `steps=${checks.lifecycleOps}`,
  );

  // Stage 5 close handshake: the dirty refusal first, then the clean
  // attestation that was allowed through.
  let closeHandshake = null;
  try {
    closeHandshake = JSON.parse(checks.closeHandshake ?? "null");
  } catch {
    // Reported as the failure below.
  }
  expect(
    "dirty finishClose refused with the Electron error",
    !!closeHandshake &&
      closeHandshake.refusal === "Newer unsaved changes remain." &&
      closeHandshake.close === "sent",
    `steps=${checks.closeHandshake}`,
  );

  // Stage 5 end to end: the clean attestation really ends the process
  // (the window closed through the Rust handshake, so the app exits).
  const appExit = await Promise.race([
    new Promise((resolve) => app.once("exit", (code) => resolve({ code }))),
    sleep(15000).then(() => null),
  ]);
  expect(
    "clean close ends the app process",
    !!appExit && appExit.code === 0,
    `exit=${JSON.stringify(appExit)}`,
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
  // The smoke fixtures are only scaffolding.
  for (const file of [
    fixturePath,
    testImgPath,
    unauthorizedImgPath,
    assetFixturePath,
    testVideoPath,
    mediaFixturePath,
    decodeFixturePath,
    largeVideoPath,
    largeFixturePath,
  ]) {
    try {
      unlinkSync(file);
    } catch {
      // Nothing to clean up when the step never happened.
    }
  }
  process.exit(exitCode);
}
