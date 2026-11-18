// Stage 5 of the Tauri migration: the truthful desktop adapter for the
// existing frontend. The retired Electron preload (desktop/preload.cjs)
// used to install window.framecodeDesktop; this module installs the same
// contract only inside the Tauri webview (window.__TAURI__), so the editor
// boots without changing the renderer contract at all.
//
// Truthfulness policy:
// - Methods already implemented by the Tauri shell are bridged for real:
//   appInfo -> the desktop_info Rust command; clipboard -> the WebView's
//   navigator.clipboard; persistence (settings, recents, recovery) ->
//   their Rust commands since Stage 2; the file operations (Open dialog,
//   Open Recent, New, Save, Save As) -> their Rust commands since Stage 3;
//   since Stage 4 image import and recovery relinking -> the
//   image_import_dialog / relink_recovery_assets Rust commands (the
//   renderer never authorizes anything itself); and since Stage 5 the
//   window lifecycle (confirmUnsaved, setDirty, setStage, setCodePanel,
//   finishClose, setTemplates) -> their window_lifecycle Rust commands,
//   which drive the native title bar, menus, and close handshake.
// - onCommand delivers the native menu commands the Rust shell emits as
//   `desktop:command` events (the same channel Electron's main process
//   used), through one shared subscription fanned out to every listener.
// - editClipboard runs the web-native editing commands against the focused
//   element (the same behavior Electron's webContents cut/copy/paste had),
//   with a paste path that hands the actual clipboard text to whatever the
//   user has focused.
// - assetToken keeps the Electron preload's synchronous getter contract;
//   the value is the webview's capability token, delivered asynchronously
//   from the asset_token Rust command (the getter returns "" until it
//   arrives, which the renderer already tolerates). whenAssetTokenReady
//   is the readiness signal with a real retry path: while delivery keeps
//   failing it paces fresh asset_token re-invocations, so a later
//   success flushes queued images without restarting the app.
// - Anything whose backing feature is genuinely absent (no clipboard
//   object, no event channel, no document) rejects explicitly with a
//   message, never faking success.

import { encodeProject, decodeProject } from "../core/project-format.mjs";

const NOT_IMPLEMENTED = "is not implemented in the Tauri shell yet";

/// The event the Rust shell emits native menu commands on (the same name
/// Electron's main process sent them on).
const COMMAND_EVENT = "desktop:command";

export function createTauriDesktopBridge({
  invoke,
  clipboard,
  platform,
  tokenHolder,
  tokenRetryMs = 1000,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // The Tauri event channel (window.__TAURI__.event.listen). Without it
  // onCommand still returns a working unsubscribe, but no command can
  // ever arrive — truthful, like a menu bar that never fires.
  listen,
  // The document the editing commands run against. Node tests inject a
  // fake; the webview install passes the real one by default.
  document: doc = globalThis.document,
}) {
  if (typeof invoke !== "function")
    throw new TypeError("createTauriDesktopBridge requires an invoke function");

  // Paced retry state for the capability token. One attempt is one real
  // `asset_token` invocation through the holder's refresh; concurrent
  // awaiters share the attempt in flight, and attempts are spaced at
  // least tokenRetryMs apart so a permanently failing delivery can never
  // spam the IPC channel from the render loop's re-arms — while a later
  // successful retry still flushes every queued image without any user
  // action.
  let lastAttemptAt = -Infinity;
  let attemptInFlight = null;
  const currentToken = () => tokenHolder?.current ?? "";
  const attemptRefresh = async () => {
    lastAttemptAt = Date.now();
    const refresh = tokenHolder?.refresh;
    if (typeof refresh === "function") await refresh();
    return currentToken();
  };

  const unsupported = (method) =>
    () => Promise.reject(new Error(`${method} ${NOT_IMPLEMENTED}`));

  // Native menu commands (the `desktop:command` channel) fan out through
  // one shared Tauri event subscription no matter how many listeners are
  // registered — a duplicate subscription per listener would deliver each
  // command multiple times. The subscription starts lazily on the first
  // listener and is torn down when the last one leaves, so an app that
  // unsubscribes everything really stops the IPC traffic.
  const commandListeners = new Set();
  // The live unlisten function once the subscription resolved; null while
  // none exists. A listener that unsubscribes before the subscription
  // resolves is handled by the resolution callback (which sees the empty
  // set and immediately tears the channel back down).
  let commandUnlisten = null;
  // True between starting the subscription and its promise resolving, so
  // concurrent onCommand calls share one attempt instead of racing.
  let commandSubscribing = false;

  const deliverCommand = (event) => {
    const command = event?.payload;
    if (typeof command !== "string") return;
    // Copy so a listener that (un)subscribes inside its own callback never
    // distorts the iteration.
    for (const listener of [...commandListeners]) {
      try {
        listener(command);
      } catch {
        // One broken listener never starves the others (the renderer's
        // own command handler is async and rejects into toasts).
      }
    }
  };

  const maybeTearDownSubscription = () => {
    if (commandListeners.size > 0 || commandSubscribing) return;
    const unlistenFn = commandUnlisten;
    if (!unlistenFn) return;
    commandUnlisten = null;
    try {
      unlistenFn();
    } catch {
      // An already-dead channel needs no second teardown.
    }
  };

  const ensureCommandSubscription = () => {
    if (commandListeners.size === 0) return;
    if (commandUnlisten || commandSubscribing) return;
    if (typeof listen !== "function") return;
    commandSubscribing = true;
    Promise.resolve()
      .then(() => listen(COMMAND_EVENT, deliverCommand))
      .then((unlistenFn) => {
        commandSubscribing = false;
        if (commandListeners.size === 0) {
          // Every listener unsubscribed while subscribing; the channel
          // never had consumers, so it ends immediately.
          try {
            unlistenFn();
          } catch {
            // Best effort teardown.
          }
          return;
        }
        commandUnlisten = unlistenFn;
      })
      .catch(() => {
        commandSubscribing = false;
        // A failed subscription stays failed; the next onCommand call
        // re-attempts it instead of leaving listeners silently deaf.
      });
  };

  return Object.freeze({
    // Bridged truthfully: same {name, version} shape as Electron's
    // "app:info" (the Rust command reads Tauri's package_info).
    appInfo: () => invoke("desktop_info"),

    // Mirrors Electron's process.platform value for the current OS.
    platform,

    // Stage 4: the webview's capability token for framecode asset URLs,
    // delivered asynchronously from the asset_token Rust command into the
    // token holder. The synchronous getter contract is unchanged from
    // Electron: it reads whatever the holder currently holds, starting at
    // "" (the renderer already tolerates an empty token).
    get assetToken() {
      return tokenHolder?.current ?? "";
    },

    // The readiness signal for the asynchronous delivery above, with the
    // real retry path: while the token is empty, each call re-invokes
    // `asset_token` through the holder's refresh — paced tokenRetryMs
    // apart and sharing the attempt in flight — and resolves with what
    // the attempt delivered ("" while delivery keeps failing). A caller
    // that re-awaits after a failure therefore drives the next attempt,
    // so a later successful retry flushes queued images without any
    // user action and without restarting the app. The synchronous
    // assetToken getter contract is untouched; Electron's preload has no
    // such method (its token is already present at boot), so the
    // renderer treats this as optional.
    whenAssetTokenReady: () => {
      const current = currentToken();
      if (current) return Promise.resolve(current);
      if (typeof tokenHolder?.refresh !== "function")
        return Promise.resolve(current);
      if (!attemptInFlight) {
        const wait = Math.max(0, tokenRetryMs - (Date.now() - lastAttemptAt));
        attemptInFlight = delay(wait)
          .then(attemptRefresh)
          .finally(() => {
            attemptInFlight = null;
          });
      }
      return attemptInFlight;
    },

    // Real clipboard access through the WebView2/Chromium API. Failures
    // (denied permission, empty clipboard image, etc.) surface as genuine
    // errors; no execCommand fallback faking success.
    readClipboard: () => {
      if (!clipboard?.readText)
        return Promise.reject(new Error(`readClipboard ${NOT_IMPLEMENTED}`));
      return clipboard.readText();
    },
    writeClipboard: (text) => {
      if (!clipboard?.writeText)
        return Promise.reject(new Error(`writeClipboard ${NOT_IMPLEMENTED}`));
      return clipboard.writeText(text);
    },

    // Stage 5: the real native menu channel. Commands the Rust shell's
    // menus emit (File/Edit/View/Templates/Help — the same strings the
    // Electron main process sent) arrive here through one shared
    // `desktop:command` subscription; the returned function synchronously
    // unsubscribes, and the last unsubscribe tears the subscription down.
    onCommand(listener) {
      if (typeof listener !== "function")
        throw new TypeError("onCommand requires a listener function");
      commandListeners.add(listener);
      ensureCommandSubscription();
      return () => {
        // A Set dedupes, so double registration and double unregistration
        // of the same listener stay one subscription and one delivery.
        commandListeners.delete(listener);
        maybeTearDownSubscription();
      };
    },

    // File operations bridged for real since Stage 3 (the Rust commands
    // mirror the Electron `project:open`, `project:open-recent`,
    // `project:save`, and `project:new` handlers, including the native
    // Open/Save dialogs and the recents recording):
    openProject: () => invoke("project_open_dialog"),
    openRecentProject: (recentPath) =>
      invoke("project_open_recent", { path: recentPath }),
    newProject: () => invoke("project_new"),

    // Save validates through the shared core format first, exactly like
    // the Electron main process's encodeProject before any dialog opens;
    // an invalid draft rejects without reaching Rust.
    saveProject: (project, saveAs = false) => {
      let valid;
      try {
        valid = decodeProject(encodeProject(project));
      } catch (error) {
        return Promise.reject(error);
      }
      return invoke("project_save", { project: valid, saveAs: !!saveAs });
    },

    // Persistence bridged for real since Stage 2: each call invokes the
    // corresponding Rust command (src-tauri/src/lib.rs). The renderer's
    // window.framecodeDesktop contract is unchanged from Electron.
    listRecents: () => invoke("recents_list"),
    removeRecent: (recentPath) => invoke("recents_remove", { path: recentPath }),
    getSettings: () => invoke("settings_get"),
    setSetting: (key, value) => invoke("settings_set", { key, value }),
    resetSettings: () => invoke("settings_reset"),

    // Recovery validation keeps its home in the JavaScript engine: the
    // canonical encoder compiles `lastValid`, exactly like the Electron
    // main process did before persisting a recovery copy.
    writeRecovery: (project) => {
      let valid;
      try {
        valid = decodeProject(encodeProject(project));
      } catch (error) {
        return Promise.reject(error);
      }
      return invoke("recovery_write", { project: valid });
    },
    // Reading re-validates the same way, so a recovery file whose draft no
    // longer compiles is reported as unusable, never restored broken.
    readRecovery: async () => {
      const recovery = await invoke("recovery_read");
      if (recovery === null || recovery === undefined) return null;
      return decodeProject(encodeProject(recovery));
    },
    clearRecovery: () => invoke("recovery_clear"),

    // Stage 4 asset features, bridged for real: image import runs the
    // Import image dialog and authorizes in Rust (never in the renderer);
    // recovery relinking re-reads the backend's own recovery file and
    // asks the native consent dialog before granting anything.
    importImage: () => invoke("image_import_dialog"),
    relinkRecoveryAssets: () => invoke("relink_recovery_assets"),

    // Stage 5 window lifecycle, bridged for real to the window_lifecycle
    // Rust commands (src-tauri/src/window_lifecycle.rs), which mirror the
    // Electron main process: the dirty flag and stage drive the "● name —
    // Framecode" title and the stage-aware native menus; the code-panel
    // checkbox follows the editor state; the prompt shows the same Save /
    // Don't Save / Cancel box (Esc answers cancel); the close handshake
    // only lets the window close when the renderer attests a clean
    // document. Each call returns the promise the Rust command answers,
    // so a rejection surfaces as the real failure it is.
    confirmUnsaved: () => invoke("project_confirm_unsaved"),
    setDirty: (dirty, name) => invoke("project_dirty", { dirty, name }),
    setStage: (stage) => invoke("app_stage", { stage }),
    setCodePanel: (open) => invoke("app_code", { open }),
    finishClose: () => invoke("window_finish_close"),

    // Stage 5, Tauri-only (the Electron preload had no counterpart; the
    // engine stays JavaScript, so the renderer delivers the template
    // names the native Templates menu lists — the same names the engine
    // exports and the command handler resolves `template:<name>` from).
    setTemplates: (names) =>
      invoke("app_templates", {
        names: Array.isArray(names) ? names.map(String) : [],
      }),

    // Stage 5 clipboard editing, mirroring the Electron
    // `editor:clipboard` handler (`window.webContents[action]()`): the
    // web-native editing commands run against the focused element.
    editClipboard: async (action) => {
      if (!["cut", "copy", "paste"].includes(action))
        throw new Error("Unknown clipboard action.");
      if (!doc?.activeElement) throw new Error(`editClipboard ${NOT_IMPLEMENTED}`);
      if (action !== "paste") {
        // Cut/copy run the standard editing command; the focused
        // element's own handlers (CodeMirror, inputs) participate the
        // same way they did under Electron. A refusal is a real error.
        if (!doc.execCommand(action))
          throw new Error(`The ${action} command was refused.`);
        return;
      }
      // execCommand("paste") is blocked in webviews, so paste carries the
      // real clipboard text to the focused element: first as a genuine
      // paste event (CodeMirror and contentEditable handle those), then,
      // if nothing consumed it, as a direct edit of the focused field.
      const text = await (clipboard?.readText
        ? clipboard.readText()
        : Promise.reject(new Error("readClipboard unavailable")));
      const target = doc.activeElement;
      let event;
      try {
        const data = new DataTransfer();
        data.setData("text/plain", text);
        event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        });
        // Some engines ignore the clipboardData init option; patch it so
        // the event still carries the text.
        if (!event.clipboardData) {
          Object.defineProperty(event, "clipboardData", { value: data });
        }
      } catch {
        throw new Error(`editClipboard ${NOT_IMPLEMENTED}`);
      }
      target.dispatchEvent(event);
      if (event.defaultPrevented) return;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const element = target;
        element.setRangeText(
          text,
          element.selectionStart ?? element.value.length,
          element.selectionEnd ?? element.value.length,
          "end",
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (target.isContentEditable) {
        if (!doc.execCommand("insertText", false, text))
          throw new Error("The paste command was refused.");
      } else {
        throw new Error("Nothing focused can accept a paste.");
      }
    },
  });
}

// The capability token holder shared by the install block and the
// integration tests, so the shipped retry path is exactly what tests
// exercise. `refresh` is the real retry: it re-invokes the asset_token
// Rust command and installs a delivered token; a failure keeps the
// empty current value and the next paced readiness await retries.
export function createTokenHolder(invoke) {
  const tokenHolder = { current: "" };
  tokenHolder.refresh = async () => {
    try {
      const token = await invoke("asset_token");
      if (typeof token === "string" && token) tokenHolder.current = token;
    } catch {
      // A failed delivery keeps the empty token; the next readiness
      // await re-invokes. Nothing here pretends delivery succeeded.
    }
    return tokenHolder.current;
  };
  return tokenHolder;
}

// Derive the process.platform-style value the renderer can expect under
// Electron ("win32", "darwin", "linux"). Windows is the supported release
// target; the other branches exist so the value never misreports elsewhere.
export function platformFromNavigator(nav = globalThis.navigator) {
  const ua = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`.toLowerCase();
  if (ua.includes("win")) return "win32";
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

// Install side effect: only inside the Tauri webview, never under Electron
// (which exposes __TAURI__ nowhere and already has its own preload bridge).
if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  window.__TAURI__ &&
  !window.framecodeDesktop
) {
  const tauri = window.__TAURI__;
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (typeof invoke === "function") {
    // Capture uncaught errors during renderer boot; the smoke test asserts
    // this stays empty, so a broken boot is reported as its true cause.
    const startupErrors = [];
    window.addEventListener("error", (event) => {
      startupErrors.push("error: " + (event.message ?? String(event.error)));
    });
    window.addEventListener("unhandledrejection", (event) => {
      startupErrors.push(
        "unhandledrejection: " + (event.reason?.message ?? String(event.reason)),
      );
    });
    window.__framecodeStartupErrors = startupErrors;
    // The capability token holder carries the real retry path: refresh
    // re-invokes asset_token, and whenAssetTokenReady paces those
    // re-invocations (see the bridge factory). The synchronous getter
    // keeps its contract and reads "" until a token is delivered; a
    // delivery failure leaves it empty, and the renderer's queued-image
    // re-arms drive the retries until one succeeds.
    const tokenHolder = createTokenHolder(invoke);
    window.framecodeDesktop = Object.freeze(
      createTauriDesktopBridge({
        invoke,
        clipboard: window.navigator?.clipboard ?? null,
        platform: platformFromNavigator(window.navigator),
        tokenHolder,
        // The native menu command channel (capability core:default
        // covers event listening).
        listen: tauri?.event?.listen,
        document: window.document,
      }),
    );
  } else {
    // Without IPC the app would crash further down boot ("Launch Framecode
    // from the desktop application."); record it exactly once so automated
    // checks can see the true cause instead of a missing-global crash.
    document.documentElement.dataset.tauriBridge =
      "error:no-invoke-function";
  }
}
