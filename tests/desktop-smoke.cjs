const { app, clipboard, net, Menu } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createDesktopWindow,
  installProtocol,
  installMenu,
} = require("../desktop/main.cjs");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let window,
  dataDirectory,
  recents,
  saving = null,
  opening = null,
  unsaved = 2,
  openCalls = 0,
  checks = 0,
  assetToken = "",
  rendererErrors = [],
  relinkConsent = 1;
    const packageJson = require("../package.json");
    const dialogs = {
  showSaveDialog: async () =>
    saving ? { canceled: false, filePath: saving } : { canceled: true },
  showOpenDialog: async () => {
    openCalls++;
    return opening
      ? { canceled: false, filePaths: [opening] }
      : { canceled: true };
  },
  showMessageBox: async (_win, options) =>
    options?.title === "Relink recovered images"
      ? { response: relinkConsent }
      : { response: unsaved },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assetUrl = (p, token = assetToken) =>
  "framecode://app/assets/?path=" + encodeURIComponent(p) + (token ? "&token=" + token : "");
const page = (fn, ...args) =>
  window.webContents.executeJavaScript(
    "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
    true,
  );
async function wait(fn, description) {
  const limit = Date.now() + 12000;
  while (Date.now() < limit) {
    try {
      if (await page(fn)) return;
    } catch (error) {
      throw new Error(
        "During '" + description + "': " + (error.message || error),
      );
    }
    await sleep(40);
  }
  throw new Error("Timed out: " + description);
}
async function click(id) {
  await page((id) => document.getElementById(id).click(), id);
  await sleep(60);
}
async function select(id) {
  await page(
    (id) =>
      [...document.querySelectorAll(".clip-body")]
        .find((button) => button.dataset.clip === id)
        .click(),
    id,
  );
  await sleep(60);
}
// Toolbar buttons were removed; file/app commands arrive through the native
// menu, which forwards them as "desktop:command" sends. Simulate exactly
// that path here.
async function cmd(name) {
  window.webContents.send("desktop:command", name);
  await sleep(80);
}
// The header buttons are gone; the composition source opens through the
// native File menu ("Composition source…" → "desktop:command" "source"),
// which fills #shareCode with the live source.
async function source() {
  await cmd("source");
  const value = await page(() => {
    const dialog = document.getElementById("shareDialog");
    if (!dialog.open) throw new Error("source dialog did not open");
    return document.getElementById("shareCode").value;
  });
  await page(() => {
    const dialog = document.getElementById("shareDialog");
    if (dialog.open) dialog.close();
  });
  return value;
}
async function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await sleep(80);
}
async function replaceCode(value) {
  await page(() => document.querySelector(".cm-content").focus());
  await key("A", ["control"]);
  window.webContents.insertText(value);
  await sleep(180);
}
async function field(id, value, event = "change") {
  await page(
    (id, value, event) => {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event(event, { bubbles: true }));
    },
    id,
    String(value),
    event,
  );
  await sleep(80);
}
async function drag(from, to, during = null) {
  window.webContents.sendInputEvent({
    type: "mouseMove",
    x: Math.round(from.x),
    y: Math.round(from.y),
  });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step++) {
    if (step === 3 && during) await during();
    window.webContents.sendInputEvent({
      type: "mouseMove",
      modifiers: ["leftButtonDown"],
      x: Math.round(from.x + ((to.x - from.x) * step) / 5),
      y: Math.round(from.y + ((to.y - from.y) * step) / 5),
    });
    await sleep(20);
  }
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: Math.round(to.x),
    y: Math.round(to.y),
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
}
function passed(name) {
  checks++;
  console.log("DESKTOP PASS: " + name);
}
const deadline = setTimeout(() => {
  console.error("Desktop smoke deadline exceeded");
  app.exit(1);
}, 150000);
app
  .whenReady()
  .then(async () => {
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "framecode-desktop-"),
    );
    installProtocol();
    ({ window, recents, assetToken } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") rendererErrors.push(event.message);
    });
    await wait(() => document.body.dataset.ready === "true", "desktop ready");
    assert.match(
      window.webContents.getURL(),
      /^framecode:\/\/app\/index\.html(\?token=[0-9a-f]+)?$/,
    );
    assert.equal(await page(() => typeof require), "undefined");
    assert.equal(
      await page(() => typeof window.framecodeDesktop.saveProject),
      "function",
    );
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    assert.ok(
      await page(
        () =>
          document.querySelector(".timeline-panel").getBoundingClientRect()
            .bottom <=
          innerHeight + 1,
      ),
      "desktop timeline remains visible without page scrolling",
    );
    passed("local sandboxed desktop shell and restricted preload");
    // Phase 2.1: the app launches into the Home screen and must not create
    // or load a placeholder project (no dirty state, no recovery write).
    assert.equal(await page(() => document.body.dataset.stage), "home");
    assert.equal(
      await page(() => document.getElementById("homeScreen").hidden),
      false,
    );
    assert.equal(
      await page(() => window.framecodeDesktop.readRecovery()),
      null,
    );
    assert.equal(
      await page(() => document.getElementById("dirtyBadge").hidden),
      true,
    );
    passed(
      "launch lands on the Home screen without creating a placeholder draft",
    );
    // Stage-aware chrome: until the renderer reports the editor stage the
    // window is branded and offers only file-level menus.
    const menuLabels = () => Menu.getApplicationMenu().items.map((item) => item.label);
    let homeMenu = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      homeMenu = menuLabels();
      if (homeMenu.length === 1 && homeMenu[0] === "File") break;
      await sleep(50);
    }
    assert.deepEqual(homeMenu, ["File"]);
    assert.equal(window.getTitle(), "Framecode");
    passed("Home shows the brand title and only file-level menus");
    // Honest recent-projects empty state: a fresh launch has no saved
    // entries yet, so no fake entries and no promise of tracking will appear.
    const recentsText = await page(() =>
      document.getElementById("homeRecentsEmpty").textContent,
    );
    assert.match(recentsText, /No recent projects yet\./);
    assert.equal(
      await page(() => document.getElementById("homeRecents").hidden),
      true,
    );
    passed("Home shows an honest empty recent-projects state");
    // A cancelled Open from Home must stay on Home.
    opening = null;
    await click("homeOpenProject");
    await wait(
      () => !document.getElementById("homeOpenProject").disabled,
      "home idle after cancelled open",
    );
    assert.equal(await page(() => document.body.dataset.stage), "home");
    passed("cancelled Open from Home keeps the Home screen");
    // New Project from Home is the explicit way into the editor. The native
    // menu forwards "new" over desktop:command — the same path a Ctrl+N
    // accelerator click takes — and it must enter the editor from Home
    // exactly like the Home buttons.
    window.webContents.send("desktop:command", "new");
    await wait(
      () =>
        document.body.dataset.stage === "editor" &&
        document.getElementById("homeScreen").hidden,
      "entered editor from Home",
    );
    passed("New Project from Home enters the editor");
    // Phase 2.4 audit: the Run button advertises Ctrl+Enter (aria-keyshortcuts
    // and an on-screen keyhint) — the shortcut must actually run the
    // composition exactly like the button itself does.
    await key("Enter", ["control"]);
    await wait(
      () =>
        /up to date/i.test(
          document.getElementById("toastMessage").textContent,
        ),
      "Ctrl+Enter runs the composition",
    );
    await page(() => document.getElementById("toast").setAttribute("hidden", ""));
    passed("Run shortcut Ctrl+Enter executes like the Run button");
    // Editor chrome: full menus (Templates arrives asynchronously with the
    // dynamic template items) and the document title. The code panel starts
    // COLLAPSED: the launch state is the video-editing workspace (preview,
    // inspector, timeline), with code one keystroke or click away.
    let editorMenu = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      editorMenu = menuLabels();
      if (editorMenu.includes("Templates")) break;
      await sleep(50);
    }
    assert.deepEqual(editorMenu, ["File", "Edit", "View", "Templates", "Help"]);
    assert.equal(window.getTitle(), "Orbit study — Framecode");
    assert.equal(
      await page(() => document.querySelector(".workspace").dataset.code),
      "collapsed",
    );
    assert.equal(
      await page(() =>
        document.getElementById("codePanelToggle").getAttribute("aria-pressed"),
      ),
      "false",
    );
    assert.equal(
      await page(() => document.getElementById("timelineStatus").hidden),
      true,
    );
    // Video-first geometry: preview and inspector are laid out and the
    // timeline is visible beneath them, with no code column taking space.
    const geometry = await page(() => {
      const rail = document.querySelector(".code-rail").getBoundingClientRect();
      const preview = document
        .querySelector(".preview-panel")
        .getBoundingClientRect();
      const inspector = document
        .querySelector(".template-panel")
        .getBoundingClientRect();
      const timeline = document
        .querySelector(".timeline-panel")
        .getBoundingClientRect();
      return {
        railWidth: rail.width,
        previewWidth: preview.width,
        previewRightOfRail: preview.left >= rail.right - 1,
        inspectorWidth: inspector.width,
        inspectorAtRightEdge:
          Math.abs(inspector.right - innerWidth) < 2,
        timelineVisible: timeline.height > 40 && timeline.top >= preview.bottom,
      };
    });
    assert.equal(geometry.railWidth <= 44, true);
    assert.ok(geometry.previewWidth > 300, "preview is prominent");
    assert.ok(geometry.previewRightOfRail, "preview sits beside the rail");
    assert.ok(geometry.inspectorWidth > 180, "inspector keeps its column");
    assert.ok(geometry.inspectorAtRightEdge, "inspector anchors the right edge");
    assert.ok(geometry.timelineVisible, "timeline stays visible below");
    passed(
      "editor stage shows full menus, document title, and the collapsed code workspace",
    );
    // Opening the panel through the View-menu command path a menu click or
    // Ctrl+E takes: the workspace expands, the checkbox rebuilds in sync,
    // and the editor becomes visible and measurable.
    const codePanelChecked = () =>
      Menu.getApplicationMenu().getMenuItemById("codePanel").checked;
    await cmd("codePanel");
    assert.equal(
      await page(() => document.querySelector(".workspace").dataset.code),
      "open",
    );
    let checkboxSync = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (codePanelChecked() === true) {
        checkboxSync = true;
        break;
      }
      await sleep(50);
    }
    assert.ok(checkboxSync, "View checkbox follows the opened panel");
    assert.ok(
      await page(
        () =>
          document.querySelector(".cm-content").getBoundingClientRect().width >
            100 &&
          document.querySelector(".cm-content").innerText.length > 0,
      ),
      "code editor is visible and populated once opened",
    );
    // Ctrl+E through the renderer shortcut path toggles the panel back
    // closed, and the View checkbox follows.
    await key("e", ["control"]);
    assert.equal(
      await page(() => document.querySelector(".workspace").dataset.code),
      "collapsed",
    );
    checkboxSync = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (codePanelChecked() === false) {
        checkboxSync = true;
        break;
      }
      await sleep(50);
    }
    assert.ok(checkboxSync, "View checkbox follows the Ctrl+E collapse");
    // Leave the panel open for the editing flows that follow.
    await cmd("codePanel");
    assert.equal(
      await page(() => document.querySelector(".workspace").dataset.code),
      "open",
    );
    passed(
      "code panel starts collapsed and opens/closes with the View menu in sync",
    );
    const original = await source();
    await require("./editing-desktop.cjs")({
      page,
      click,
      cmd,
      field,
      replaceCode,
      source,
      key,
      drag,
      passed,
    });
    await field("param-title", "DESKTOP TEST", "input");
    assert.match(await source(), /DESKTOP TEST/);
    passed("template controls update composition");
    window.close();
    await sleep(150);
    assert.equal(window.isDestroyed(), false);
    passed("unsaved Close Cancel preserves the window and draft");
    await select("Headline");
    assert.equal(
      await page(() => document.getElementById("selectedName").textContent),
      "Headline",
    );
    assert.match(
      await page(() => document.querySelector(".cm-clip-line").textContent),
      /Headline/,
    );
    passed("timeline and source share selection");
    await page(() =>
      document.querySelector('[aria-label="Resize Headline end"]').focus(),
    );
    await key("Left");
    assert.match(await source(), /\.for\(10\.7\)/);
    passed("timeline edge keyboard resizing");
    const beforeDrag = await source();
    const clip = await page(() => {
      const element = document.querySelector(
        '.clip-body[data-clip="Headline"]',
      );
      element.scrollIntoView({ block: "center" });
      const r = element.getBoundingClientRect();
      return { x: r.x + 35, y: r.y + r.height / 2 };
    });
    await drag(clip, { x: clip.x + 30, y: clip.y });
    assert.notEqual(await source(), beforeDrag);
    await cmd("undo");
    assert.equal(await source(), beforeDrag);
    passed("timeline dragging commits one undo step");
    await page(() =>
      document.getElementById("canvas").scrollIntoView({ block: "center" }),
    );
    const canvas = await page(() => {
      const r = document.getElementById("canvas").getBoundingClientRect();
      return {
        x: r.x + (1380 / 1920) * r.width,
        y: r.y + (548 / 1080) * r.height,
      };
    });
    await drag(canvas, { x: canvas.x + 20, y: canvas.y + 10 });
    assert.match(await source(), /\.position\(/);
    assert.equal(
      await page(() => document.getElementById("selectedName").textContent),
      "Signal",
    );
    await cmd("undo");
    assert.doesNotMatch(await source(), /\.position\(/);
    await cmd("redo");
    assert.match(await source(), /\.position\(/);
    passed("preview hit selection, movement, and shared undo/redo");
    await select("Headline");
    await field("seek", 4, "input");
    await page(() => {
      const button = document.querySelector('.clip-body[data-clip="Headline"]'),
        r = button.getBoundingClientRect();
      button.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: r.left + 30,
          clientY: r.top + 10,
        }),
      );
    });
    assert.equal(
      await page(() => document.getElementById("clipMenu").hidden),
      false,
    );
    await page(() =>
      document.querySelector('#clipMenu [data-command="split"]').click(),
    );
    await sleep(100);
    assert.equal(
      await page(() => document.querySelectorAll(".clip-body").length),
      5,
    );
    assert.match(await source(), /\.sourceAt\(/);
    passed("context-menu split with continuous animation source window");
    window.webContents.send("desktop:command", "copy");
    // The native clipboard write completes asynchronously, so poll instead
    // of trusting a fixed delay.
    const copyLimit = Date.now() + 4000;
    let copied = "";
    while (Date.now() < copyLimit && !/framecode-clip/.test(copied)) {
      copied = await clipboard.readText();
      await sleep(60);
    }
    assert.match(copied, /framecode-clip/);
    window.webContents.send("desktop:command", "paste");
    await sleep(100);
    assert.equal(
      await page(() => document.querySelectorAll(".clip-body").length),
      6,
    );
    passed("clip clipboard copy/paste");

    // Image import & rendering test
    const testImgPath = path.join(dataDirectory, "test.png");
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    await fs.writeFile(testImgPath, pngBuffer);
    opening = testImgPath;
    await cmd("importImage");
    assert.match(await source(), /image\("test"\)/);
    passed("image import and code insertion");

    const authorizedRes = await net.fetch(assetUrl(testImgPath));
    assert.equal(authorizedRes.status, 200);
    passed("authorized imported asset loads through framecode://assets/");
    // The imported image renders in the preview AND the canvas stays
    // untaintable (same-origin asset route): getImageData succeeds and the
    // pixel at the clip's position is the green 1x1 source color.
    await field("seek", 5, "input");
    await wait(
      () => {
        try {
          const { data } = document
            .getElementById("canvas")
            .getContext("2d")
            .getImageData(95, 343, 1, 1);
          return data[1] > 200 && data[0] < 200 && data[2] < 200;
        } catch {
          return false;
        }
      },
      "image visible, pixel green, canvas untainted",
    );
    passed("imported image renders untainted in the preview canvas");

    // Failed-load retry: source referencing a file directly is not
    // authorized, so its load fails and the renderer caches that failure.
    // Re-importing the very same file through the native dialog must evict
    // the failed entry so the image actually reloads and renders.
    const retryImgPath = path.join(dataDirectory, "retry.png");
    await fs.writeFile(retryImgPath, pngBuffer);
    await replaceCode(
      'composition("Retry").duration(12)\nimage("retry").at(0).for(12).source(' +
        JSON.stringify(retryImgPath) +
        ")",
    );
    await sleep(300);
    assert.ok(
      await page(() => {
        try {
          const { data } = document
            .getElementById("canvas")
            .getContext("2d")
            .getImageData(95, 343, 1, 1);
          return !(
            data[1] > 100 &&
            data[1] > data[0] + 40 &&
            data[1] > data[2] + 40
          );
        } catch {
          return false;
        }
      }),
      "unauthorized directly-referenced image does not render",
    );
    opening = retryImgPath;
    await cmd("importImage");
    assert.match(await source(), /image\("retry_1"\)/);
    await wait(
      () => {
        try {
          const { data } = document
            .getElementById("canvas")
            .getContext("2d")
            .getImageData(95, 343, 1, 1);
          return (
            data[1] > 100 &&
            data[1] > data[0] + 40 &&
            data[1] > data[2] + 40
          );
        } catch {
          return false;
        }
      },
      "re-imported image renders after failed-load eviction",
    );
    passed("re-importing a failed image evicts the failed entry and renders");

    const unauthorizedImgPath = path.join(dataDirectory, "unauthorized.png");
    await fs.writeFile(unauthorizedImgPath, pngBuffer);
    const unauthorizedRes = await net.fetch(assetUrl(unauthorizedImgPath));
    assert.equal(unauthorizedRes.status, 403);
    passed("unauthorized image path receives HTTP 403 from the protocol");
    // A request without the window's capability token must be rejected,
    // proving authorization is bound to the owning window.
    const noTokenRes = await net.fetch(
      "framecode://app/assets/?path=" + encodeURIComponent(testImgPath),
    );
    assert.equal(noTokenRes.status, 403);
    passed("asset request without the window token is rejected");
    // Protocol hardening: malformed and missing paths.
    assert.equal(
      (await net.fetch("framecode://assets/?path=")).status,
      400,
    );
    passed("missing asset path returns HTTP 400");
    assert.equal(
      (await net.fetch("framecode://assets/?path=relative.png")).status,
      400,
    );
    passed("relative asset path returns HTTP 400");
    assert.equal(
      (await net.fetch("framecode://assets/?path=" + encodeURIComponent(testImgPath), { method: "POST" }))
        .status,
      405,
    );
    passed("unsupported method returns HTTP 405");
    // Real oversize gate: a single byte over the size limit must be
    // rejected by the import authorization (50 MiB limit).
    const oversizedPath = path.join(dataDirectory, "oversized.png");
    await fs.writeFile(oversizedPath, Buffer.alloc(50 * 1024 * 1024 + 1));
    opening = oversizedPath;
    await cmd("importImage");
    await sleep(150);
    assert.doesNotMatch(await source(), /image\("oversized"\)/);
    passed("oversized image is rejected at import");
    unsaved = 1;
    await cmd("new");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Untitled.framecode.json" && !document.getElementById("reset").disabled,
      "new project clears authorization",
    );
    const clearedAuthRes = await net.fetch(assetUrl(testImgPath));
    assert.equal(clearedAuthRes.status, 403);
    passed("project switch clears prior asset authorization");
    // Two simultaneous windows with different projects: window 2 must not
    // be able to access window 1's authorized asset, and vice versa.
    const secondData = await fs.mkdtemp(
      path.join(os.tmpdir(), "framecode-second-"),
    );
    const secondDialogs = {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 2 }),
    };
    const secondState = await createDesktopWindow({
      dataDirectory: secondData,
      dialogs: secondDialogs,
      show: true,
    });
    const window2 = secondState.window;
    const secondUrlMatches = () =>
      /^framecode:\/\/app\/index\.html\?token=[0-9a-f]+$/.test(
        window2.webContents.getURL(),
      );
    for (let attempt = 0; attempt < 200 && !secondUrlMatches(); attempt++)
      await sleep(50);
    assert.match(
      window2.webContents.getURL(),
      /^framecode:\/\/app\/index\.html\?token=[0-9a-f]+$/,
    );
    // window1's token must not authorize requests from window2.
    assert.equal(
      (await net.fetch(assetUrl(testImgPath, secondState.assetToken))).status,
      403,
    );
    passed("cross-window access to another window's asset is rejected");
    // window2 boots into the Home screen as well; enter its editor the same
    // way a user would (New Project) before exercising its import flow.
    await window2.webContents.executeJavaScript(
      'document.getElementById("homeNewProject").click()',
    );
    await window2.webContents.executeJavaScript(
      "(async () => { for (let i = 0; i < 100 && document.body.dataset.stage !== 'editor'; i++) await new Promise(r => setTimeout(r, 50)); })()",
    );
    // window2 imports its own asset.
    const secondImgPath = path.join(secondData, "second.png");
    await fs.writeFile(secondImgPath, pngBuffer);
    secondDialogs.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [secondImgPath],
    });
    window2.webContents.send("desktop:command", "importImage");
    for (
      let attempt = 0;
      attempt < 100 &&
      !(await window2.webContents.executeJavaScript(
        "(document.querySelector('.cm-content')?.innerText || '').includes('image(\"second\")')",
      ));
      attempt++
    )
      await sleep(50);
    const secondSource = await window2.webContents.executeJavaScript(
      "document.querySelector('.cm-content').innerText",
    );
    assert.match(secondSource, /image\("second"\)/);
    assert.equal(
      (await net.fetch(
        assetUrl(secondImgPath, secondState.assetToken),
      )).status,
      200,
    );
    passed("second window can access its own imported asset");
    // window1 still cannot reach window2's asset.
    assert.equal(
      (await net.fetch(assetUrl(secondImgPath, assetToken))).status,
      403,
    );
    passed("first window cannot access the second window's asset");
    window2.destroy();
    for (let attempt = 0; attempt < 100 && !window2.isDestroyed(); attempt++)
      await sleep(30);
    // Closing window 2 must strip only its own IPC handlers: window 1's
    // renderer chrome must still be able to talk to the main process.
    assert.equal(
      await page(() => window.framecodeDesktop.platform),
      process.platform,
    );
    // Genuine IPC invocation through the shared dispatcher after window
    // 2's handlers were torn down: a full clipboard round-trip.
    await clipboard.writeText("post-close-ipc");
    assert.equal(
      await page(() => window.framecodeDesktop.readClipboard()),
      "post-close-ipc",
    );
    passed("closing one window leaves the other window's IPC intact");
    await fs.rm(secondData, { recursive: true, force: true });
    opening = testImgPath;
    await cmd("importImage");
    assert.match(await source(), /image\("test"\)/);
    await field("param-title", "DESKTOP TEST", "input");
    assert.match(await source(), /DESKTOP TEST/);
    saving = null;
    await cmd("saveAs");
    assert.equal(
      await page(() => document.getElementById("dirtyBadge").hidden),
      false,
    );
    passed("cancelled Save As preserves dirty draft");
    unsaved = 0;
    window.close();
    await sleep(160);
    assert.equal(window.isDestroyed(), false);
    assert.equal(
      await page(() => document.getElementById("dirtyBadge").hidden),
      false,
    );
    unsaved = 2;
    passed("Close Save followed by a cancelled picker retains the draft");
    saving = path.join(dataDirectory, "Saved.framecode.json");
    await cmd("save");
    await wait(
      () => document.getElementById("dirtyBadge").hidden,
      "saved state",
    );
    const saved = JSON.parse(await fs.readFile(saving, "utf8"));
    assert.equal(saved.format, "framecode-project");
    assert.equal(saved.source, await source());
    passed("native project save writes the actual composition");
    const originalPath = saving,
      otherPath = path.join(dataDirectory, "Other.framecode.json"),
      otherSource = saved.source.replace("DESKTOP TEST", "OPENED PROJECT");
    await fs.writeFile(
      otherPath,
      JSON.stringify({ ...saved, source: otherSource, lastValid: otherSource }),
    );
    opening = otherPath;
    await cmd("open");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Other.framecode.json",
      "opened project identity",
    );
    assert.match(await source(), /OPENED PROJECT/);
    // Fresh history: an immediately-issued Undo must be a no-op.
    await cmd("undo");
    assert.equal(await source(), otherSource);
    opening = originalPath;
    await cmd("open");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Saved.framecode.json",
      "original project reopened",
    );
    assert.equal(await source(), saved.source);
    passed("Open loads real project content, file identity, and fresh history");
    await wait(
      () => !document.getElementById("reset").disabled,
      "open idle before cleanup failure",
    );
    await fs.mkdir(path.join(dataDirectory, "recovery.json"));
    opening = otherPath;
    await cmd("open");
    await wait(
      () => !document.getElementById("reset").disabled,
      "open after recovery cleanup failure",
    );
    assert.equal(
      await source(),
      otherSource,
      "a failed recovery cleanup cannot leave the old document bound to the newly opened file",
    );
    assert.equal(
      await page(() => document.getElementById("fileName").textContent),
      "Other.framecode.json",
    );
    await cmd("save");
    await wait(
      () => !document.getElementById("reset").disabled,
      "save after cleanup failure",
    );
    assert.equal(
      JSON.parse(await fs.readFile(otherPath, "utf8")).source,
      otherSource,
    );
    await cmd("new");
    await wait(
      () => !document.getElementById("reset").disabled,
      "new after cleanup failure",
    );
    assert.equal(await source(), original);
    assert.equal(
      await page(() => document.getElementById("fileName").textContent),
      "Untitled.framecode.json",
    );
    await fs.rm(path.join(dataDirectory, "recovery.json"), {
      recursive: true,
      force: true,
    });
    opening = originalPath;
    await cmd("open");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Saved.framecode.json",
      "original reopened after cleanup repaired",
    );
    passed(
      "recovery cleanup failures cannot redirect Save to another document",
    );
    await replaceCode(saved.source + "\nunknownFunction(");
    await wait(
      () => !document.getElementById("error").hidden,
      "invalid source",
    );
    // The source surface is not reachable while the composition is invalid,
    // matching the disabled header button from before the menu rework.
    await cmd("source");
    assert.equal(
      await page(
        () => document.getElementById("shareDialog").open,
      ),
      false,
    );
    await wait(async () => {
      const snapshot = await window.framecodeDesktop.readRecovery();
      return snapshot && /unknownFunction/.test(snapshot.source);
    }, "recovery copy persists the invalid source");
    const recovery = await page(() => window.framecodeDesktop.readRecovery());
    assert.match(recovery.source, /unknownFunction/);
    assert.equal(recovery.lastValid, saved.source);
    passed(
      "invalid source and last-valid preview survive recovery persistence",
    );
    await cmd("save");
    await wait(
      () => document.getElementById("dirtyBadge").hidden,
      "save invalid draft",
    );
    const invalid = JSON.parse(await fs.readFile(saving, "utf8"));
    assert.match(invalid.source, /unknownFunction/);
    assert.equal(invalid.lastValid, saved.source);
    passed("invalid drafts can be saved without losing last-valid source");
    await cmd("undo");
    await wait(
      () => document.getElementById("error").hidden,
      "undo repairs invalid code",
    );
    saving = path.join(dataDirectory, "missing", "CannotSave.framecode.json");
    await cmd("saveAs");
    await wait(
      () => !document.getElementById("reset").disabled,
      "failed save returns to idle",
    );
    assert.equal(
      await page(() => document.getElementById("fileName").textContent),
      "Saved.framecode.json",
    );
    assert.equal(
      await page(() => document.getElementById("dirtyBadge").hidden),
      false,
    );
    assert.match(
      JSON.parse(await fs.readFile(originalPath, "utf8")).source,
      /unknownFunction/,
    );
    saving = originalPath;
    passed(
      "failed Save As retains original file identity, disk content, and dirty state",
    );
    unsaved = 2;
    opening = saving;
    const attempts = openCalls;
    await cmd("open");
    assert.equal(openCalls, attempts);
    passed("unsaved Open Cancel keeps document and never opens picker");
    unsaved = 1;
    opening = null;
    const previousSource = await source();
    await cmd("open");
    assert.equal(await source(), previousSource);
    passed("cancelled Open leaves the composition intact");

    // Recovery relink regressions: reads alone never authorize; consent does.
    // The dirty project may still hold a scheduled recovery autosave from an
    // earlier commit or undo (it fires 600ms after the store event). The
    // relink fixtures below must control recovery.json without the renderer
    // racing them, so first wait until the file has stayed unchanged longer
    // than the autosave window: any pending write will have landed by then,
    // and nothing in this window commits again during the relink scenario.
    const recoveryPath = path.join(dataDirectory, "recovery.json");
    const recoveryBytes = async () => {
      try {
        return await fs.readFile(recoveryPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    };
    let previousRecovery = await recoveryBytes();
    let stabilized = false;
    for (let attempt = 0; attempt < 12 && !stabilized; attempt++) {
      await sleep(700);
      const currentRecovery = await recoveryBytes();
      if (currentRecovery === previousRecovery) stabilized = true;
      else previousRecovery = currentRecovery;
    }
    assert.ok(
      stabilized,
      "recovery.json never stabilized within " +
        12 * 700 +
        "ms; a renderer recovery autosave kept rewriting it before the relink fixtures",
    );
    const relinkImgPath = path.join(dataDirectory, "unlinked.png");
    await fs.writeFile(relinkImgPath, pngBuffer);
    const relinkSource =
      'composition("Relink").duration(12)\nimage("relinked").at(0).for(12).source(' +
      JSON.stringify(relinkImgPath) +
      ")";
    const { RecoveryFile: RelinkRecoveryFile } = await import(
      "../desktop/project-files.mjs",
    );
    const relinkRecovery = new RelinkRecoveryFile(dataDirectory);
    await relinkRecovery.write({
      format: "framecode-project",
      version: 1,
      source: relinkSource,
      lastValid: relinkSource,
    });
    const readBackDeadline = Date.now() + 6000;
    let readBack;
    // The renderer's own autosave can legally rewrite pending copy; reseed
    // until the relink fixture is what is actually on disk, so the check
    // stays deterministic.
    for (;;) {
      await relinkRecovery.write({
        format: "framecode-project",
        version: 1,
        source: relinkSource,
        lastValid: relinkSource,
      });
      readBack = await page(() => window.framecodeDesktop.readRecovery());
      if (
        (readBack && /Relink/.test(readBack.source)) ||
        Date.now() > readBackDeadline
      )
        break;
      await sleep(120);
    }
    assert.match(readBack.source, /Relink/);
    assert.equal((await net.fetch(assetUrl(relinkImgPath))).status, 403);
    passed("recovery read alone never authorizes image files");
    relinkConsent = 1;
    assert.deepEqual(
      await page(() => window.framecodeDesktop.relinkRecoveryAssets()),
      { authorized: [] },
    );
    assert.equal((await net.fetch(assetUrl(relinkImgPath))).status, 403);
    passed("declining the relink consent dialog leaves images unauthorized");
    relinkConsent = 0;
    // Grant path reseed: after the quiesce above no renderer write can race
    // the fixtures, so one write guarantees the fixture is what the granted
    // consent scan reads.
    await relinkRecovery.write({
      format: "framecode-project",
      version: 1,
      source: relinkSource,
      lastValid: relinkSource,
    });
    assert.equal(
      /Relink/.test(
        (await page(() => window.framecodeDesktop.readRecovery())).source,
      ),
      true,
    );
    const granted = await page(() =>
      window.framecodeDesktop.relinkRecoveryAssets(),
    );
    assert.deepEqual(granted, { authorized: [relinkImgPath] });
    const relinkedImage = await page(
      (candidate, token) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src =
            "framecode://app/assets/?path=" +
            encodeURIComponent(candidate) +
            "&token=" +
            token;
        }),
      relinkImgPath,
      assetToken,
    );
    assert.ok(relinkedImage, "consented relinked image loads in the renderer");
    passed("explicit relink consent authorizes and displays recovered images");

    await cmd("new");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Untitled.framecode.json",
      "new project",
    );
    assert.equal(await source(), original);
    // Fresh history again: Undo on a brand-new document changes nothing.
    await cmd("undo");
    assert.equal(await source(), original);
    passed("New project resets file identity and cross-project history");
    await cmd("guide");
    assert.equal(
      await page(() => document.querySelectorAll("#guideTopics button").length),
      9,
    );
    await click("loadLesson");
    assert.match(await source(), /My first motion/);
    await cmd("undo");
    assert.equal(await source(), original);
    passed("nine built-in lessons and undoable example loading");
    const long =
      original +
      "\n" +
      Array.from({ length: 80 }, (_, i) => "// alignment " + i).join("\n");
    await replaceCode(long);
    for (const zoom of [1, 1.25]) {
      window.webContents.setZoomFactor(zoom);
      await sleep(100);
      await page(() => document.querySelector(".cm-content").focus());
      await key("End", ["control"]);
      await wait(
        () =>
          [...document.querySelectorAll(".cm-line")].some(
            (line) => line.textContent === "// alignment 79",
          ),
        "bottom of source",
      );
      await sleep(100);
      const aligned = await page((count) => {
        const line = [...document.querySelectorAll(".cm-line")].find(
            (line) => line.textContent === "// alignment 79",
          ),
          number = [
            ...document.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
          ].find((element) => element.textContent === String(count));
        const a = line.getBoundingClientRect(),
          b = number?.getBoundingClientRect();
        return b ? Math.abs(a.top - b.top) : 999;
      }, long.split("\n").length);
      assert.ok(
        aligned < 2.1,
        "code and gutter stay aligned at zoom " + zoom + ": " + aligned,
      );
      assert.ok(
        await page(() => {
          const scroller = document.querySelector(".cm-scroller");
          return scroller.scrollHeight > scroller.clientHeight + 100;
        }),
        "long source scrolls inside the editor",
      );
      // The rendered caret element is hidden and zero-sized while the
      // BrowserWindow lacks OS focus, so measuring its rect is flaky.
      // The DOM selection is focus-independent: verify the caret landed
      // on the navigation target line and that it is scrolled into view.
      await page(() => document.querySelector(".cm-content").focus());
      const caretState = await page(() => {
        const selection = window.getSelection();
        if (!selection.rangeCount) return { placed: false };
        // The caret can sit between nodes at the very end of the content;
        // check both ends of the selection for a containing line.
        const line = [selection.anchorNode, selection.focusNode]
          .map(
            (node) =>
              node &&
              (node.nodeType === 1 ? node : node.parentElement)?.closest(
                ".cm-line",
              ),
          )
          .find(Boolean);
        const target = [...document.querySelectorAll(".cm-line")].find(
          (entry) => entry.textContent === "// alignment 79",
        );
        return { placed: !!line && line === target };
      });
      assert.ok(
        caretState.placed,
        "caret lands on its navigation target line at zoom " +
          zoom +
          ": " +
          JSON.stringify(caretState),
      );
    }
    passed("long-document gutter alignment at 100% and 125% zoom");
    window.webContents.setZoomFactor(1);
    await click("reset");
    await page(() => {
      window.scrollTo(0, 0);
      document.querySelector(".cm-scroller").scrollTop = 0;
      document.querySelector(".cm-scroller").scrollLeft = 0;
    });
    await sleep(120);
    await fs.mkdir(path.join("build", "qa"), { recursive: true });
    await fs.writeFile(
      path.join("build", "qa", "desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(rendererErrors.length, 0, rendererErrors.join("\n"));
    await window.webContents.executeJavaScript(
      'window.framecodeDesktop.setDirty(false,"Smoke test")',
    );
    window.destroy();
    const { RecoveryFile } = await import("../desktop/project-files.mjs"),
      recoverFile = new RecoveryFile(dataDirectory);
    await recoverFile.write({
      format: "framecode-project",
      version: 1,
      source: original + "\ninvalid(",
      lastValid: original,
    });
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    await wait(
      () => document.getElementById("recoveryDialog").open,
      "recovery dialog on relaunch",
    );
    await click("restoreRecovery");
    await wait(
      () => document.body.dataset.ready === "true",
      "restored draft ready",
    );
    assert.equal(
      await page(() => document.getElementById("error").hidden),
      false,
    );
    assert.equal(
      await page(() => document.getElementById("dirtyBadge").hidden),
      false,
    );
    assert.equal(
      await page(() => document.getElementById("fileName").textContent),
      "Untitled.framecode.json",
    );
    passed("relaunch restores invalid recovery as a new unsaved project");
    saving = path.join(dataDirectory, "Recovered.framecode.json");
    await cmd("save");
    await wait(
      () => document.getElementById("dirtyBadge").hidden,
      "recovered project saved",
    );
    assert.match(
      JSON.parse(await fs.readFile(saving, "utf8")).source,
      /invalid\(/,
    );
    assert.equal(await recoverFile.read(), null);
    passed("saving a recovered project clears recovery after disk success");
    window.destroy();
    await recoverFile.write({
      format: "framecode-project",
      version: 1,
      source: original,
      lastValid: original,
    });
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await wait(
      () => document.getElementById("recoveryDialog").open,
      "pending recovery dialog",
    );
    window.close();
    await sleep(100);
    assert.ok(await recoverFile.read());
    passed("closing before recovery choice preserves the recovery file");
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await wait(
      () => document.getElementById("recoveryDialog").open,
      "recovery discard choice",
    );
    await click("discardRecovery");
    await wait(
      () => document.body.dataset.ready === "true",
      "recovery discarded",
    );
    assert.equal(await recoverFile.read(), null);
    passed("explicit recovery discard clears only the recovery copy");
    await field("param-title", "CLOSE SAVE", "input");
    saving = path.join(dataDirectory, "Closed.framecode.json");
    unsaved = 0;
    window.close();
    for (let attempt = 0; attempt < 100 && !window.isDestroyed(); attempt++)
      await sleep(30);
    assert.equal(window.isDestroyed(), true);
    assert.match(
      JSON.parse(await fs.readFile(saving, "utf8")).source,
      /CLOSE SAVE/,
    );
    assert.equal(await recoverFile.read(), null);
    passed("Close Save writes the project before closing its native window");
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await wait(
      () => document.body.dataset.ready === "true",
      "last close-cleanup test window",
    );
    await field("param-title", "DISCARD WITH LOCKED RECOVERY", "input");
    await fs.mkdir(path.join(dataDirectory, "recovery.json"));
    unsaved = 1;
    window.close();
    for (let attempt = 0; attempt < 100 && !window.isDestroyed(); attempt++)
      await sleep(30);
    assert.equal(
      window.isDestroyed(),
      true,
      "explicit Discard must close even if old recovery cannot be removed",
    );
    passed("Close Discard is not blocked by recovery cleanup failure");
    // The discard fixture deliberately leaves recovery.json as a directory.
    // Remove it before any later launch, otherwise every subsequent window
    // boots with a failed recovery read and an extra Home toast.
    await fs.rm(path.join(dataDirectory, "recovery.json"), {
      recursive: true,
      force: true,
    });
    // Phase 2.1: Open Project from the Home screen of a fresh launch loads
    // the chosen file and enters the editor.
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    await wait(() => document.body.dataset.ready === "true", "home relaunch ready");
    const homeOpenPath = path.join(dataDirectory, "HomeFixture.framecode.json");
    await fs.writeFile(
      homeOpenPath,
      JSON.stringify({
        format: "framecode-project",
        version: 1,
        source: original.replace("Orbit study", "Opened from home"),
        lastValid: original.replace("Orbit study", "Opened from home"),
      }),
    );
    assert.equal(await page(() => document.body.dataset.stage), "home");
    opening = homeOpenPath;
    await click("homeOpenProject");
    await wait(
      () =>
        document.body.dataset.stage === "editor" &&
        document.getElementById("fileName").textContent ===
          "HomeFixture.framecode.json",
      "opened fixture enters editor from Home",
    );
    assert.match(await source(), /Opened from home/);
    passed("Open Project from Home opens a real project file");
    // Phase 2.2: recent projects. The main process records entries only
    // after a real open or a real disk save, the list persists in the data
    // directory, and a fresh launch (new window, same data directory)
    // renders it on Home.
    const tracked = await recents.list();
    const trackedNames = tracked.map((entry) => entry.name);
    assert.equal(trackedNames.includes("HomeFixture.framecode.json"), true);
    assert.equal(trackedNames.includes("Closed.framecode.json"), true);
    assert.equal(trackedNames.includes("Saved.framecode.json"), true);
    assert.deepEqual(
      tracked.filter((entry) => entry.missing).map((entry) => entry.name),
      [],
      "successfully opened and saved projects are not marked missing",
    );
    passed("opens and successful saves are tracked in Recents");
    const recentsUI = () =>
      page(() =>
        [...document.querySelectorAll(".recent-item")].map((item) => ({
          name: item.querySelector(".recent-open strong").textContent,
          path: item.querySelector(".recent-path").textContent,
          missing: item.classList.contains("missing"),
        })),
      );
    const clickRecent = (name) =>
      page((name) => {
        const button = [...document.querySelectorAll(".recent-open")].find(
          (button) => button.querySelector("strong").textContent === name,
        );
        if (!button) throw new Error("no recent entry: " + name);
        button.click();
      }, name);
    const removeRecent = (name) =>
      page((name) => {
        const item = [...document.querySelectorAll(".recent-item")].find(
          (item) =>
            item.querySelector(".recent-open strong").textContent === name,
        );
        if (!item) throw new Error("no recent entry: " + name);
        item.querySelector(".recent-remove").click();
      }, name);
    // Restart simulation: a brand-new window over the same data directory
    // boots to Home and shows the persisted Recents with file information.
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    await wait(
      () => document.body.dataset.ready === "true",
      "recents relaunch ready",
    );
    await wait(
      () => document.querySelectorAll(".recent-item").length > 0,
      "recents rendered on Home",
    );
    const rendered = await recentsUI();
    assert.equal(rendered.length, tracked.length, "every entry is rendered");
    assert.equal(rendered[0].name, "HomeFixture.framecode.json");
    assert.match(rendered[0].path, /HomeFixture\.framecode\.json$/);
    assert.equal(rendered[0].missing, false);
    passed("a fresh launch renders persisted Recents with file paths");
    // Reopening a recent project goes through the same trusted pipeline as
    // the Open dialog and loads the correct project.
    await clickRecent("HomeFixture.framecode.json");
    await wait(
      () =>
        document.body.dataset.stage === "editor" &&
        document.getElementById("fileName").textContent ===
          "HomeFixture.framecode.json",
      "recent project reopened",
    );
    assert.match(await source(), /Opened from home/);
    assert.equal((await recents.list())[0].name, "HomeFixture.framecode.json",
      "reopening moves the project back to the top instead of duplicating it");
    assert.equal(
      (await recents.list()).filter((e) => e.name === "HomeFixture.framecode.json").length,
      1,
    );
    passed("selecting a recent project reopens the correct project");
    // Missing files stay listed but marked, clicking explains the problem
    // and stays on Home, and removal drops only the entry.
    await fs.rm(homeOpenPath);
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    await wait(
      () => document.body.dataset.ready === "true",
      "missing-project relaunch ready",
    );
    await wait(
      () => document.querySelectorAll(".recent-item").length > 0,
      "recents rendered again",
    );
    const missingEntry = (await recentsUI()).find(
      (entry) => entry.name === "HomeFixture.framecode.json",
    );
    assert.equal(missingEntry?.missing, true, "vanished project is marked missing");
    await clickRecent("HomeFixture.framecode.json");
    await wait(
      () =>
        !document.getElementById("toast").hidden &&
        /missing/.test(document.getElementById("toastMessage").textContent),
      "missing project toast",
    );
    assert.match(
      await page(() => document.getElementById("toastMessage").textContent),
      /missing/,
    );
    assert.equal(await page(() => document.body.dataset.stage), "home");
    passed("missing recent projects are marked, explained, and recoverable");
    const savedPath = path.join(dataDirectory, "Saved.framecode.json");
    assert.equal((await stat(savedPath)).isFile(), true);
    await removeRecent("Saved.framecode.json");
    await wait(
      () =>
        ![...document.querySelectorAll(".recent-open strong")].some(
          (element) => element.textContent === "Saved.framecode.json",
        ),
      "entry removed from Home",
    );
    assert.equal(
      (await recentsUI()).some((entry) => entry.name === "Saved.framecode.json"),
      false,
    );
    assert.equal((await stat(savedPath)).isFile(), true,
      "removing a Recents entry never deletes the project file");
    passed("removing a Recents entry keeps the project file on disk");
    // A failed open must not create a misleading Recents entry.
    const beforeFailedOpen = await recents.list();
    opening = path.join(dataDirectory, "DoesNotExist.framecode.json");
    unsaved = 2;
    await cmd("open");
    await wait(
      () =>
        /ENOENT|no such file/i.test(
          document.getElementById("toastMessage").textContent,
        ),
      "failed open toast",
    );
    assert.equal(await page(() => document.body.dataset.stage), "home");
    const afterFailedOpen = await recents.list();
    assert.deepEqual(
      afterFailedOpen.map((entry) => entry.path),
      beforeFailedOpen.map((entry) => entry.path),
      "a failed open leaves Recents untouched",
    );
    passed("failed opens never create misleading Recents entries");
    // Phase 2.3: Settings. The File menu reaches a settings dialog on both
    // stages; changes are persisted in the data directory and a fresh launch
    // (new window, same data directory) applies them at boot.
    const settingsPath = path.join(dataDirectory, "settings.json");
    const readSettingsFile = async () => {
      try {
        return JSON.parse(await fs.readFile(settingsPath, "utf8"));
      } catch {
        return null;
      }
    };
    const homeMenuBar = Menu.getApplicationMenu();
    assert.equal(
      homeMenuBar.getMenuItemById("appSettings") !== null,
      true,
      "Home File menu offers Settings…",
    );
    await cmd("settings");
    assert.equal(
      await page(() => document.getElementById("settingsDialog").open),
      true,
    );
    assert.equal(
      await page(() => document.getElementById("aboutName").textContent),
      "Framecode",
    );
    assert.equal(
      await page(() => document.getElementById("aboutVersion").textContent),
      "Version " + packageJson.version,
      "application information uses the authoritative package version",
    );
    passed("Settings opens from the Home File menu with accurate app info");
    // Changing a checkbox applies live and persists promptly. The settings
    // file is polled in the test process (the generic wait() helper runs its
    // predicate inside the renderer, where the filesystem is not reachable).
    const persistedSetting = async (test, description) => {
      const limit = Date.now() + 8000;
      while (Date.now() < limit) {
        const file = await readSettingsFile();
        if (file && test(file)) return file;
        await sleep(50);
      }
      throw new Error("Timed out: " + description);
    };
    await page(() => document.getElementById("settingsTimelineSnap").click());
    await persistedSetting(
      (file) => file?.settings?.timelineSnap === false,
      "timelineSnap preference persisted",
    );
    await field("settingsMaxRecents", 3, "change");
    await persistedSetting(
      (file) => file?.settings?.maxRecents === 3,
      "maxRecents preference persisted",
    );
    // The cap is applied by the main process as a separate queued step
    // (settings:set writes the settings file first, then awaits
    // recents.setCap), so settings persistence alone does not prove the
    // live list is already trimmed. Poll the live list until the cap
    // applies, then assert on the settled state; the assertion itself is
    // unchanged in strength.
    const trimLimit = Date.now() + 8000;
    let trimmed;
    do {
      trimmed = await recents.list();
      if (trimmed.length <= 3) break;
      await sleep(50);
    } while (Date.now() < trimLimit);
    assert.equal(
      trimmed.length <= 3,
      true,
      "new cap trims the live list (still " +
        trimmed.length +
        " entries after 8s: " +
        trimmed.map((entry) => entry.name).join(", ") +
        ")",
    );
    await page(() =>
      document.querySelector('#settingsDialog .close-dialog').click(),
    );
    assert.equal(
      await page(() => document.getElementById("settingsDialog").open),
      false,
    );
    passed("setting changes apply live, persist, and trim recents");
    await window.webContents.executeJavaScript(
      'window.framecodeDesktop.setDirty(false,"Settings test")',
    );
    window.destroy();
    // Restart simulation: the persisted preferences drive the boot state.
    ({ window } = await createDesktopWindow({ dataDirectory, dialogs, show: true }));
    await installMenu(window, "home");
    await wait(
      () => document.body.dataset.ready === "true",
      "settings relaunch ready",
    );
    assert.equal(
      await page(() =>
        document.getElementById("timelineSnap").getAttribute("aria-pressed"),
      ),
      "false",
      "restored timelineSnap preference drives the timeline control",
    );
    assert.match(
      await page(() => document.getElementById("homeVersion").textContent),
      /^v\d/,
      "Home shows the real application version",
    );
    await cmd("settings");
    assert.equal(
      await page(() => document.getElementById("settingsDialog").open),
      true,
    );
    assert.equal(
      await page(
        () => document.getElementById("settingsTimelineSnap").checked,
      ),
      false,
      "the settings dialog reflects the persisted preference",
    );
    await page(() =>
      document.querySelector('#settingsDialog .close-dialog').click(),
    );
    passed("persisted preferences survive a restart and drive the UI");
    // Phase 2.3 review fixes: the editor toolbar snap control and the
    // Settings dialog share one persisted preference, so a toolbar toggle
    // must persist it (and the dialog must follow) regardless of which
    // control made the change.
    await cmd("new");
    await wait(
      () => document.body.dataset.stage === "editor",
      "entered editor for settings sync checks",
    );
    assert.equal(
      await page(() =>
        document.getElementById("timelineSnap").getAttribute("aria-pressed"),
      ),
      "false",
      "the persisted preference drives the editor toolbar too",
    );
    await page(() => document.getElementById("timelineSnap").click());
    await persistedSetting(
      (file) => file?.settings?.timelineSnap === true,
      "editor snap toggle persisted the preference",
    );
    assert.equal(
      await page(() =>
        document.getElementById("timelineSnap").getAttribute("aria-pressed"),
      ),
      "true",
    );
    await cmd("settings");
    assert.equal(
      await page(() => document.getElementById("settingsTimelineSnap").checked),
      true,
      "the Settings dialog follows the editor toolbar toggle",
    );
    await page(() =>
      document.querySelector('#settingsDialog .close-dialog').click(),
    );
    passed("editor snap toggle persists the preference and syncs the dialog");
    // Keep the recovery state clean for the transition tests below (a prior
    // fixture can leave malformed recovery data in this shared directory).
    // Relaunch so the transitions run in a window whose recovery autosave
    // was usable from boot; the relaunch also proves the toolbar-set
    // preference survives a restart.
    await fs.rm(path.join(dataDirectory, "recovery.json"), {
      recursive: true,
      force: true,
    });
    window.destroy();
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    await installMenu(window, "home");
    await wait(
      () => document.body.dataset.ready === "true",
      "recovery-transition relaunch ready",
    );
    assert.equal(
      await page(() =>
        document.getElementById("timelineSnap").getAttribute("aria-pressed"),
      ),
      "true",
      "the toolbar-set preference survives the restart",
    );
    await cmd("new");
    await wait(
      () => document.body.dataset.stage === "editor",
      "entered editor for recovery transitions",
    );
    await field("param-title", "RECOVERY ONE", "input");
    await wait(
      async () => {
        const snapshot = await window.framecodeDesktop.readRecovery();
        return snapshot && /RECOVERY ONE/.test(snapshot.source);
      },
      "recovery copy of the first edit written",
    );
    await cmd("settings");
    // Commit a second edit while the dialog is open, then immediately
    // disable recovery so the pending autosave (600ms after the commit)
    // should be cancelled rather than written.
    await page(() => {
      const input = document.getElementById("param-title");
      input.value = "RECOVERY TWO";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page(() =>
      document.getElementById("settingsRecoveryCopies").click(),
    );
    await persistedSetting(
      (file) => file?.settings?.recoveryCopies === false,
      "recovery copies disabled persisted",
    );
    const disabledSnapshot = await page(() =>
      window.framecodeDesktop.readRecovery(),
    );
    assert.ok(
      disabledSnapshot &&
        /RECOVERY ONE/.test(disabledSnapshot.source) &&
        !/RECOVERY TWO/.test(disabledSnapshot.source),
      "the pending autosave from the second edit was cancelled",
    );
    await sleep(900);
    assert.equal(
      await page(() => window.framecodeDesktop.readRecovery()).then(
        (snapshot) => snapshot && snapshot.source,
      ),
      disabledSnapshot.source,
      "no autosave happens while recovery copies are disabled",
    );
    // Re-enable: the dirty project's autosave resumes and captures the
    // second edit immediately, with no further edit required.
    await page(() =>
      document.getElementById("settingsRecoveryCopies").click(),
    );
    await persistedSetting(
      (file) => file?.settings?.recoveryCopies === true,
      "recovery copies enabled persisted",
    );
    await wait(
      async () => {
        const snapshot = await window.framecodeDesktop.readRecovery();
        return snapshot && /RECOVERY TWO/.test(snapshot.source);
      },
      "recovery resumed and captured the pre-disable edit",
    );
    await page(() =>
      document.querySelector('#settingsDialog .close-dialog').click(),
    );
    passed("recovery autosave cancels pending writes and resumes immediately");
    // Leave no recovery copy behind: the next closed relaunch would other-
    // wise block on the recovery-choice dialog instead of settling.
    await page(() => window.framecodeDesktop.clearRecovery());
    await page(() =>
      window.framecodeDesktop.setDirty(false, "Settings test"),
    );
    // A corrupt settings file must never block a launch: defaults return.
    await fs.writeFile(settingsPath, "{not json at all");
    window.destroy();
    ({ window } = await createDesktopWindow({ dataDirectory, dialogs, show: true }));
    await installMenu(window, "home");
    await wait(
      () => document.body.dataset.ready === "true",
      "corrupt-settings relaunch ready",
    );
    assert.equal(
      await page(() =>
        document.getElementById("timelineSnap").getAttribute("aria-pressed"),
      ),
      "true",
      "corrupt settings fall back to safe defaults",
    );
    assert.deepEqual((await recents.list()).length <= 10, true);
    passed("corrupt settings data is safe: defaults without a crash");
    await fs.rm(dataDirectory, { recursive: true, force: true });
    clearTimeout(deadline);
    console.log(`DESKTOP COMPLETE: ${checks} checks passed.`);
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error.stack || error);
    console.error("RENDERER ERRORS: " + JSON.stringify(rendererErrors));
    try {
      if (window && !window.isDestroyed()) {
        await fs.mkdir("build/qa", { recursive: true });
        await fs.writeFile(
          "build/qa/failure.png",
          (await window.webContents.capturePage()).toPNG(),
        );
        console.error(
          await page(() => ({
            text: document.body.innerText.slice(-2000),
            editorHeight: document.querySelector(".editor-host")?.clientHeight,
            scrollHeight: document.querySelector(".cm-scroller")?.scrollHeight,
            clientHeight: document.querySelector(".cm-scroller")?.clientHeight,
          })),
        );
      }
    } catch {}
    clearTimeout(deadline);
    app.exit(1);
  });
