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
  "saveProject",
  "newProject",
  "confirmUnsaved",
  "setDirty",
  "setStage",
  "setCodePanel",
  "relinkRecoveryAssets",
  "importImage",
  "editClipboard",
  "finishClose",
];

// Stage 2: persistence methods now invoke real Rust commands.
const BRIDGED = [
  "listRecents",
  "removeRecent",
  "getSettings",
  "setSetting",
  "resetSettings",
  "readRecovery",
  "writeRecovery",
  "clearRecovery",
];

const bridge = (invoke) =>
  createTauriDesktopBridge({
    invoke:
      invoke ??
      (async (command, args) => ({ command, args })),
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

test("every bridged persistence method really invokes, none are rejected", async () => {
  const commands = [];
  const b = bridge(async (command) => {
    commands.push(command);
    return null;
  });
  const valid = {
    format: "framecode-project",
    version: 1,
    source: "composition(\"Demo\").duration(5)",
    lastValid: "composition(\"Demo\").duration(5)",
  };
  for (const method of BRIDGED) {
    await b[method](method === "writeRecovery" ? valid : undefined);
  }
  assert.deepEqual(
    commands,
    [
      "recents_list",
      "recents_remove",
      "settings_get",
      "settings_set",
      "settings_reset",
      "recovery_read",
      "recovery_write",
      "recovery_clear",
    ],
    "persistence methods must call their Rust commands",
  );
});

test("adapter rejects unknown invoke wiring instead of pretending", async () => {
  assert.throws(
    () => createTauriDesktopBridge({ invoke: undefined }),
    TypeError,
  );
});

test("appInfo bridges to the desktop_info Rust command", async () => {
  const b = bridge();
  assert.deepEqual(await b.appInfo(), { command: "desktop_info", args: undefined });
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

test("settings methods invoke the real Rust commands", async () => {
  const b = bridge();
  assert.deepEqual(await b.getSettings(), { command: "settings_get", args: undefined });
  assert.deepEqual(await b.setSetting("maxRecents", 5), {
    command: "settings_set",
    args: { key: "maxRecents", value: 5 },
  });
  assert.deepEqual(await b.resetSettings(), { command: "settings_reset", args: undefined });
});

test("recents methods invoke the real Rust commands", async () => {
  const b = bridge();
  assert.deepEqual(await b.listRecents(), { command: "recents_list", args: undefined });
  assert.deepEqual(await b.removeRecent("C:\\a\\b.json"), {
    command: "recents_remove",
    args: { path: "C:\\a\\b.json" },
  });
});

test("clearRecovery invokes the real Rust command", async () => {
  const b = bridge();
  assert.deepEqual(await b.clearRecovery(), { command: "recovery_clear", args: undefined });
});

test("writeRecovery validates through the shared core format before invoking", async () => {
  let calls = 0;
  const b = bridge(async (command, args) => {
    calls++;
    return { command, args };
  });
  const valid = {
    format: "framecode-project",
    version: 1,
    source: "composition(\"Demo\").duration(5)",
    lastValid: "composition(\"Demo\").duration(5)",
  };
  const result = await b.writeRecovery(valid);
  assert.equal(result.command, "recovery_write");
  assert.deepEqual(result.args?.project, valid);
  assert.equal(calls, 1);
});

test("writeRecovery rejects invalid projects without invoking Rust", async () => {
  let calls = 0;
  const b = bridge(async () => {
    calls++;
    return {};
  });
  const valid = {
    format: "framecode-project",
    version: 1,
    source: "composition(\"Demo\").duration(5)",
    lastValid: "composition(\"Demo\").duration(5)",
  };
  for (const invalid of [
    null,
    { ...valid, version: 2 },
    { ...valid, lastValid: "broken(" },
    { ...valid, source: "x".repeat(50001) },
  ]) {
    await assert.rejects(b.writeRecovery(invalid));
  }
  assert.equal(calls, 0, "invalid projects never reach the Rust command");
});

test("readRecovery passes through absent recovery data", async () => {
  const b = bridge(async () => null);
  assert.equal(await b.readRecovery(), null);
});

test("readRecovery re-validates the stored project like the Electron read", async () => {
  const valid = {
    format: "framecode-project",
    version: 1,
    source: "composition(\"Demo\").duration(5)",
    lastValid: "composition(\"Demo\").duration(5)",
  };
  const good = bridge(async () => valid);
  assert.deepEqual(await good.readRecovery(), valid);
  // A stored draft that no longer compiles marks recovery unusable, exactly
  // like the Electron main-process read that compiled lastValid.
  const bad = bridge(async () => ({ ...valid, lastValid: "alert(1)" }));
  await assert.rejects(bad.readRecovery());
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
