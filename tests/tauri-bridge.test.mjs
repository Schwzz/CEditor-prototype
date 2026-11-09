import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTauriDesktopBridge,
  platformFromNavigator,
} from "../src/renderer/tauri-bridge.mjs";

// The full method surface the Electron preload exposes. The Tauri adapter
// must mirror it so the renderer never missing-calls under either shell.
// The value surface the Electron preload exposes. `platform` and the
// `assetToken` getter are properties; the rest are methods.
const PRELOAD_VALUE_KEYS = [
  "platform",
  "assetToken",
  "openProject",
  "openRecentProject",
  "listRecents",
  "removeRecent",
  "getSettings",
  "setSetting",
  "resetSettings",
  "appInfo",
  "saveProject",
  "newProject",
  "confirmUnsaved",
  "setDirty",
  "setStage",
  "setCodePanel",
  "readRecovery",
  "writeRecovery",
  "clearRecovery",
  "relinkRecoveryAssets",
  "importImage",
  "readClipboard",
  "writeClipboard",
  "editClipboard",
  "finishClose",
  "onCommand",
];

const NOT_YET = [
  "openProject",
  "openRecentProject",
  "listRecents",
  "removeRecent",
  "getSettings",
  "setSetting",
  "resetSettings",
  "saveProject",
  "newProject",
  "confirmUnsaved",
  "setDirty",
  "setStage",
  "setCodePanel",
  "readRecovery",
  "writeRecovery",
  "clearRecovery",
  "relinkRecoveryAssets",
  "importImage",
  "editClipboard",
  "finishClose",
];

const bridge = () =>
  createTauriDesktopBridge({
    invoke: async (command) => ({ command }),
    clipboard: {
      readText: async () => "clip-read",
      writeText: async (text) => text,
    },
    platform: "win32",
  });

test("adapter mirrors the entire Electron preload surface", () => {
  const b = bridge();
  for (const method of PRELOAD_VALUE_KEYS) {
    if (method === "assetToken" || method === "platform") continue;
    assert.equal(typeof b[method], "function", method);
  }
  assert.equal(b.platform, "win32");
  assert.equal(b.assetToken, "");
});

test("adapter exposes nothing beyond the preload surface", () => {
  const extra = Object.keys(bridge()).filter(
    (key) => !PRELOAD_VALUE_KEYS.includes(key),
  );
  assert.deepEqual(extra, []);
});

test("adapter rejects unknown invoke wiring instead of pretending", async () => {
  assert.throws(
    () => createTauriDesktopBridge({ invoke: undefined }),
    TypeError,
  );
});

test("appInfo bridges to the desktop_info Rust command", async () => {
  const b = bridge();
  assert.deepEqual(await b.appInfo(), { command: "desktop_info" });
});

test("unsupported methods reject truthfully instead of faking success", async () => {
  const b = bridge();
  for (const method of NOT_YET) {
    await assert.rejects(
      b[method](),
      (error) =>
        error instanceof Error &&
        error.message.startsWith(method) &&
        error.message.includes("not implemented in the Tauri shell yet"),
      `${method} must reject with an explicit not-implemented error`,
    );
  }
});

test("clipboard methods delegate to the real clipboard", async () => {
  const b = bridge();
  assert.equal(await b.readClipboard(), "clip-read");
  assert.equal(await b.writeClipboard("hello"), "hello");
});

test("clipboard methods reject when no clipboard is available", async () => {
  const b = createTauriDesktopBridge({
    invoke: async () => ({}),
    clipboard: null,
    platform: "win32",
  });
  await assert.rejects(b.readClipboard(), /not implemented/);
  await assert.rejects(b.writeClipboard("x"), /not implemented/);
});

test("onCommand delivers nothing yet and returns a working unsubscribe", async () => {
  const b = bridge();
  let calls = 0;
  const unsubscribe = b.onCommand(() => calls++);
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(unsubscribe);
  assert.equal(calls, 0);
  assert.throws(() => b.onCommand("not a function"), TypeError);
});

test("platformFromNavigator mirrors Electron process.platform values", () => {
  assert.equal(
    platformFromNavigator({ platform: "Win32", userAgent: "" }),
    "win32",
  );
  assert.equal(
    platformFromNavigator({ platform: "MacIntel", userAgent: "" }),
    "darwin",
  );
  assert.equal(platformFromNavigator({ platform: "", userAgent: "Linux x86_64" }), "linux");
  assert.equal(platformFromNavigator({ platform: "", userAgent: "" }), "unknown");
});
