const { contextBridge, ipcRenderer } = require("electron");
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld(
  "framecodeDesktop",
  Object.freeze({
    platform: process.platform,
    get assetToken() {
      try {
        return (
          new URLSearchParams(window.location.search).get("token") || ""
        );
      } catch {
        return "";
      }
    },
    openProject: () => invoke("project:open"),
    openRecentProject: (recentPath) => invoke("project:open-recent", recentPath),
    listRecents: () => invoke("recents:list"),
    removeRecent: (recentPath) => invoke("recents:remove", recentPath),
    saveProject: (project, saveAs = false) =>
      invoke("project:save", project, saveAs),
    newProject: () => invoke("project:new"),
    confirmUnsaved: () => invoke("project:confirm-unsaved"),
    setDirty: (dirty, name) => invoke("project:dirty", dirty, name),
    setStage: (stage) => invoke("app:stage", stage),
    setCodePanel: (open) => invoke("app:code", open),
    readRecovery: () => invoke("recovery:read"),
    writeRecovery: (project) => invoke("recovery:write", project),
    clearRecovery: () => invoke("recovery:clear"),
    relinkRecoveryAssets: () => invoke("recovery:relink"),
    importImage: () => invoke("image:import"),
    readClipboard: () => invoke("clipboard:read"),
    writeClipboard: (text) => invoke("clipboard:write", text),
    editClipboard: (action) => invoke("editor:clipboard", action),
    finishClose: () => invoke("window:finish-close"),
    onCommand(listener) {
      const receive = (_event, command) => listener(command);
      ipcRenderer.on("desktop:command", receive);
      return () => ipcRenderer.removeListener("desktop:command", receive);
    },
  }),
);
