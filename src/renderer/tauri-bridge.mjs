// Stage 4 of the Tauri migration: a truthful desktop adapter for the
// existing frontend. Electron's preload (desktop/preload.cjs) installs
// window.framecodeDesktop; this module installs an equivalent adapter only
// inside the Tauri webview (window.__TAURI__), so the editor boots without
// changing the Electron path at all.
//
// Truthfulness policy:
// - Methods already implemented by the Tauri shell are bridged for real:
//   appInfo -> the desktop_info Rust command; clipboard -> the WebView's
//   navigator.clipboard; persistence (settings, recents, recovery) ->
//   their Rust commands since Stage 2; the file operations (Open dialog,
//   Open Recent, New, Save, Save As) -> their Rust commands since Stage 3;
//   and since Stage 4 image import and recovery relinking -> the
//   image_import_dialog / relink_recovery_assets Rust commands (the
//   renderer never authorizes anything itself). Recovery write/read and
//   save validate through the shared JavaScript core format module
//   (src/core/project-format.mjs) first, so the composition engine still
//   performs the semantic validation the Electron main process did.
// - assetToken keeps the Electron preload's synchronous getter contract;
//   the value is the webview's capability token, delivered asynchronously
//   from the asset_token Rust command (the getter returns "" until it
//   arrives, which the renderer already tolerates).
// - Methods whose desktop features are not migrated yet (native menus,
//   window controls, the unsaved-change prompt, clipboard edit commands,
//   the close handshake) deliberately return rejected promises with
//   explicit messages. The renderer's boot paths already handle failures
//   defensively (safe defaults + honest toasts), so the truthful rejection
//   keeps the app alive while never pretending a file operation succeeded.
// - onCommand returns a working unsubscribe; nothing fires because the
//   Tauri shell has no native menus yet (a later stage).

import { encodeProject, decodeProject } from "../core/project-format.mjs";

const NOT_IMPLEMENTED = "is not implemented in the Tauri shell yet";

export function createTauriDesktopBridge({
  invoke,
  clipboard,
  platform,
  tokenHolder,
}) {
  if (typeof invoke !== "function")
    throw new TypeError("createTauriDesktopBridge requires an invoke function");

  const unsupported = (method) =>
    () => Promise.reject(new Error(`${method} ${NOT_IMPLEMENTED}`));

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

    // Native menu commands (File/Edit/etc.) do not exist in the Tauri
    // shell yet, so no command is ever delivered; the returned function
    // genuinely unsubscribes (a no-op, like an already-removed listener).
    onCommand(listener) {
      if (typeof listener !== "function")
        throw new TypeError("onCommand requires a listener function");
      return () => {};
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

    // Not migrated yet (later stages): reject explicitly instead of faking
    // success. The renderer treats these rejections exactly like any other
    // desktop-bridge failure.
    confirmUnsaved: unsupported("confirmUnsaved"),
    setDirty: unsupported("setDirty"),
    setStage: unsupported("setStage"),
    setCodePanel: unsupported("setCodePanel"),
    editClipboard: unsupported("editClipboard"),
    finishClose: unsupported("finishClose"),
  });
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
    // The capability token arrives asynchronously (the sync getter keeps
    // its contract and reads ""); a delivery failure leaves it empty, and
    // the renderer's existing evict/retry paths cover late arrival.
    const tokenHolder = { current: "" };
    invoke("asset_token")
      .then((token) => {
        if (typeof token === "string") tokenHolder.current = token;
      })
      .catch(() => {});
    window.framecodeDesktop = Object.freeze(
      createTauriDesktopBridge({
        invoke,
        clipboard: window.navigator?.clipboard ?? null,
        platform: platformFromNavigator(window.navigator),
        tokenHolder,
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
