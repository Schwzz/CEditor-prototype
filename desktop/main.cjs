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
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const ENTRY = "framecode://app/index.html";
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "framecode",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// Module-level map from capability token to owning BrowserWindow
const windowTokenMap = new Map();

// Shared per-channel IPC registry: channel -> Map<WebContents, fn>.
// One global dispatcher per channel hands each request to the owning
// window's handler, so multiple windows never override each other and
// closing one window only removes its own entries.
const channelRegistry = new Map();

function ensureChannel(channel) {
  if (!channelRegistry.has(channel)) {
    channelRegistry.set(channel, new Map());
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender.isDestroyed()) return;
      const frame = event.senderFrame;
      if (!frame || frame.isDestroyed()) return;
      let frameUrl;
      try {
        frameUrl = new URL(frame.url);
      } catch {
        throw new Error("Untrusted desktop request.");
      }
      if (
        frameUrl.protocol !== "framecode:" ||
        frameUrl.host !== "app" ||
        frameUrl.pathname !== "/index.html"
      )
        throw new Error("Untrusted desktop request.");
      const fn = channelRegistry.get(channel)?.get(event.sender);
      if (!fn) throw new Error("Untrusted desktop request.");
      return fn(...args);
    });
  }
}

function normalizeAssetPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function installProtocol() {
  const files = new Map([
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/app.css", "app.css"],
  ]);
  protocol.handle("framecode", async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // Assets are served both on the legacy framecode://assets host and on the
    // same-origin path framecode://app/assets/ so renderer <canvas> pixel
    // reads do not taint the page origin (framecode://app).
    if (
      url.host === "assets" ||
      (url.host === "app" && url.pathname === "/assets/")
    ) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const rawPath = url.searchParams.get("path");
      if (
        typeof rawPath !== "string" ||
        !rawPath.trim() ||
        !path.isAbsolute(rawPath)
      )
        return new Response("Missing or invalid asset path", { status: 400 });
      const assetPath = path.resolve(rawPath);
      const norm =
        process.platform === "win32" ? assetPath.toLowerCase() : assetPath;

      // Bind the request to a single window via the capability token
      // carried in the URL. Without a valid token, cross-window access is
      // impossible because only the owning window's set is checked.
      const token = url.searchParams.get("token");
      const win = token ? windowTokenMap.get(token) : null;
      if (!win || win.isDestroyed())
        return new Response(null, { status: 403 });

      const authorized = win.__authorizedAssets;
      if (!authorized || !authorized.has(norm)) {
        // Symlink escape prevention: resolve symlinks and re-check the real
        // path against the same window's authorized set only.
        let realAuthorized = false;
        try {
          const real = await fs.realpath(assetPath);
          const realNorm =
            process.platform === "win32" ? real.toLowerCase() : real;
          if (realNorm !== norm && authorized.has(realNorm))
            realAuthorized = true;
        } catch {
          // realpath failed — file doesn't exist or permission denied
        }
        if (!realAuthorized) return new Response(null, { status: 403 });
      }

      try {
        return net.fetch(pathToFileURL(assetPath).toString());
      } catch (err) {
        return new Response(null, {
          status: err.code === "ENOENT" ? 404 : 403,
        });
      }
    }
    const file = files.get(url.pathname);
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

async function authorizeAsset(win, filePath) {
  const norm = normalizeAssetPath(filePath);
  if (!norm) return false;

  if (!win.__authorizedAssets) {
    win.__authorizedAssets = new Set();
  }

  if (win.__authorizedAssets.has(norm)) return true;
  try {
    const stats = await fs.stat(norm);
    if (!stats.isFile()) return false;
    if (stats.size > MAX_ASSET_BYTES) return false;
    const ext = path.extname(norm).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    win.__authorizedAssets.add(norm);
    return true;
  } catch {
    return false;
  }
}

async function createDesktopWindow({
  show = true,
  dataDirectory = app.getPath("userData"),
  dialogs = dialog,
  systemClipboard = clipboard,
} = {}) {
  const { readProject, writeProject, encodeProject, RecoveryFile } =
    await import("./project-files.mjs");
  const { compile } = await import("../src/core/engine.mjs");
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
  const assetToken = crypto.randomBytes(24).toString("hex");
  windowTokenMap.set(assetToken, window);
  // Principal webContents captured at creation; used as the registry key for
  // this window's IPC entries and kept after "closed" (fully destroyed i.e.
  // no property access needed at teardown time).
  const principalWC = window.webContents;
  window.__authorizedAssets = new Set();
  window.__currentPath = null;
  window.__dirty = false;
  window.__allowClose = false;
  window.__closing = false;
  window.__busy = false;

  async function scanForAssets(source) {
    if (typeof source !== "string" || !source.trim()) return;
    try {
      const model = compile(source);
      const paths = model.clips
        .filter((c) => c.type === "image" && c.source)
        .map((c) => c.source);
      await Promise.all(paths.map((p) => authorizeAsset(window, p)));
    } catch {
      // Compilation errors are not authorization failures
    }
  }

  function handle(channel, fn) {
    ensureChannel(channel);
    channelRegistry.get(channel).set(principalWC, fn);
  }

  async function exclusive(fn) {
    if (window.__busy) throw new Error("A file operation is already in progress.");
    window.__busy = true;
    try {
      return await fn();
    } finally {
      window.__busy = false;
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
      window.__currentPath = choice.filePaths[0];

      window.__authorizedAssets.clear();
      await scanForAssets(project.source);
      await scanForAssets(project.lastValid);

      return {
        name: path.basename(choice.filePaths[0]),
        path: choice.filePaths[0],
        project,
      };
    }),
  );
  handle("image:import", () =>
    exclusive(async () => {
      const choice = await dialogs.showOpenDialog(window, {
        title: "Import image",
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] },
        ],
        properties: ["openFile"],
      });
      if (choice.canceled || !choice.filePaths?.[0]) return null;
      const filePath = choice.filePaths[0];
      const ok = await authorizeAsset(window, filePath);
      if (!ok)
        throw new Error(
          "Could not import image: unsupported format, missing file, or exceeds size limit.",
        );
      return filePath;
    }),
  );
  handle("project:save", (project, saveAs) =>
    exclusive(async () => {
      encodeProject(project);
      let destination = window.__currentPath;
      if (saveAs || !destination) {
        const choice = await dialogs.showSaveDialog(window, {
          title: "Save Framecode project",
          defaultPath:
            window.__currentPath || "Untitled.framecode.json",
          filters: [{ name: "Framecode project", extensions: ["json"] }],
          properties: ["showOverwriteConfirmation"],
        });
        if (choice.canceled || !choice.filePath) return null;
        destination = choice.filePath;
        if (!destination.toLowerCase().endsWith(".json"))
          destination += ".framecode.json";
      }
      await writeProject(destination, project);
      window.__currentPath = destination;
      return {
        name: path.basename(destination),
        path: destination,
      };
    }),
  );
  handle("project:new", () => {
    window.__currentPath = null;
    window.__authorizedAssets.clear();
    return { name: "Untitled.framecode.json" };
  });
  handle("project:dirty", (value, name) => {
    if (
      typeof value !== "boolean" ||
      typeof name !== "string" ||
      name.length > 50000
    )
      throw new Error("Invalid document state.");
    window.__dirty = value;
    window.setTitle((value ? "\u25cf " : "") + name.slice(0, 100) + " — Framecode");
    window.setDocumentEdited(value);
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
  handle("recovery:read", async () => recovery.read());
  handle("recovery:write", (project) => recovery.write(project));
  handle("recovery:clear", () => recovery.clear());
  // Consent-gated relink: authorization for images referenced by a recovered
  // draft is minted only here, in the main process, and only after the user
  // affirmatively accepts a native dialog that lists the exact file paths.
  // The renderer never supplies the document; the recovery file main wrote
  // itself is re-read to compute the candidate list.
  handle("recovery:relink", () =>
    exclusive(async () => {
      const project = await recovery.read();
      if (!project) return { authorized: [] };
      const seen = new Set();
      for (const source of [project.source, project.lastValid]) {
        if (typeof source !== "string" || !source.trim()) continue;
        try {
          const model = compile(source);
          for (const clip of model.clips)
            if (clip.type === "image" && clip.source) seen.add(clip.source);
        } catch {
          // Uncompilable source contributes no candidates
        }
      }
      const candidates = [...seen].filter((candidate) => {
        const norm = normalizeAssetPath(candidate);
        return norm && !window.__authorizedAssets.has(norm);
      });
      if (candidates.length === 0) return { authorized: [] };
      const answer = await dialogs.showMessageBox(window, {
        type: "question",
        title: "Relink recovered images",
        message:
          "Relink the images used by the recovered draft? Granting access lets this draft display them.",
        detail:
          "Files that will be accessible to this window:\n" +
          candidates.join("\n"),
        buttons: ["Relink images", "Skip"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) return { authorized: [] };
      const authorized = [];
      for (const candidate of candidates)
        if (await authorizeAsset(window, candidate)) authorized.push(candidate);
      return { authorized };
    }),
  );
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
    if (window.__dirty) throw new Error("Newer unsaved changes remain.");
    window.__allowClose = true;
    window.close();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (
      parsed.protocol !== "framecode:" ||
      parsed.host !== "app" ||
      parsed.pathname !== "/index.html"
    )
      event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("close", (event) => {
    if (window.__allowClose) return;
    if (!window.__dirty) return;
    event.preventDefault();
    if (window.__closing) return;
    window.__closing = true;
    window.webContents.send("desktop:command", "close");
    setTimeout(() => {
      window.__closing = false;
    }, 500);
  });
  window.on("closed", () => {
    // Remove capability token mapping.
    windowTokenMap.delete(assetToken);
    // Remove only this window's IPC entries; other windows keep theirs.
    // No destroyed-window property access happens here (the principal
    // webContents object still serves as a valid Map key even when closed).
    for (const fns of channelRegistry.values()) fns.delete(principalWC);
    for (const [channel, fns] of [...channelRegistry]) {
      if (fns.size === 0) {
        ipcMain.removeHandler(channel);
        channelRegistry.delete(channel);
      }
    }
  });
  if (show) window.once("ready-to-show", () => window.show());
  await window.loadURL(ENTRY + "?token=" + assetToken);
  return { window, recovery, assetToken, metadata: () => ({
    path: window.__currentPath,
    name: window.__currentPath ? path.basename(window.__currentPath) : "Untitled.framecode.json",
  }) };
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
            label: "Open\u2026",
            accelerator: "CmdOrCtrl+O",
            click: command("open"),
          },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: command("save") },
          {
            label: "Save As\u2026",
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
          { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: command("redo") },
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
if (require.main === module || !module.parent)
  start().catch((error) => {
    dialog.showErrorBox("Framecode could not start", error.message);
    app.exit(1);
  });