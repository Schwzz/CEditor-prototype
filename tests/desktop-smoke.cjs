const { app, clipboard } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
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
  saving = null,
  opening = null,
  unsaved = 2,
  openCalls = 0,
  checks = 0;
const dialogs = {
  showSaveDialog: async () =>
    saving ? { canceled: false, filePath: saving } : { canceled: true },
  showOpenDialog: async () => {
    openCalls++;
    return opening
      ? { canceled: false, filePaths: [opening] }
      : { canceled: true };
  },
  showMessageBox: async () => ({ response: unsaved }),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = (fn, ...args) =>
  window.webContents.executeJavaScript(
    "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
    true,
  );
async function wait(fn, description) {
  const limit = Date.now() + 12000;
  while (Date.now() < limit) {
    if (await page(fn)) return;
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
async function source() {
  return page(() => {
    document.getElementById("openShare").click();
    const value = document.getElementById("shareCode").value;
    document.getElementById("shareDialog").close();
    return value;
  });
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
async function drag(from, to) {
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
    window.webContents.sendInputEvent({
      type: "mouseMove",
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
}, 90000);
app
  .whenReady()
  .then(async () => {
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "framecode-desktop-"),
    );
    installProtocol();
    ({ window } = await createDesktopWindow({
      dataDirectory,
      dialogs,
      show: true,
    }));
    installMenu(window);
    const rendererErrors = [];
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") rendererErrors.push(event.message);
    });
    await wait(() => document.body.dataset.ready === "true", "desktop ready");
    assert.equal(window.webContents.getURL(), "framecode://app/index.html");
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
    const original = await source();
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
    await click("undo");
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
    await click("undo");
    assert.doesNotMatch(await source(), /\.position\(/);
    await click("redo");
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
    await sleep(100);
    assert.match(await clipboard.readText(), /framecode-clip/);
    window.webContents.send("desktop:command", "paste");
    await sleep(100);
    assert.equal(
      await page(() => document.querySelectorAll(".clip-body").length),
      6,
    );
    passed("clip clipboard copy/paste");
    saving = null;
    await click("saveAsProject");
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
    await click("saveProject");
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
    await click("openProject");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Other.framecode.json",
      "opened project identity",
    );
    assert.match(await source(), /OPENED PROJECT/);
    assert.equal(
      await page(() => document.getElementById("undo").disabled),
      true,
    );
    opening = originalPath;
    await click("openProject");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Saved.framecode.json",
      "original project reopened",
    );
    assert.equal(await source(), saved.source);
    passed("Open loads real project content, file identity, and fresh history");
    await replaceCode(saved.source + "\nunknownFunction(");
    await wait(
      () => !document.getElementById("error").hidden,
      "invalid source",
    );
    assert.equal(
      await page(() => document.getElementById("openShare").disabled),
      true,
    );
    await sleep(750);
    const recovery = await page(() => window.framecodeDesktop.readRecovery());
    assert.match(recovery.source, /unknownFunction/);
    assert.equal(recovery.lastValid, saved.source);
    passed(
      "invalid source and last-valid preview survive recovery persistence",
    );
    await click("saveProject");
    await wait(
      () => document.getElementById("dirtyBadge").hidden,
      "save invalid draft",
    );
    const invalid = JSON.parse(await fs.readFile(saving, "utf8"));
    assert.match(invalid.source, /unknownFunction/);
    assert.equal(invalid.lastValid, saved.source);
    passed("invalid drafts can be saved without losing last-valid source");
    await click("undo");
    await wait(
      () => document.getElementById("error").hidden,
      "undo repairs invalid code",
    );
    saving = path.join(dataDirectory, "missing", "CannotSave.framecode.json");
    await click("saveAsProject");
    await wait(
      () => !document.getElementById("saveAsProject").disabled,
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
    await click("openProject");
    assert.equal(openCalls, attempts);
    passed("unsaved Open Cancel keeps document and never opens picker");
    unsaved = 1;
    opening = null;
    const previousSource = await source();
    await click("openProject");
    assert.equal(await source(), previousSource);
    passed("cancelled Open leaves the composition intact");
    await click("newProject");
    await wait(
      () =>
        document.getElementById("fileName").textContent ===
        "Untitled.framecode.json",
      "new project",
    );
    assert.equal(await source(), original);
    assert.equal(
      await page(() => document.getElementById("undo").disabled),
      true,
    );
    passed("New project resets file identity and cross-project history");
    await click("openGuide");
    assert.equal(
      await page(() => document.querySelectorAll("#guideTopics button").length),
      9,
    );
    await click("loadLesson");
    assert.match(await source(), /My first motion/);
    await click("undo");
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
      const caretDistance = await page(() => {
        const line = [...document.querySelectorAll(".cm-line")]
            .find((line) => line.textContent === "// alignment 79")
            .getBoundingClientRect(),
          cursor = document
            .querySelector(".cm-cursor")
            ?.getBoundingClientRect();
        return cursor
          ? Math.abs(
              cursor.top + cursor.height / 2 - line.top - line.height / 2,
            )
          : 999;
      });
      assert.ok(
        caretDistance < 3,
        "caret remains centered on its text line at zoom " +
          zoom +
          ": " +
          caretDistance,
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
    installMenu(window);
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
    await click("saveProject");
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
    await fs.rm(dataDirectory, { recursive: true, force: true });
    clearTimeout(deadline);
    console.log(`DESKTOP COMPLETE: ${checks} checks passed.`);
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error.stack || error);
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
