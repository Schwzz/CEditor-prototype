const { contextBridge, ipcRenderer } = require("electron");
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld(
  "framecodeDesktop",
  Object.freeze({
    platform: process.platform,
    openProject: () => invoke("project:open"),
    saveProject: (project, saveAs = false) =>
      invoke("project:save", project, saveAs),
    newProject: () => invoke("project:new"),
    confirmUnsaved: () => invoke("project:confirm-unsaved"),
    setDirty: (dirty, name) => invoke("project:dirty", dirty, name),
    readRecovery: () => invoke("recovery:read"),
    writeRecovery: (project) => invoke("recovery:write", project),
    clearRecovery: () => invoke("recovery:clear"),
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
