// Stage 1 of the Tauri migration: prove the existing frontend can invoke a
// Rust command over Tauri's IPC. Dormant under Electron — window.__TAURI__
// only exists in the Tauri webview (app.withGlobalTauri). The outcome is
// recorded on a data attribute (no visible UI change) so automated checks
// can assert the frontend really received the Rust response; Electron
// behavior and the editor bundle are untouched.
if (window.__TAURI__) {
  const invoke = window.__TAURI__.core?.invoke ?? window.__TAURI__.invoke;
  if (typeof invoke === "function")
    invoke("desktop_info")
      .then((info) => {
        document.documentElement.dataset.tauri =
          "ok:" + (info?.name ?? "unknown");
      })
      .catch((error) => {
        document.documentElement.dataset.tauri =
          "error:" + (error?.message ?? String(error));
      });
}
