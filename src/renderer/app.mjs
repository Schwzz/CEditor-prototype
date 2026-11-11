import "./styles.css";
import "./tauri-probe.mjs";
// Truthful Tauri desktop adapter: installs window.framecodeDesktop when
// running in the Tauri webview (no-op under Electron, where the preload
// provides the bridge). Must be imported first so the install runs before
// the module body reads `window.framecodeDesktop` below.
import "./tauri-bridge.mjs";
import { DocumentStore } from "../core/document.mjs";
import { DEFAULT_SOURCE, TEMPLATES, replaceParam } from "../core/engine.mjs";
import {
  updateClip,
  deleteClips,
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
import { defaultPosition } from "./geometry.mjs";
import { ImageCache } from "./renderer.mjs";
import { createPreview } from "./preview.mjs";
import { createLayerLabel, renameClip } from "./layers.mjs";
import { createTimeline } from "./timeline.mjs";
import { mountGuide } from "./guide.mjs";

const $ = (id) => document.getElementById(id),
  desktop = window.framecodeDesktop;
if (!desktop) throw new Error("Launch Framecode from the desktop application.");
const store = new DocumentStore();
const imageCache = new ImageCache();
// Phase 2.1: the app launches into the Home screen; entering the editor is
// an explicit user action (New/Open/restore).
document.body.dataset.stage = "home";
function onHome() {
  return document.body.dataset.stage === "home";
}
function enterEditor() {
  document.body.dataset.stage = "editor";
  $("homeScreen").hidden = true;
  // The native chrome (title, menus) follows the stage.
  desktop.setStage("editor").catch(() => {});
}
imageCache.subscribe(() => {
  if (!playing) scheduleRender();
});

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
  menuAnchor = null,
  recoveryUnusable = false;
// Phase 2.3: user preferences. The persisted settings are read at boot and
// every change is applied live and saved atomically in the main process.
let appSettings = {
  timelineSnap: true,
  recoveryCopies: true,
  maxRecents: 10,
};
function updateRecovery() {
  recoveryEnabled = appSettings.recoveryCopies && !recoveryUnusable;
  if (!recoveryEnabled) cancelAutosave();
}
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
function selectClip(
  id,
  { reveal = true, toggle = false, preserve = false } = {},
) {
  const clip = store.model.clips.find((clip) => clip.id === id);
  if (clip && reveal && (current < clip.at || current >= clip.at + clip.for)) {
    setPlaying(false);
    current = clip.at + Math.min(0.7, clip.for / 2);
    updateTime();
  }
  if (!preserve || !store.selectedIds.includes(id))
    store.select(id, { toggle });
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
  imageCache,
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
  makeLabel: (clip) =>
    createLayerLabel(clip, {
      store,
      onSelect: selectClip,
      onCommit: commit,
      onError: toast,
    }),
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
    // The explainer only earns its place when there is nothing to operate.
    const note = document.querySelector(".param-note");
    if (note) note.hidden = signature.length > 0;
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
function renderSelection() {
  const clip = store.model.clips.find((clip) => clip.id === store.selected);
  $("selectionCard").hidden = !clip;
  if (!clip) return;
  $("selectedName").textContent =
    store.selectedIds.length > 1
      ? store.selectedIds.length + " clips · " + clip.label
      : clip.label;
  $("clipLabel").value = clip.label;
  $("clipLabel").disabled = !!store.error || fileBusy || !!clip.locked;
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
    values.objectScale = clip.scale;
    values.objectRotation = clip.rotation;
    values.objectOpacity = clip.opacity;
  }
  for (const [id, value] of Object.entries(values)) {
    const field = $(id);
    if (field.value !== String(+value.toFixed(3)))
      field.value = +value.toFixed(3);
    field.disabled = !!store.error || fileBusy || !!clip.locked;
  }
  $("clipStart").max = store.model.duration - clip.for;
  $("clipEnd").min = bounds.endMin;
  $("clipEnd").max = bounds.endMax;
  $("clipDuration").max = bounds.endMax - clip.at;
  $("positionFields").hidden = clip.type === "scene";
  $("transformFields").hidden = clip.type === "scene";
  $("selectionHelp").textContent =
    clip.type === "scene"
      ? "Background scenes fill the frame. Resize their timeline edges to change timing."
      : clip.locked
        ? "Locked · unlock with the square button beside this layer."
        : "Corners resize · round handle rotates · Shift rotates in 15° steps. Numeric controls edit the primary selected object.";
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
  editor.highlightLine(
    store.model.clips
      .filter((c) => store.selectedIds.includes(c.id))
      .map((c) => c.line),
  );
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
  const lastValidNotice = store.error
    ? "Last valid composition · fix the code to edit visually"
    : "";
  $("timelineStatus").textContent = lastValidNotice;
  $("timelineStatus").hidden = !lastValidNotice;
  $("previewHint").textContent = store.error
    ? "Preview of the last valid composition"
    : "Drag to move · corners resize · round handle rotates";
  $("dirtyBadge").hidden = !store.dirty;
  $("fileName").textContent = fileName;
  $("fileName").title = filePath || "New local project";
  for (const id of ["reset", "homeNewProject", "homeOpenProject"])
    $(id).disabled = fileBusy || booting;
  for (const button of document.querySelectorAll(
    ".recent-open, .recent-remove",
  ))
    button.disabled = fileBusy || booting;
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
  if (!["selection", "saved", "load"].includes(event.type)) scheduleRecovery();
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
for (const [id, key] of [
  ["objectScale", "scale"],
  ["objectRotation", "rotation"],
  ["objectOpacity", "opacity"],
])
  $(id).onchange = () => {
    if (store.error || fileBusy || !store.selected) return;
    setPlaying(false);
    attempt(() =>
      commit(
        updateClip(store.source, store.selected, {
          [key]: $(id).valueAsNumber,
        }),
        "Set object " + key,
      ),
    );
  };
$("clipLabel").onchange = () =>
  attempt(() =>
    commit(
      renameClip(store.source, store.selected, $("clipLabel").value),
      "Rename layer",
    ),
  );
$("timelineZoom").oninput = () => {
  timeline.cancel();
  timeline.setZoom($("timelineZoom").valueAsNumber);
  $("zoomLabel").textContent = $("timelineZoom").value + "×";
};
$("timelineSnap").onclick = () => {
  const enabled = $("timelineSnap").getAttribute("aria-pressed") !== "true";
  $("timelineSnap").setAttribute("aria-pressed", String(enabled));
  timeline.setSnap(enabled);
  // The toolbar control and the Settings dialog share one preference:
  // toggling here persists it and re-syncs the dialog (and vice versa,
  // via applyPreferences in the dialog change handler).
  void changeSetting("timelineSnap", enabled);
};
const stepFrame = (direction) =>
  seek(
    Math.max(
      0,
      Math.min(
        store.model.duration,
        (Math.round(current * 30) + direction) / 30,
      ),
    ),
  );
$("previousFrame").onclick = () => stepFrame(-1);
$("nextFrame").onclick = () => stepFrame(1);
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
async function runImportImage() {
  if (fileBusy || booting) return;
  let imported;
  try {
    imported = await desktop.importImage();
  } catch (error) {
    toast(errorMessage(error));
    return;
  }
  if (!imported) return;
  // Re-importing (re-authorizing) a file must evict any failed cache
  // entry for it so a previously failed image actually reloads.
  imageCache.evict(imported);
  const baseName =
    imported.split(/[/\\]/).pop().split(".")[0].replace(/[^\w]/g, "_") || "Image";
  let name = baseName;
  let i = 1;
  while (store.model.clips.some((c) => c.id === name)) {
    name = `${baseName}_${i++}`;
  }
  const nextSource = store.source.trimEnd() + `\nimage(${JSON.stringify(name)}).at(${Math.floor(current)}).for(5).source(${JSON.stringify(imported)})`;
  commit(nextSource, "Import image");
}
$("reset").onclick = () => {
  setPlaying(false);
  commit(DEFAULT_SOURCE, "Reset example", null);
  current = 2;
  imageCache.clearAll();
};
// The code panel is a secondary surface: the video-first workspace shows the
// preview, inspector, and timeline; code opens via the rail, the View menu,
// or Ctrl+E, and its width is draggable. Markup boots with the panel open,
// so the live state starts synced to that.
let codeOpen =
  document.querySelector(".workspace").getAttribute("data-code") !== "collapsed";
function setCodePanel(open) {
  if (codeOpen === open) return;
  codeOpen = open;
  document
    .querySelector(".workspace")
    .setAttribute("data-code", open ? "open" : "collapsed");
  const toggle = $("codePanelToggle");
  toggle.setAttribute("aria-pressed", String(open));
  desktop.setCodePanel(open).catch(() => {});
  if (open) editor.refresh();
}
$("codePanelToggle").onclick = () => setCodePanel(!codeOpen);
$("codeResizer").addEventListener("pointerdown", (event) => {
  if (!codeOpen || event.button !== 0) return;
  event.preventDefault();
  const panel = event.currentTarget.parentElement;
  const startX = event.clientX,
    startWidth = panel.getBoundingClientRect().width;
  const move = (e) => {
    const width = Math.max(280, Math.min(720, startWidth + e.clientX - startX));
    document
      .querySelector(".workspace")
      .style.setProperty("--code-w", width + "px");
  };
  const end = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", end);
    removeEventListener("pointercancel", end);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
});
// Home screen actions reuse the existing project workflows; a successful
// New/Open is what actually enters the editor.
async function homeAction(action) {
  if (await fileCommand(action)) enterEditor();
}
if ($("homeNewProject")) {
  $("homeNewProject").onclick = () => void homeAction("new");
  $("homeOpenProject").onclick = () => void homeAction("open");
}
// Phase 2.3: Settings. A single dialog reachable from Home, the native File
// menu (Ctrl+comma on both stages) — values apply live and persist through
// the main process; the dialog always reflects the persisted state.
function renderSettingsDialog() {
  $("settingsTimelineSnap").checked = appSettings.timelineSnap;
  $("settingsRecoveryCopies").checked = appSettings.recoveryCopies;
  $("settingsMaxRecents").value = appSettings.maxRecents;
}
async function refreshAbout() {
  try {
    const info = await desktop.appInfo();
    $("aboutName").textContent = info.name;
    $("aboutVersion").textContent = "Version " + info.version;
    return info;
  } catch {
    $("aboutVersion").textContent = "";
    return null;
  }
}
function openSettingsDialog() {
  if ($("settingsDialog").open) return;
  renderSettingsDialog();
  void refreshAbout();
  $("settingsDialog").showModal();
}
function applyPreferences() {
  timeline.setSnap(appSettings.timelineSnap);
  $("timelineSnap").setAttribute(
    "aria-pressed",
    String(appSettings.timelineSnap),
  );
}
async function changeSetting(key, value) {
  try {
    const previousMax = appSettings.maxRecents;
    appSettings = await desktop.setSetting(key, value);
    applyPreferences();
    updateRecovery();
    // Runs for every change: while the preference is on it arms (or clears)
    // recovery immediately, so enabling it on a dirty project resumes
    // autosave without waiting for another edit; disable() inside
    // updateRecovery cancels any pending autosave first.
    scheduleRecovery();
    $("settingsStatus").textContent =
      key === "maxRecents" && value < previousMax
        ? "Saved · the recents list was trimmed."
        : "Saved.";
    if (key === "maxRecents") void renderRecents();
  } catch (error) {
    // Show the failure and fall back to the persisted state.
    $("settingsStatus").textContent = errorMessage(error) || "Not saved.";
    // A failure triggered from the toolbar (dialog closed) must still be
    // surfaced in the editor.
    if (!$("settingsDialog").open)
      toast(errorMessage(error) || "The preference was not saved.");
  }
  renderSettingsDialog();
}
$("homeSettings").onclick = () => openSettingsDialog();
$("settingsTimelineSnap").onchange = () =>
  void changeSetting("timelineSnap", $("settingsTimelineSnap").checked);
$("settingsRecoveryCopies").onchange = () =>
  void changeSetting("recoveryCopies", $("settingsRecoveryCopies").checked);
$("settingsMaxRecents").onchange = () => {
  const value = $("settingsMaxRecents").valueAsNumber;
  if (Number.isInteger(value)) void changeSetting("maxRecents", value);
  else {
    $("settingsStatus").textContent =
      "Enter a whole number between 1 and 20.";
    $("settingsMaxRecents").value = appSettings.maxRecents;
  }
};
$("settingsReset").onclick = async () => {
  try {
    appSettings = await desktop.resetSettings();
    renderSettingsDialog();
    applyPreferences();
    updateRecovery();
    // Same transition semantics as changeSetting: enabling recovery for a
    // dirty project resumes autosave immediately.
    scheduleRecovery();
    $("settingsStatus").textContent = "Defaults restored.";
  } catch (error) {
    $("settingsStatus").textContent =
      errorMessage(error) || "Could not restore defaults.";
  }
};
// Recent Projects: the persisted list lives in the main process and only
// records projects that were actually opened or saved. Home renders it,
// reopens entries directly, and removes entries — the project file itself
// is never touched by removal.
let recentEntries = [];
async function renderRecents() {
  const list = $("homeRecents");
  if (!list) return;
  try {
    recentEntries = (await desktop.listRecents()) || [];
  } catch {
    // A persistence hiccup must not break Home; keep whatever rendered last.
    if (recentEntries.length === 0) return;
  }
  list.replaceChildren();
  for (const entry of recentEntries) {
    const item = document.createElement("li");
    item.className = "recent-item" + (entry.missing ? " missing" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent-open";
    open.disabled = fileBusy || booting;
    open.setAttribute(
      "aria-label",
      (entry.missing ? "Missing project " : "Open recent project ") +
        entry.name,
    );
    const title = document.createElement("strong");
    title.textContent = entry.name;
    const detail = document.createElement("span");
    detail.className = "recent-path";
    detail.textContent = entry.path;
    open.append(title, detail);
    open.onclick = () => void openRecentProject(entry.path);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recent-remove";
    remove.disabled = fileBusy || booting;
    remove.setAttribute(
      "aria-label",
      "Remove " + entry.name + " from recent projects",
    );
    remove.title = "Remove from Recents";
    remove.innerHTML = '<svg><use href="#i-close" /></svg>';
    remove.onclick = () => void removeRecentEntry(entry.path);
    item.append(open, remove);
    list.append(item);
  }
  list.hidden = recentEntries.length === 0;
  const empty = $("homeRecentsEmpty");
  empty.hidden = recentEntries.length > 0;
}
async function openRecentProject(recentPath) {
  const done = await runFile(async () => {
    if (!(await guardUnsaved())) return false;
    const loaded = await desktop.openRecentProject(recentPath);
    if (!loaded) return false;
    await adoptLoadedProject(loaded);
    current = 2;
    return true;
  });
  if (done && onHome()) enterEditor();
  else if (!done) await renderRecents();
}
async function removeRecentEntry(recentPath) {
  try {
    await desktop.removeRecent(recentPath);
  } catch (error) {
    toast(errorMessage(error));
  }
  await renderRecents();
}
for (const button of document.querySelectorAll(".close-dialog"))
  button.onclick = () => button.closest("dialog").close();
function openModal(id) {
  $(id).showModal();
}
function openSourceDialog() {
  $("shareCode").value = store.source;
  $("shareDialog").showModal();
}
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

async function clearRecoveryAfterAdoption() {
  try {
    await desktop.clearRecovery();
    recoveryUnusable = false;
    updateRecovery();
    return true;
  } catch (error) {
    recoveryUnusable = true;
    updateRecovery();
    toast(
      "The project is intact. Old recovery could not be removed; automatic recovery is paused.",
    );
    return false;
  }
}
async function saveSnapshot(saveAs = false) {
  const snapshot = store.serialize(),
    result = await desktop.saveProject(snapshot, saveAs);
  if (!result) return false;
  fileName = result.name;
  filePath = result.path;
  store.markSaved(snapshot);
  cancelAutosave();
  const cleared = !store.dirty ? await clearRecoveryAfterAdoption() : true;
  if (store.dirty) scheduleRecovery();
  $("saveStatus").textContent = store.dirty
    ? "Saved version · newer changes remain"
    : cleared
      ? "Project saved locally"
      : "Project saved · recovery cleanup failed; autosave paused";
  if (cleared) toast("Saved " + fileName);
  return true;
}
async function guardUnsaved() {
  if (!store.dirty) return true;
  const response = await desktop.confirmUnsaved();
  if (response === "cancel") return false;
  if (response === "save") return (await saveSnapshot()) && !store.dirty;
  return true;
}
// Adopting a project loaded by the main process (Open dialog or Recents):
// the document is taken in before any fallible cleanup, mirroring the
// recovery-restore ordering.
async function adoptLoadedProject(loaded) {
  cancelAutosave();
  fileName = loaded.name;
  filePath = loaded.path;
  store.load(loaded.project);
  imageCache.clearAll();
  const cleared = await clearRecoveryAfterAdoption();
  $("saveStatus").textContent = cleared
    ? "Project opened locally"
    : "Project opened · recovery cleanup failed; autosave paused";
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
      await adoptLoadedProject(loaded);
    } else if (command === "new") {
      cancelAutosave();
      await desktop.newProject();
      fileName = "Untitled.framecode.json";
      filePath = null;
      store.load({ source: DEFAULT_SOURCE, lastValid: DEFAULT_SOURCE });
      imageCache.clearAll();
      const cleared = await clearRecoveryAfterAdoption();
      $("saveStatus").textContent = cleared
        ? "New local project"
        : "New project · recovery cleanup failed; autosave paused";
    } else if (command === "close") {
      cancelAutosave();
      await clearRecoveryAfterAdoption();
      await desktop.setDirty(false, store.model.name);
      await desktop.finishClose();
      return true;
    }
    current = 2;
    return true;
  });
}

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
    const target = store.model.clips.find((c) => c.id === store.selected);
    if (
      target?.locked &&
      ["split", "cut", "duplicate", "delete", "timing"].includes(
        button.dataset.command,
      )
    )
      button.disabled = true;
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
    if (["new", "open", "save", "saveAs", "close"].includes(name)) {
      const done = await fileCommand(name);
      // The native File menu is available on the Home screen too; a
      // successful New/Open there must enter the editor just like the
      // Home actions do.
      if (done && (name === "new" || name === "open") && onHome())
        enterEditor();
      return done;
    }
    if (name === "codePanel") {
      setCodePanel(!codeOpen);
      return;
    }
    if (name === "templates") {
      openModal("templatesDialog");
      return;
    }
    if (name === "settings") {
      openSettingsDialog();
      return;
    }
    if (name === "source") {
      // The removed header button was disabled while the source could not
      // be shared; the menu command keeps that contract.
      if (!store.error && !fileBusy) openSourceDialog();
      return;
    }
    if (name === "importImage") {
      await runImportImage();
      return;
    }
    if (name === "reset") {
      $("reset").click();
      return;
    }
    if (name.startsWith("template:")) {
      const template = TEMPLATES.find((t) => t.name === name.slice(9));
      if (!template) return;
      setPlaying(false);
      commit(template.source, "Load template", null);
      current = 2;
      toast("Template loaded. Undo restores the previous composition.");
      return;
    }
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
      commit(
        deleteClips(store.source, store.selectedIds),
        "Delete selected clips",
        null,
      );
  } catch (error) {
    toast(errorMessage(error));
    scheduleRender();
  }
}
desktop.onCommand((name) => void command(name));
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (onHome()) return; // editor shortcuts only; native menu accelerators still reach fileCommand
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void command(event.shiftKey ? "saveAs" : "save");
    return;
  }
  // The Run button advertises Ctrl+Enter (aria-keyshortcuts and keyhint);
  // this binding is what makes that claim true, in the editor stage.
  if (modifier && event.key === "Enter") {
    event.preventDefault();
    $("run").click();
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
      e: "codePanel",
    };
    if (keys[event.key.toLowerCase()]) {
      event.preventDefault();
      void command(keys[event.key.toLowerCase()]);
      return;
    }
  }
  if (!editing() && !modifier && [",", "."].includes(event.key)) {
    event.preventDefault();
    stepFrame(event.key === "." ? 1 : -1);
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
  // Preferences load before anything that consumes them; a persistence
  // problem must leave the app on safe defaults, never block the launch.
  try {
    appSettings = await desktop.getSettings();
  } catch {
    appSettings = {
      timelineSnap: true,
      recoveryCopies: true,
      maxRecents: 10,
    };
  }
  updateRecovery();
  applyPreferences();
  void refreshAbout().then((info) => {
    if (info) $("homeVersion").textContent = "v" + info.version;
  });
  try {
    const recovery = await desktop.readRecovery();
    if (recovery) {
      await new Promise((resolve) => {
        $("recoveryDialog").addEventListener("cancel", (event) =>
          event.preventDefault(),
        );
        $("restoreRecovery").onclick = async () => {
          store.load(recovery, { dirty: true });
          imageCache.clearAll();
          $("recoveryDialog").close();
          $("saveStatus").textContent =
            "Recovered draft · save as a new project";
          enterEditor();
          resolve();
          // Authorization is granted only by the main process through a
          // native consent dialog; evicting prior failed entries lets
          // restored images actually load and render.
          try {
            const relink = await desktop.relinkRecoveryAssets();
            for (const granted of relink?.authorized || [])
              imageCache.evict(granted);
            if (relink?.authorized?.length) render();
          } catch {
            // Relink is best-effort; the draft stays usable without images.
          }
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
    recoveryUnusable = true;
    updateRecovery();
    toast(
      "Recovery could not be read. Save manually; the old recovery file has been preserved.",
    );
    $("saveStatus").textContent = "Recovery unavailable · save manually";
  }
  booting = false;
  render();
  void renderRecents();
  scheduleRecovery();
  document.body.dataset.ready = "true";
}
render();
// Recent Projects render as soon as Home is visible; boot() refreshes the
// list once the ready state settles.
void renderRecents();
// Report the stage only now that the renderer module is fully wired: the
// native window title is applied from this report, so an externally
// visible "Framecode" title doubles as proof that the packaged renderer
// actually booted.
desktop.setStage(document.body.dataset.stage).catch(() => {});
void boot();
