import "./styles.css";
import { DocumentStore } from "../core/document.mjs";
import { DEFAULT_SOURCE, TEMPLATES, replaceParam } from "../core/engine.mjs";
import {
  updateClip,
  resizeClip,
  splitClip,
  duplicateClip,
  deleteClip,
  copyClip,
  pasteClip,
  MIN_CLIP,
  timingBounds,
} from "../core/operations.mjs";
import { createEditor } from "./editor.mjs";
import { createPreview } from "./preview.mjs";
import { createTimeline } from "./timeline.mjs";
import { mountGuide } from "./guide.mjs";

const $ = (id) => document.getElementById(id),
  desktop = window.framecodeDesktop;
if (!desktop) throw new Error("Launch Framecode from the desktop application.");
const store = new DocumentStore();
let current = 2,
  playing = false,
  loop = true,
  frameHandle = null,
  previous = 0,
  fileBusy = false,
  booting = true,
  recoveryEnabled = true;
let fileName = "Untitled.framecode.json",
  filePath = null,
  toastTimer,
  autosaveTimer,
  renderQueued = false,
  fullRender = true,
  lastNativeState = "",
  menuAnchor = null;
const editing = () =>
  document.activeElement?.isContentEditable ||
  ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) ||
  !!document.activeElement?.closest(".cm-editor");
function toast(message) {
  clearTimeout(toastTimer);
  $("toastMessage").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5500);
}
function errorMessage(error) {
  return String(error?.message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}
function attempt(action) {
  try {
    return action();
  } catch (error) {
    toast(errorMessage(error));
    scheduleRender();
    return null;
  }
}
function commit(source, label, selected = store.selected, coalesce = null) {
  if (fileBusy || booting) return false;
  return attempt(() => store.commit(source, { label, selected, coalesce }));
}
function flushField() {
  if (document.activeElement instanceof HTMLInputElement)
    document.activeElement.blur();
}
function formatTime(time) {
  const value = Math.max(0, Math.floor(time * 100 + 0.00001));
  return (
    String(Math.floor(value / 6000)).padStart(2, "0") +
    ":" +
    String(Math.floor(value / 100) % 60).padStart(2, "0") +
    "." +
    String(value % 100).padStart(2, "0")
  );
}
function updateTime() {
  current = Math.max(0, Math.min(store.model.duration, current));
  $("seek").max = store.model.duration;
  $("seek").value = current;
  $("currentTime").textContent = formatTime(current);
  $("totalTime").textContent = formatTime(store.model.duration);
  timeline.setPlayhead();
}
function setPlaying(value) {
  playing = value;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  $("play").setAttribute(
    "aria-label",
    playing ? "Pause preview" : "Play preview",
  );
  $("play").innerHTML =
    `<svg><use href="#i-${playing ? "pause" : "play"}"/></svg>`;
  $("pausedChip").hidden = playing;
  if (playing) {
    previous = performance.now();
    frameHandle = requestAnimationFrame(frame);
  }
}
function frame(now) {
  frameHandle = null;
  if (!playing) return;
  current += (now - previous) / 1000;
  previous = now;
  if (current >= store.model.duration) {
    if (loop) current %= store.model.duration;
    else {
      current = store.model.duration;
      setPlaying(false);
    }
  }
  updateTime();
  preview.draw();
  if (playing) frameHandle = requestAnimationFrame(frame);
}
function seek(time) {
  setPlaying(false);
  current = time;
  updateTime();
  preview.draw();
}
function selectClip(id, { reveal = true } = {}) {
  const clip = store.model.clips.find((clip) => clip.id === id);
  if (clip && reveal && (current < clip.at || current >= clip.at + clip.for)) {
    setPlaying(false);
    current = clip.at + Math.min(0.7, clip.for / 2);
    updateTime();
  }
  store.select(id);
  const selected = store.model.clips.find((clip) => clip.id === store.selected);
  editor.highlightLine(selected?.line ?? null, { scroll: reveal });
  preview.draw();
}

const editor = createEditor($("editor"), {
  source: store.source,
  onChange: (source) => commit(source, "Edit code", store.selected, "code"),
  onLine: (line) => {
    if (!store.error)
      selectClip(
        store.model.clips.find((clip) => clip.line === line)?.id || null,
        { reveal: false },
      );
  },
  onUndo: () => {
    if (!fileBusy && !booting) store.undo();
  },
  onRedo: () => {
    if (!fileBusy && !booting) store.redo();
  },
  onRun: () => {
    if (store.error) toast(store.error.message);
    else toast("Composition is up to date.");
  },
  onError: toast,
});
const preview = createPreview($("canvas"), {
  store,
  getTime: () => current,
  onSelect: selectClip,
  onPause: () => setPlaying(false),
  onCommit: commit,
  onError: toast,
});
const timeline = createTimeline({
  store,
  ruler: $("ruler"),
  tracks: $("tracks"),
  playhead: $("playhead"),
  getTime: () => current,
  onSeek: seek,
  onSelect: selectClip,
  onCommit: commit,
  onPreview: (model) => preview.draw(model),
  onPause: () => setPlaying(false),
  onContext: openContext,
  onError: toast,
});

function renderParams() {
  const signature = Object.entries(store.model.params)
    .map(
      ([key, value]) =>
        key +
        ":" +
        typeof value +
        ":" +
        (/^#[0-9a-f]{6}$/i.test(value) ? "color" : "plain"),
    )
    .join("|");
  if ($("params").dataset.signature !== signature) {
    $("params").dataset.signature = signature;
    $("params").replaceChildren();
    for (const [key, value] of Object.entries(store.model.params)) {
      const row = document.createElement("div");
      row.className = "parameter";
      const label = document.createElement("label");
      label.htmlFor = "param-" + key;
      label.textContent = key;
      const hint = document.createElement("code");
      hint.textContent = "$" + key;
      label.append(hint);
      row.append(label);
      const input = document.createElement("input");
      input.id = "param-" + key;
      input.dataset.param = key;
      input.setAttribute("aria-label", key + " template parameter");
      const change = () => {
        if (store.error || fileBusy || booting) return;
        const next =
          typeof value === "number" ? input.valueAsNumber : input.value;
        if (typeof next === "number" && !Number.isFinite(next)) return;
        attempt(() =>
          commit(
            replaceParam(store.source, key, next),
            "Change " + key,
            store.selected,
            "param:" + key,
          ),
        );
      };
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        const group = document.createElement("div");
        group.className = "color-input";
        input.type = "color";
        const hex = document.createElement("input");
        hex.type = "text";
        hex.dataset.hex = key;
        hex.maxLength = 7;
        hex.setAttribute("aria-label", key + " hex color");
        hex.addEventListener("change", () => {
          if (!/^#[0-9a-f]{6}$/i.test(hex.value)) {
            toast("Use a six-digit hex color, such as #d6fa69.");
            scheduleRender();
            return;
          }
          attempt(() =>
            commit(replaceParam(store.source, key, hex.value), "Change " + key),
          );
        });
        group.append(input, hex);
        row.append(group);
        input.addEventListener("input", change);
      } else {
        input.type =
          typeof value === "number"
            ? key === "tempo"
              ? "range"
              : "number"
            : "text";
        if (input.type === "range") {
          input.min = ".2";
          input.max = "3";
          input.step = ".1";
        } else if (input.type === "number") input.step = ".1";
        row.append(input);
        input.addEventListener(
          input.type === "number" ? "change" : "input",
          (event) => {
            if (!event.isComposing) change();
          },
        );
        input.addEventListener("compositionend", change);
      }
      $("params").append(row);
    }
  }
  $("params")
    .querySelectorAll("input")
    .forEach((input) => {
      const value =
        store.model.params[input.dataset.param || input.dataset.hex];
      if (input.value !== String(value)) input.value = value;
      input.disabled = !!store.error || fileBusy;
    });
}
function defaultPosition(clip) {
  return (
    clip.position || [
      clip.type === "shape" ? 1380 : clip.place === "center" ? 960 : 95,
      clip.type === "shape"
        ? 548
        : clip.place === "bottom"
          ? 864
          : clip.place === "center"
            ? 470
            : 343,
    ]
  );
}
function renderSelection() {
  const clip = store.model.clips.find((clip) => clip.id === store.selected);
  $("selectionCard").hidden = !clip;
  if (!clip) return;
  $("selectedName").textContent = clip.id;
  const bounds = timingBounds(clip, store.model.duration);
  const values = {
    clipStart: clip.at,
    clipEnd: clip.at + clip.for,
    clipDuration: clip.for,
  };
  if (clip.type !== "scene") {
    const [x, y] = defaultPosition(clip);
    values.positionX = x;
    values.positionY = y;
  }
  for (const [id, value] of Object.entries(values)) {
    const field = $(id);
    if (field.value !== String(+value.toFixed(3)))
      field.value = +value.toFixed(3);
    field.disabled = !!store.error || fileBusy;
  }
  $("clipStart").max = store.model.duration - clip.for;
  $("clipEnd").min = bounds.endMin;
  $("clipEnd").max = bounds.endMax;
  $("clipDuration").max = bounds.endMax - clip.at;
  $("positionFields").hidden = clip.type === "scene";
  $("selectionHelp").textContent =
    clip.type === "scene"
      ? "Background scenes fill the frame. Resize their timeline edges to change timing."
      : "Drag the preview to move. Arrow keys nudge the focused preview; Shift moves 10px.";
}
function scheduleRender(event = { type: "edit" }) {
  if (event.type !== "selection") fullRender = true;
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render(fullRender);
    fullRender = false;
  });
}
function render(full = true) {
  editor.setReadOnly(fileBusy || booting);
  editor.setSource(store.source);
  const selected = store.model.clips.find((clip) => clip.id === store.selected);
  editor.highlightLine(selected?.line ?? null);
  if (full) {
    renderParams();
    timeline.render();
  }
  timeline.updateSelection();
  renderSelection();
  $("projectName").textContent = store.model.name;
  $("previewLabel").textContent = store.model.name.toUpperCase();
  $("lineCount").textContent = store.source.split("\n").length + " lines";
  $("clipCount").textContent = store.model.clips.length + " clips";
  $("durationLabel").textContent = store.model.duration.toFixed(1) + "s";
  $("error").hidden = !store.error;
  $("error").textContent = store.error
    ? `Line ${store.error.line || 1}: ${store.error.message} The last valid preview is shown.`
    : "";
  $("compileStatus").textContent = store.error
    ? "Check your code"
    : "Live · changes run automatically";
  $("compileStatus").parentElement.classList.toggle(
    "error-status",
    !!store.error,
  );
  $("timelineStatus").textContent = store.error
    ? "Last valid composition · fix the code to edit visually"
    : "Code, preview, and timeline are in sync";
  $("previewHint").textContent = store.error
    ? "Preview of the last valid composition"
    : "Click an object to select · drag to move";
  $("undo").disabled = !store.canUndo || fileBusy;
  $("redo").disabled = !store.canRedo || fileBusy;
  $("dirtyBadge").hidden = !store.dirty;
  $("fileName").textContent = fileName;
  $("fileName").title = filePath || "New local project";
  $("openShare").disabled = !!store.error || fileBusy;
  for (const id of [
    "newProject",
    "openProject",
    "saveProject",
    "saveAsProject",
    "reset",
    "openTemplates",
  ])
    $(id).disabled = fileBusy || booting;
  const nativeState = JSON.stringify([store.dirty, store.model.name]);
  if (nativeState !== lastNativeState) {
    lastNativeState = nativeState;
    desktop
      .setDirty(store.dirty, store.model.name)
      .catch((error) => toast(errorMessage(error)));
  }
  updateTime();
  preview.draw();
}
function cancelAutosave() {
  clearTimeout(autosaveTimer);
}
function scheduleRecovery() {
  cancelAutosave();
  if (booting || !recoveryEnabled) return;
  if (!store.dirty) {
    desktop
      .clearRecovery()
      .catch((error) =>
        toast("Could not clear recovery: " + errorMessage(error)),
      );
    return;
  }
  autosaveTimer = setTimeout(async () => {
    const snapshot = store.serialize();
    try {
      await desktop.writeRecovery(snapshot);
      if (store.source === snapshot.source)
        $("saveStatus").textContent = "Unsaved · recovery copy saved locally";
    } catch (error) {
      $("saveStatus").textContent =
        "Recovery failed · save your project manually";
      toast(errorMessage(error));
    }
  }, 600);
}
store.subscribe((event) => {
  scheduleRender(event);
  if (event.type !== "selection" && event.type !== "saved") scheduleRecovery();
});

for (const [id, key] of [
  ["clipStart", "at"],
  ["clipEnd", "end"],
  ["clipDuration", "for"],
])
  $(id).addEventListener("change", () => {
    if (store.error || fileBusy || !store.selected) return;
    const value = $(id).valueAsNumber;
    attempt(() => {
      if (!Number.isFinite(value)) throw new Error("Enter a valid time.");
      if (key === "for" && value < MIN_CLIP)
        throw new Error("Use a length of at least 0.1 seconds.");
      setPlaying(false);
      commit(
        key === "end"
          ? resizeClip(store.source, store.selected, "end", value)
          : updateClip(store.source, store.selected, { [key]: value }),
        "Set clip timing",
      );
    });
  });
for (const id of ["positionX", "positionY"])
  $(id).addEventListener("change", () => {
    if (store.error || fileBusy || !store.selected) return;
    attempt(() => {
      const position = [
        $("positionX").valueAsNumber,
        $("positionY").valueAsNumber,
      ];
      setPlaying(false);
      commit(
        updateClip(store.source, store.selected, { position }),
        "Set object position",
      );
    });
  });
$("clearSelection").onclick = () => selectClip(null);
$("play").onclick = () => {
  if (current >= store.model.duration) current = 0;
  setPlaying(!playing);
};
$("restart").onclick = () => seek(0);
$("loop").onclick = () => {
  loop = !loop;
  $("loop").setAttribute("aria-pressed", String(loop));
  $("loop").classList.toggle("active", loop);
};
$("seek").oninput = () => seek($("seek").valueAsNumber);
$("run").onclick = () => {
  if (store.error) toast(store.error.message);
  else toast("Composition is up to date.");
};
$("reset").onclick = () => {
  setPlaying(false);
  commit(DEFAULT_SOURCE, "Reset example", null);
  current = 2;
};
for (const button of document.querySelectorAll(".close-dialog"))
  button.onclick = () => button.closest("dialog").close();
function openModal(id) {
  $(id).showModal();
}
$("openGuide").onclick = () => openModal("guideDialog");
$("openTemplates").onclick = () => openModal("templatesDialog");
for (const template of TEMPLATES) {
  const card = document.createElement("button");
  card.className = "gallery-card";
  card.setAttribute("aria-label", "Load " + template.name);
  const art = document.createElement("div");
  art.className = "gallery-art " + template.kind;
  const title = document.createElement("span");
  title.textContent = template.name;
  art.append(title);
  const info = document.createElement("div");
  info.className = "gallery-info";
  const name = document.createElement("strong");
  name.textContent = template.name;
  const description = document.createElement("p");
  description.textContent = template.description;
  info.append(name, description);
  card.append(art, info);
  card.onclick = () => {
    setPlaying(false);
    commit(template.source, "Load template", null);
    current = 2;
    $("templatesDialog").close();
    toast("Template loaded. Undo restores the previous composition.");
  };
  $("templateGallery").append(card);
}
mountGuide({
  topics: $("guideTopics"),
  content: $("guideContent"),
  onLoad: (source) => {
    setPlaying(false);
    commit(source, "Load guide example", null);
    current = 2;
    $("guideDialog").close();
    toast("Example loaded. Undo restores the previous source.");
  },
});
$("openShare").onclick = () => {
  $("shareCode").value = store.source;
  openModal("shareDialog");
};
$("copyCode").onclick = async () => {
  try {
    await desktop.writeClipboard($("shareCode").value);
    toast("Composition code copied.");
  } catch (error) {
    toast(errorMessage(error));
  }
};
$("saveTemplate").onclick = async () => {
  await runFile(() => saveSnapshot(true));
};

async function saveSnapshot(saveAs = false) {
  const snapshot = store.serialize(),
    result = await desktop.saveProject(snapshot, saveAs);
  if (!result) return false;
  fileName = result.name;
  filePath = result.path;
  store.markSaved(snapshot);
  cancelAutosave();
  if (!store.dirty) await desktop.clearRecovery();
  else scheduleRecovery();
  $("saveStatus").textContent = store.dirty
    ? "Saved version · newer changes remain"
    : "Project saved locally";
  toast("Saved " + fileName);
  return true;
}
async function guardUnsaved() {
  if (!store.dirty) return true;
  const response = await desktop.confirmUnsaved();
  if (response === "cancel") return false;
  if (response === "save") return (await saveSnapshot()) && !store.dirty;
  return true;
}
async function runFile(action) {
  if (fileBusy || booting) return false;
  flushField();
  setPlaying(false);
  fileBusy = true;
  scheduleRender();
  try {
    return await action();
  } catch (error) {
    toast(errorMessage(error));
    return false;
  } finally {
    fileBusy = false;
    scheduleRender();
  }
}
async function fileCommand(command) {
  return runFile(async () => {
    if (command === "save" || command === "saveAs")
      return saveSnapshot(command === "saveAs");
    if (!(await guardUnsaved())) return false;
    if (command === "open") {
      const loaded = await desktop.openProject();
      if (!loaded) return false;
      cancelAutosave();
      await desktop.clearRecovery();
      fileName = loaded.name;
      filePath = loaded.path;
      store.load(loaded.project);
      $("saveStatus").textContent = "Project opened locally";
    } else if (command === "new") {
      cancelAutosave();
      await desktop.newProject();
      await desktop.clearRecovery();
      fileName = "Untitled.framecode.json";
      filePath = null;
      store.load({ source: DEFAULT_SOURCE, lastValid: DEFAULT_SOURCE });
      $("saveStatus").textContent = "New local project";
    } else if (command === "close") {
      cancelAutosave();
      await desktop.clearRecovery();
      await desktop.setDirty(false, store.model.name);
      await desktop.finishClose();
      return true;
    }
    current = 2;
    return true;
  });
}
for (const [id, command] of [
  ["newProject", "new"],
  ["openProject", "open"],
  ["saveProject", "save"],
  ["saveAsProject", "saveAs"],
])
  $(id).onclick = () => fileCommand(command);

function closeContext({ restoreFocus = false } = {}) {
  $("clipMenu").hidden = true;
  if (restoreFocus) {
    const body = [...$("tracks").querySelectorAll(".clip-body")].find(
      (button) => button.dataset.clip === store.selected,
    );
    (body || menuAnchor)?.focus();
  }
}
function openContext(id, x, y, anchor) {
  if (fileBusy || booting) return;
  selectClip(id);
  menuAnchor = anchor;
  const menu = $("clipMenu");
  menu.hidden = false;
  for (const button of menu.querySelectorAll("button")) {
    button.disabled =
      !!store.error || (!store.selected && button.dataset.command !== "paste");
    if (button.dataset.command === "split") {
      const clip = store.model.clips.find((clip) => clip.id === store.selected);
      button.disabled =
        button.disabled ||
        !clip ||
        current - clip.at < MIN_CLIP ||
        clip.at + clip.for - current < MIN_CLIP;
    }
  }
  menu.style.left =
    Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top =
    Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + "px";
  menu.querySelector("button:not(:disabled)")?.focus();
}
$("clipMenu").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button && !button.disabled) {
    closeContext();
    void command(button.dataset.command);
  }
});
$("clipMenu").addEventListener("keydown", (event) => {
  const items = [...$("clipMenu").querySelectorAll("button:not(:disabled)")];
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement),
      next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (currentIndex +
                (event.key === "ArrowDown" ? 1 : -1) +
                items.length) %
              items.length;
    items[next]?.focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeContext({ restoreFocus: true });
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#clipMenu")) closeContext();
});
window.addEventListener("resize", () => {
  closeContext();
  timeline.setPlayhead();
});
async function command(name) {
  if (fileBusy || booting) return;
  try {
    if (["new", "open", "save", "saveAs", "close"].includes(name))
      return await fileCommand(name);
    if (name === "guide") {
      openModal("guideDialog");
      return;
    }
    if (name === "undo" || name === "redo") {
      flushField();
      setPlaying(false);
      store[name]();
      return;
    }
    if (["cut", "copy", "paste"].includes(name) && editing()) {
      await desktop.editClipboard(name);
      return;
    }
    if (store.error) {
      toast("Fix the code before editing clips.");
      return;
    }
    if (name === "timing") {
      $("clipStart").focus();
      $("clipStart").select();
      return;
    }
    setPlaying(false);
    if (name === "copy" || name === "cut") {
      const base = store.source,
        id = store.selected;
      await desktop.writeClipboard(copyClip(base, id));
      if (name === "cut" && base === store.source)
        commit(deleteClip(base, id), "Cut clip", null);
      else
        toast(
          name === "cut"
            ? "Clip copied; composition changed, so it was not removed."
            : "Clip copied.",
        );
    } else if (name === "paste") {
      const base = store.source,
        payload = await desktop.readClipboard();
      if (base !== store.source)
        throw new Error("The composition changed. Paste again.");
      const result = pasteClip(base, payload, current);
      commit(result.source, "Paste clip", result.id);
    } else if (name === "duplicate" || name === "split") {
      const result =
        name === "duplicate"
          ? duplicateClip(store.source, store.selected)
          : splitClip(store.source, store.selected, current);
      commit(
        result.source,
        name === "duplicate" ? "Duplicate clip" : "Split clip",
        result.id,
      );
    } else if (name === "delete")
      commit(deleteClip(store.source, store.selected), "Delete clip", null);
  } catch (error) {
    toast(errorMessage(error));
    scheduleRender();
  }
}
$("undo").onclick = () => command("undo");
$("redo").onclick = () => command("redo");
desktop.onCommand((name) => void command(name));
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void command(event.shiftKey ? "saveAs" : "save");
    return;
  }
  if (modifier && !editing()) {
    const keys = {
      z: event.shiftKey ? "redo" : "undo",
      y: "redo",
      n: "new",
      o: "open",
      x: "cut",
      c: "copy",
      v: "paste",
      d: "duplicate",
    };
    if (keys[event.key.toLowerCase()]) {
      event.preventDefault();
      void command(keys[event.key.toLowerCase()]);
      return;
    }
  }
  if (event.key === "F1") {
    event.preventDefault();
    void command("guide");
  }
  if (!editing() && !modifier && event.key === "Delete") {
    event.preventDefault();
    void command("delete");
  }
  if (!editing() && !modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void command("split");
  }
  if (
    !editing() &&
    event.code === "Space" &&
    document.activeElement?.tagName !== "BUTTON"
  ) {
    event.preventDefault();
    if (current >= store.model.duration) current = 0;
    setPlaying(!playing);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPlaying(false);
});
new ResizeObserver(() => timeline.setPlayhead()).observe($("timeline"));
async function boot() {
  try {
    const recovery = await desktop.readRecovery();
    if (recovery) {
      await new Promise((resolve) => {
        $("recoveryDialog").addEventListener("cancel", (event) =>
          event.preventDefault(),
        );
        $("restoreRecovery").onclick = () => {
          store.load(recovery, { dirty: true });
          $("recoveryDialog").close();
          $("saveStatus").textContent =
            "Recovered draft · save as a new project";
          resolve();
        };
        $("discardRecovery").onclick = async () => {
          try {
            await desktop.clearRecovery();
            $("recoveryDialog").close();
            resolve();
          } catch (error) {
            toast(errorMessage(error));
          }
        };
        $("recoveryDialog").showModal();
      });
    }
  } catch (error) {
    recoveryEnabled = false;
    toast(
      "Recovery could not be read. Save manually; the old recovery file has been preserved.",
    );
    $("saveStatus").textContent = "Recovery unavailable · save manually";
  }
  booting = false;
  render();
  scheduleRecovery();
  document.body.dataset.ready = "true";
}
render();
void boot();
