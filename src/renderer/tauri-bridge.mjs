// Stage 2 of the Tauri migration: a truthful desktop adapter for the
// existing frontend. Electron's preload (desktop/preload.cjs) installs
// window.framecodeDesktop; this module installs an equivalent adapter only
// inside the Tauri webview (window.__TAURI__), so the editor boots without
// @conda changing the Electron path at all.
//
// Truthfulness policy:
// - Methods already implemented by the Tauri shell are bridged for real:
//   appInfo -> the desktop_info Rust command; clipboard -> the WebView's
//   navigator.clipboard; and since Stage 2 the persistence operations
//   (settings, recents, recovery) -> their Rust commands in src-tauri.
//   Recovery write/read validate through the shared JavaScript core format
//   module (src/core/project-format.mjs) first, so the composition engine
//   still performs the semantic validation the Electron main process did.
// - Methods whose desktop features are not migrated yet (dialogs, menus,
//   window controls, asset authorization) deliberately return rejected
//   promises with explicit messages. The renderer's boot paths already
//   handle failures defensively (safe defaults + honest toasts), so the
//   truthful rejection keeps the app alive while never pretending a file
//   operation succeeded.
// - onCommand returns a working unsubscribe; nothing fires because the
//   Tauri shell has no native menus yet (a later stage).

import { encodeProject, decodeProject } from "../core/project-format.mjs";

const NOT_IMPLEMENTED = "is not implemented in the Tauri shell yet";

export function createTauriDesktopBridge({
  invoke,
  clipboard,
  platform,
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

    // Electron derives this from the load URL's token query parameter for
    // framecode:// asset requests. The Tauri shell loads the same renderer
    // over its own origin and has no token to mint; the renderer already
    // tolerates an empty token (renderer.mjs uses `token ? ... : ""`).
    get assetToken() {
      return "";
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

    // Not migrated yet (later stages): reject explicitly instead of faking
    // success. The renderer treats these rejections exactly like any other
    // desktop-bridge failure.
    openProject: unsupported("openProject"),
    openRecentProject: unsupported("openRecentProject"),
    saveProject: unsupported("saveProject"),
    newProject: unsupported("newProject"),
    confirmUnsaved: unsupported("confirmUnsaved"),
    setDirty: unsupported("setDirty"),
    setStage: unsupported("setStage"),
    setCodePanel: unsupported("setCodePanel"),
    relinkRecoveryAssets: unsupported("relinkRecoveryAssets"),
    importImage: unsupported("importImage"),
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
    window.framecodeDesktop = Object.freeze(
      createTauriDesktopBridge({
        invoke,
        clipboard: window.navigator?.clipboard ?? null,
        platform: platformFromNavigator(window.navigator),
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
