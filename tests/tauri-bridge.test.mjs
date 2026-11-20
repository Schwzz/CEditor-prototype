import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTauriDesktopBridge,
  createTokenHolder,
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

// The Tauri-only additions beyond the Electron preload surface:
// whenAssetTokenReady is the readiness signal for the asynchronous
// capability-token delivery, setTemplates delivers the template names
// for the native Templates menu (the engine stays JavaScript), and the
// Stage 6 media trio (importVideo/importAudio/probeMedia) is new
// functionality the Electron shell never had. The renderer treats them as
// part of the adapter contract.
const TAURI_ONLY_KEYS = [
  "whenAssetTokenReady",
  "setTemplates",
  "importVideo",
  "importAudio",
  "probeMedia",
];

// Stage 5: the window lifecycle joins the bridged surface — none of the
// Electron preload methods is a stub anymore. (Stage 2 persistence and
// Stage 3 file operations were bridged earlier.)

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

// Stage 4: the asset commands join the bridged surface.
const BRIDGED_ASSET_COMMANDS = [
  ["importImage", "image_import_dialog", undefined],
  ["relinkRecoveryAssets", "relink_recovery_assets", undefined],
];

const bridge = (invoke, tokenHolder) =>
  createTauriDesktopBridge({
    invoke:
      invoke ??
      (async (command, args) => ({ command, args })),
    clipboard: {
      readText: async () => "clip-read",
      writeText: async (text) => text,
    },
    platform: "win32",
    tokenHolder,
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
    (key) =>
      !PRELOAD_VALUE_KEYS.includes(key) && !TAURI_ONLY_KEYS.includes(key),
  );
  assert.deepEqual(extra, [], "only the documented Tauri-only method may exist");
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

test("stage 5 window lifecycle methods invoke the real Rust commands", async () => {
  const b = bridge();
  assert.deepEqual(await b.confirmUnsaved(), {
    command: "project_confirm_unsaved",
    args: undefined,
  });
  assert.deepEqual(await b.setDirty(true, "Demo"), {
    command: "project_dirty",
    args: { dirty: true, name: "Demo" },
  });
  assert.deepEqual(await b.setStage("editor"), {
    command: "app_stage",
    args: { stage: "editor" },
  });
  assert.deepEqual(await b.setCodePanel(true), {
    command: "app_code",
    args: { open: true },
  });
  assert.deepEqual(await b.finishClose(), {
    command: "window_finish_close",
    args: undefined,
  });
});

test("setTemplates delivers the renderer's template names to the native menu", async () => {
  const b = bridge();
  assert.deepEqual(await b.setTemplates(["Demo", "Grid"]), {
    command: "app_templates",
    args: { names: ["Demo", "Grid"] },
  });
  // Non-arrays degrade to an empty menu section instead of crashing the
  // Rust command; names are delivered as strings.
  assert.deepEqual(await b.setTemplates(null), {
    command: "app_templates",
    args: { names: [] },
  });
  assert.deepEqual(await b.setTemplates(["A", 3, null]), {
    command: "app_templates",
    args: { names: ["A", "3", "null"] },
  });
});

test("stage 6 media methods invoke the real Rust commands", async () => {
  const b = bridge();
  assert.deepEqual(await b.importVideo(), {
    command: "media_import_dialog",
    args: { kind: "video" },
  });
  assert.deepEqual(await b.importAudio(), {
    command: "media_import_dialog",
    args: { kind: "audio" },
  });
  const path = "C:\\clips\\Hero.mp4";
  assert.deepEqual(await b.probeMedia(path), {
    command: "probe_media",
    args: { path },
  });
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

const validProject = {
  format: "framecode-project",
  version: 1,
  source: "composition(\"Demo\").duration(5)",
  lastValid: "composition(\"Demo\").duration(5)",
};

test("file operations invoke the real Stage 3 Rust commands", async () => {
  const b = bridge();
  assert.deepEqual(await b.openProject(), {
    command: "project_open_dialog",
    args: undefined,
  });
  assert.deepEqual(await b.openRecentProject("C:\\a\\b.json"), {
    command: "project_open_recent",
    args: { path: "C:\\a\\b.json" },
  });
  assert.deepEqual(await b.newProject(), {
    command: "project_new",
    args: undefined,
  });
  assert.deepEqual(await b.saveProject(validProject, true), {
    command: "project_save",
    args: { project: validProject, saveAs: true },
  });
  // The Electron preload defaults saveAs to false.
  assert.deepEqual(await b.saveProject(validProject), {
    command: "project_save",
    args: { project: validProject, saveAs: false },
  });
});

test("saveProject validates through the shared core format before invoking", async () => {
  let calls = 0;
  const b = bridge(async (command, args) => {
    calls++;
    return { command, args };
  });
  // Electron's main process encodes the draft before opening the dialog;
  // the adapter must not hand the Rust command an unvalidated draft.
  const result = await b.saveProject(validProject, false);
  assert.equal(result.command, "project_save");
  assert.deepEqual(result.args.project, validProject);
  assert.equal(calls, 1);
});

test("saveProject rejects invalid drafts without invoking Rust", async () => {
  let calls = 0;
  const b = bridge(async () => {
    calls++;
    return {};
  });
  for (const invalid of [
    null,
    { ...validProject, version: 2 },
    { ...validProject, lastValid: "broken(" },
    { ...validProject, source: "x".repeat(50001) },
  ]) {
    await assert.rejects(b.saveProject(invalid, false));
  }
  assert.equal(calls, 0, "invalid drafts never reach the Rust command");
});

test("clearRecovery invokes the real Rust command", async () => {
  const b = bridge();
  assert.deepEqual(await b.clearRecovery(), { command: "recovery_clear", args: undefined });
});

test("stage 4 asset commands invoke the real Rust commands", async () => {
  const b = bridge();
  for (const [method, command] of BRIDGED_ASSET_COMMANDS) {
    assert.deepEqual(await b[method](), { command, args: undefined });
  }
});

test("assetToken reads the token holder and starts empty", async () => {
  // Without a holder the getter still answers "" (the sync contract).
  assert.equal(bridge().assetToken, "");
  const holder = { current: "" };
  const b = bridge(undefined, holder);
  assert.equal(b.assetToken, "");
  holder.current = "abc123";
  assert.equal(b.assetToken, "abc123", "the getter is live, not cached");
});

test("whenAssetTokenReady reports a delivered token immediately, without invoking", async () => {
  // Without a holder the signal still settles (with "") so callers can
  // always await it.
  assert.equal(await bridge().whenAssetTokenReady(), "");
  // A holder that already holds a token: immediate, and no attempt is
  // started.
  let refreshCalls = 0;
  const holder = {
    current: "abc123",
    refresh: async () => {
      refreshCalls++;
      return "abc123";
    },
  };
  const b = bridge(undefined, holder);
  assert.equal(await b.whenAssetTokenReady(), "abc123");
  assert.equal(refreshCalls, 0, "a delivered token needs no re-invocation");
  assert.equal(b.assetToken, "abc123", "the sync getter contract is intact");
});

test("whenAssetTokenReady falls back to the current holder value", async () => {
  // A holder without a refresh (older wiring or direct tests) still
  // settles deterministically with what the getter reads.
  const holder = { current: "tok" };
  const b = bridge(undefined, holder);
  assert.equal(await b.whenAssetTokenReady(), "tok");
});

test("whenAssetTokenReady re-invokes asset_token until delivery succeeds", async () => {
  // The real retry path: a failing invoke keeps the token empty, and
  // each subsequent await drives the next attempt until one delivers.
  let calls = 0;
  const holder = createTokenHolder(async (command) => {
    assert.equal(command, "asset_token");
    calls++;
    if (calls <= 2) throw new Error("backend not ready yet");
    return "tok789";
  });
  const b = createTauriDesktopBridge({
    invoke: async () => ({}),
    clipboard: null,
    platform: "win32",
    tokenHolder: holder,
    tokenRetryMs: 0,
    delay: () => Promise.resolve(),
  });
  assert.equal(await b.whenAssetTokenReady(), "", "first attempt fails");
  assert.equal(b.assetToken, "", "a failed attempt never fakes a token");
  assert.equal(await b.whenAssetTokenReady(), "", "second attempt fails");
  assert.equal(await b.whenAssetTokenReady(), "tok789", "third attempt delivers");
  assert.equal(calls, 3, "each await after a failure re-invoked asset_token");
  assert.equal(b.assetToken, "tok789");
  // After success the signal resolves immediately without invoking.
  assert.equal(await b.whenAssetTokenReady(), "tok789");
  assert.equal(calls, 3);
});

test("concurrent readiness awaiters share one in-flight attempt", async () => {
  let calls = 0;
  let release;
  const holder = createTokenHolder(async () => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve("tokShared");
    });
  });
  const b = createTauriDesktopBridge({
    invoke: async () => ({}),
    clipboard: null,
    platform: "win32",
    tokenHolder: holder,
    tokenRetryMs: 0,
    delay: () => Promise.resolve(),
  });
  const first = b.whenAssetTokenReady();
  const second = b.whenAssetTokenReady();
  // Let the paced attempt chain actually start the refresh before
  // releasing the fake backend.
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await first, "tokShared");
  assert.equal(await second, "tokShared");
  assert.equal(calls, 1, "the attempt in flight is shared, not duplicated");
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

test("onCommand throws on non-function listeners like the preload", () => {
  const b = bridge();
  assert.throws(() => b.onCommand("not a function"), TypeError);
});

test("onCommand without an event channel stays inert but valid", async () => {
  const b = bridge();
  let calls = 0;
  const unsubscribe = b.onCommand(() => calls++);
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(unsubscribe);
  assert.equal(calls, 0);
  // Unsubscribing twice stays harmless.
  assert.doesNotThrow(unsubscribe);
});

const commandBridge = (listen) =>
  createTauriDesktopBridge({
    invoke: async () => ({}),
    clipboard: null,
    platform: "win32",
    listen,
    document: null,
  });

const fakeListen = (impl) => {
  const state = { handlers: [], unlistens: 0 };
  state.listen = (name, handler) => {
    assert.equal(name, "desktop:command");
    return Promise.resolve(impl(state, handler));
  };
  return state;
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("onCommand delivers native menu commands to every listener", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  const seen = [];
  const stop = b.onCommand((name) => seen.push("first:" + name));
  b.onCommand((name) => seen.push("second:" + name));
  await settle();
  assert.equal(state.handlers.length, 1, "one shared subscription");
  state.handlers[0]({ payload: "save" });
  state.handlers[0]({ payload: "template:Demo" });
  assert.deepEqual(seen, ["first:save", "second:save", "first:template:Demo", "second:template:Demo"]);
  // The unsubscribe stops only that listener's deliveries.
  stop();
  state.handlers[0]({ payload: "open" });
  assert.deepEqual(
    seen,
    ["first:save", "second:save", "first:template:Demo", "second:template:Demo", "second:open"],
  );
});

test("the last onCommand unsubscribe tears the shared subscription down", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  const first = b.onCommand(() => {});
  const second = b.onCommand(() => {});
  await settle();
  assert.equal(state.unlistens, 0);
  first();
  await settle();
  assert.equal(state.unlistens, 0, "a live listener keeps the channel open");
  second();
  await settle();
  assert.equal(state.unlistens, 1, "the last unsubscribe unsubscribes in Rust");
  // Re-subscribing after a teardown starts a fresh subscription.
  const third = b.onCommand(() => {});
  await settle();
  assert.equal(state.handlers.length, 2, "a fresh channel subscription");
  third();
  await settle();
  assert.equal(state.unlistens, 2);
});

test("unsubscribing before the subscription resolves still tears it down", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  const unsubscribe = b.onCommand(() => {});
  unsubscribe(); // before the listen promise resolved
  await settle();
  assert.equal(state.unlistens, 1, "the channel never stays live with no consumers");
});

test("a duplicate registration of the same listener delivers once", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  let calls = 0;
  const listener = () => calls++;
  const stopA = b.onCommand(listener);
  const stopB = b.onCommand(listener);
  await settle();
  state.handlers[0]({ payload: "save" });
  assert.equal(calls, 1, "the set dedupes, so no double delivery");
  stopA();
  state.handlers[0]({ payload: "open" });
  assert.equal(calls, 1, "the first unsubscribe already removed the listener");
  stopB(); // harmless double unsubscribe
  await settle();
  assert.equal(state.unlistens, 1);
});

test("non-string payloads never reach the listeners", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  let calls = 0;
  b.onCommand(() => calls++);
  await settle();
  state.handlers[0]({ payload: 42 });
  state.handlers[0](null);
  state.handlers[0]({});
  assert.equal(calls, 0);
});

test("one broken listener never starves the others", async () => {
  const state = fakeListen((_state, handler) => {
    _state.handlers.push(handler);
    return () => _state.unlistens++;
  });
  const b = commandBridge(state.listen);
  const seen = [];
  b.onCommand(() => {
    throw new Error("listener bug");
  });
  b.onCommand((name) => seen.push(name));
  await settle();
  state.handlers[0]({ payload: "save" });
  assert.deepEqual(seen, ["save"]);
});

test("a failed subscription is retried by the next registration", async () => {
  let attempts = 0;
  const state = { handlers: [], unlistens: 0 };
  state.listen = (name, handler) => {
    assert.equal(name, "desktop:command");
    attempts++;
    if (attempts === 1) return Promise.reject(new Error("channel refused"));
    state.handlers.push(handler);
    return Promise.resolve(() => state.unlistens++);
  };
  const b = commandBridge(state.listen);
  const seen = [];
  b.onCommand((name) => seen.push(name));
  await settle();
  assert.equal(state.handlers.length, 0, "the first attempt failed");
  // The next registration drives a fresh subscription attempt.
  b.onCommand((name) => seen.push("retry:" + name));
  await settle();
  assert.equal(state.handlers.length, 1, "the retry subscribed");
  state.handlers[0]({ payload: "save" });
  assert.deepEqual(seen, ["save", "retry:save"]);
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

// Stage 5 editClipboard: a minimal fake document so the editing commands
// are testable in Node without a real DOM.
const domBridge = (doc, clipboard) =>
  createTauriDesktopBridge({
    invoke: async () => ({}),
    clipboard: clipboard ?? null,
    platform: "win32",
    document: doc,
  });

const trackingDoc = (execResult = true) => {
  const commands = [];
  return {
    commands,
    doc: {
      execCommand: (action, a, b) => {
        commands.push([action, a, b]);
        return typeof execResult === "function" ? execResult(action) : execResult;
      },
      activeElement: null,
    },
  };
};

test("editClipboard rejects unknown clipboard actions", async () => {
  const { doc } = trackingDoc();
  doc.activeElement = { tagName: "DIV" };
  const b = domBridge(doc);
  await assert.rejects(b.editClipboard("selectall"), /Unknown clipboard action/);
});

test("editClipboard needs a document to run the editing commands", async () => {
  const b = domBridge(null);
  await assert.rejects(b.editClipboard("cut"), /not implemented/);
});

test("editClipboard runs the web-native cut/copy commands", async () => {
  const { doc, commands } = trackingDoc();
  doc.activeElement = { tagName: "DIV" };
  const b = domBridge(doc);
  await b.editClipboard("cut");
  await b.editClipboard("copy");
  assert.deepEqual(commands, [["cut", undefined, undefined], ["copy", undefined, undefined]]);
});

test("editClipboard reports a refused cut/copy as a real error", async () => {
  const { doc, commands } = trackingDoc(() => false);
  doc.activeElement = { tagName: "DIV" };
  const b = domBridge(doc);
  await assert.rejects(b.editClipboard("copy"), /copy command was refused/);
  assert.equal(commands.length, 1, "the refusal is not retried or faked");
});

test("editClipboard paste needs a clipboard to read from", async () => {
  const { doc } = trackingDoc();
  doc.activeElement = { tagName: "DIV" };
  const b = domBridge(doc);
  await assert.rejects(b.editClipboard("paste"), /readClipboard/);
});
// The DOM ClipboardEvent/DataTransfer globals are absent in Node, so the
// paste tests inject stand-ins for exactly the API surface the bridge
// uses, restored afterwards.
const withFakeClipboardEvents = async (run) => {
  class FakeDataTransfer {
    constructor() {
      this.store = new Map();
    }
    setData(type, value) {
      this.store.set(type, value);
    }
  }
  class FakeClipboardEvent {
    constructor(type, init) {
      this.type = type;
      this.bubbles = init?.bubbles;
      this.cancelable = init?.cancelable;
      this.clipboardData = init?.clipboardData ?? null;
      this.defaultPrevented = false;
    }
  }
  const savedDataTransfer = globalThis.DataTransfer;
  const savedClipboardEvent = globalThis.ClipboardEvent;
  globalThis.DataTransfer = FakeDataTransfer;
  globalThis.ClipboardEvent = FakeClipboardEvent;
  try {
    await run();
  } finally {
    globalThis.DataTransfer = savedDataTransfer;
    globalThis.ClipboardEvent = savedClipboardEvent;
  }
};

test("editClipboard paste delivers a real paste event with the clipboard text", async () => {
  await withFakeClipboardEvents(async () => {
    const dispatched = [];
    const { doc, commands } = trackingDoc(() => {
      throw new Error("paste must not use execCommand first");
    });
    const target = {
      tagName: "DIV",
      isContentEditable: true,
      // The target consumes the event, like CodeMirror's paste handler.
      dispatchEvent: (event) => {
        dispatched.push(event);
        event.defaultPrevented = true;
      },
    };
    doc.activeElement = target;
    const b = domBridge(doc, { readText: async () => "pasted text" });
    await b.editClipboard("paste");
    assert.equal(dispatched.length, 1, "exactly one paste event");
    assert.equal(dispatched[0].type, "paste");
    assert.equal(dispatched[0].bubbles, true);
    assert.equal(
      dispatched[0].clipboardData?.store?.get("text/plain"),
      "pasted text",
      "the event carries the real clipboard text",
    );
    assert.equal(commands.length, 0, "a consumed paste needs no fallback");
  });
});

test("paste falls back to setRangeText when an input ignores the event", async () => {
  await withFakeClipboardEvents(async () => {
    const { doc, commands } = trackingDoc();
    const edits = [];
    const events = [];
    doc.activeElement = {
      tagName: "TEXTAREA",
      selectionStart: 2,
      selectionEnd: 5,
      value: "abcdef",
      setRangeText: (text, start, end, mode) =>
        edits.push([text, start, end, mode]),
      dispatchEvent: (event) => events.push(event),
    };
    const b = domBridge(doc, { readText: async () => "PASTE" });
    await b.editClipboard("paste");
    assert.deepEqual(edits, [["PASTE", 2, 5, "end"]], "the field was edited");
    assert.equal(events.length, 2, "the paste event and the follow-up input event");
    assert.equal(events[0].type, "paste");
    assert.equal(events[1].type, "input");
    assert.equal(events[1].bubbles, true);
    assert.equal(commands.length, 0, "no execCommand on plain fields");
  });
});

test("paste falls back to insertText on contentEditable", async () => {
  await withFakeClipboardEvents(async () => {
    const { doc, commands } = trackingDoc();
    doc.activeElement = {
      tagName: "DIV",
      isContentEditable: true,
      dispatchEvent: () => {}, // nobody handles the event
    };
    const b = domBridge(doc, { readText: async () => "PASTE" });
    await b.editClipboard("paste");
    assert.deepEqual(
      commands,
      [["insertText", false, "PASTE"]],
      "the contentEditable got the text via the editing command",
    );
  });
});

test("paste without a paste-capable target refuses truthfully", async () => {
  await withFakeClipboardEvents(async () => {
    const { doc, commands } = trackingDoc();
    doc.activeElement = {
      tagName: "BODY",
      isContentEditable: false,
      dispatchEvent: () => {},
    };
    const b = domBridge(doc, { readText: async () => "PASTE" });
    await assert.rejects(
      b.editClipboard("paste"),
      /Nothing focused can accept a paste/,
    );
    assert.equal(commands.length, 0);
  });
});

test("a paste consumed by the target's own handler runs no fallback", async () => {
  await withFakeClipboardEvents(async () => {
    const { doc, commands } = trackingDoc();
    // A CodeMirror-style target: its paste handler consumes the event
    // (preventDefault), so the bridge must not double-edit the field.
    doc.activeElement = {
      tagName: "DIV",
      isContentEditable: true,
      dispatchEvent: (event) => {
        event.defaultPrevented = true;
      },
    };
    const b = domBridge(doc, { readText: async () => "PASTE" });
    await b.editClipboard("paste");
    assert.equal(commands.length, 0);
  });
});
