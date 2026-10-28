const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  net,
  clipboard,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ENTRY = "framecode://app/index.html";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "framecode",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function installProtocol() {
  const files = new Map([
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/app.css", "app.css"],
  ]);
  protocol.handle("framecode", (request) => {
    const url = new URL(request.url),
      file = files.get(url.pathname);
    if (
      url.host !== "app" ||
      !file ||
      !["GET", "HEAD"].includes(request.method)
    )
      return new Response("Not found", { status: 404 });
    return net.fetch(
      pathToFileURL(path.join(__dirname, "../build/renderer", file)).toString(),
    );
  });
}
async function createDesktopWindow({
  show = true,
  dataDirectory = app.getPath("userData"),
  dialogs = dialog,
  systemClipboard = clipboard,
} = {}) {
  const { readProject, writeProject, encodeProject, RecoveryFile } =
    await import("./project-files.mjs");
  const recovery = new RecoveryFile(dataDirectory);
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1080,
    minHeight: 740,
    show: false,
    title: "Framecode",
    backgroundColor: "#141617",
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  let currentPath = null,
    dirty = false,
    allowClose = false,
    closing = false,
    busy = false;
  const handlers = [];
  const metadata = () => ({
    path: currentPath,
    name: currentPath ? path.basename(currentPath) : "Untitled.framecode.json",
  });
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== ENTRY
      )
        throw new Error("Untrusted desktop request.");
      return fn(...args);
    });
    handlers.push(channel);
  }
  async function exclusive(fn) {
    if (busy) throw new Error("A file operation is already in progress.");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  handle("project:open", () =>
    exclusive(async () => {
      const choice = await dialogs.showOpenDialog(window, {
        title: "Open Framecode project",
        filters: [{ name: "Framecode project", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (choice.canceled || !choice.filePaths?.[0]) return null;
      const project = await readProject(choice.filePaths[0]);
      currentPath = choice.filePaths[0];
      return { ...metadata(), project };
    }),
  );
  handle("project:save", (project, saveAs) =>
    exclusive(async () => {
      encodeProject(project);
      let destination = currentPath;
      if (saveAs || !destination) {
        const choice = await dialogs.showSaveDialog(window, {
          title: "Save Framecode project",
          defaultPath: destination || "Untitled.framecode.json",
          filters: [{ name: "Framecode project", extensions: ["json"] }],
          properties: ["showOverwriteConfirmation"],
        });
        if (choice.canceled || !choice.filePath) return null;
        destination = choice.filePath;
        if (!destination.toLowerCase().endsWith(".json"))
          destination += ".framecode.json";
      }
      await writeProject(destination, project);
      currentPath = destination;
      return metadata();
    }),
  );
  handle("project:new", () => {
    currentPath = null;
    return metadata();
  });
  handle("project:dirty", (value, name) => {
    if (
      typeof value !== "boolean" ||
      typeof name !== "string" ||
      name.length > 50000
    )
      throw new Error("Invalid document state.");
    dirty = value;
    window.setTitle((dirty ? "● " : "") + name.slice(0, 100) + " — Framecode");
    window.setDocumentEdited(dirty);
  });
  handle("project:confirm-unsaved", async () => {
    const result = await dialogs.showMessageBox(window, {
      type: "question",
      title: "Unsaved changes",
      message: "Save your changes before continuing?",
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return ["save", "discard", "cancel"][result.response] || "cancel";
  });
  handle("recovery:read", () => recovery.read());
  handle("recovery:write", (project) => recovery.write(project));
  handle("recovery:clear", () => recovery.clear());
  handle("clipboard:read", () => systemClipboard.readText());
  handle("clipboard:write", (text) => {
    if (typeof text !== "string" || text.length > 1000000)
      throw new Error("Clipboard text is too large.");
    return systemClipboard.writeText(text);
  });
  handle("editor:clipboard", (action) => {
    if (!["cut", "copy", "paste"].includes(action))
      throw new Error("Unknown clipboard action.");
    window.webContents[action]();
  });
  handle("window:finish-close", () => {
    if (dirty) throw new Error("Newer unsaved changes remain.");
    allowClose = true;
    window.close();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== ENTRY) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("close", (event) => {
    if (allowClose) return;
    if (!dirty) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    window.webContents.send("desktop:command", "close");
    setTimeout(() => {
      closing = false;
    }, 500);
  });
  window.on("closed", () => {
    for (const channel of handlers) ipcMain.removeHandler(channel);
  });
  if (show) window.once("ready-to-show", () => window.show());
  await window.loadURL(ENTRY);
  return { window, recovery, metadata };
}
function installMenu(window) {
  const command = (name) => () =>
    window.webContents.send("desktop:command", name);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "New project",
            accelerator: "CmdOrCtrl+N",
            click: command("new"),
          },
          {
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: command("open"),
          },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: command("save") },
          {
            label: "Save As…",
            accelerator: "CmdOrCtrl+Shift+S",
            click: command("saveAs"),
          },
          { type: "separator" },
          { label: "Exit", click: () => window.close() },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: command("undo") },
          {
            label: "Redo",
            accelerator: "CmdOrCtrl+Shift+Z",
            click: command("redo"),
          },
          { type: "separator" },
          { label: "Cut", accelerator: "CmdOrCtrl+X", click: command("cut") },
          { label: "Copy", accelerator: "CmdOrCtrl+C", click: command("copy") },
          {
            label: "Paste",
            accelerator: "CmdOrCtrl+V",
            click: command("paste"),
          },
          {
            label: "Duplicate clip",
            accelerator: "CmdOrCtrl+D",
            click: command("duplicate"),
          },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Help",
        submenu: [
          { label: "Code guide", accelerator: "F1", click: command("guide") },
        ],
      },
    ]),
  );
}
async function start() {
  app.setName("Framecode");
  app.setAppUserModelId("dev.schwzz.framecode");
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  installProtocol();
  const { window } = await createDesktopWindow();
  installMenu(window);
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
}
module.exports = { createDesktopWindow, installProtocol, installMenu };
if (require.main === module)
  start().catch((error) => {
    dialog.showErrorBox("Framecode could not start", error.message);
    app.exit(1);
  });
