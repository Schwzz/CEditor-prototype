import {
  compile,
  DEFAULT_SOURCE,
  TEMPLATES,
  replaceParam,
  replaceTiming,
  encodeTemplate,
  decodeTemplate,
  visibleClips,
} from "./engine.mjs";
const $ = (id) => document.getElementById(id),
  source = $("source"),
  canvas = $("canvas"),
  ctx = canvas.getContext("2d");
const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
let model = compile(DEFAULT_SOURCE),
  lastValid = DEFAULT_SOURCE,
  current = 2,
  playing = false,
  loop = true,
  selected = null,
  debounce,
  shareSnapshot = "",
  undoSource = null,
  toastTimer,
  valid = true,
  remix = false;
let initialSource = DEFAULT_SOURCE;
try {
  const saved = JSON.parse(
    localStorage.getItem("framecode.draft.v1") || "null",
  );
  if (saved?.source) {
    initialSource = saved.source;
    try {
      model = compile(saved.lastValid || saved.source);
      lastValid = saved.lastValid || saved.source;
    } catch {}
  }
  const shared = decodeTemplate(location.hash);
  if (shared) {
    initialSource = shared;
    remix = true;
    history.replaceState(null, "", location.pathname);
  }
} catch (e) {
  if (location.hash)
    toast("This template link could not be loaded. The example is ready.");
}
source.value = initialSource;
const colors = {
  scene: { bg: "#344337", border: "#52664b", text: "#bed2af" },
  text: { bg: "#343447", border: "#5d5978", text: "#c2b9e1" },
  shape: { bg: "#4a3c2a", border: "#77623c", text: "#ddc69d" },
};
function highlight() {
  const scroll = source.scrollTop,
    left = source.scrollLeft;
  const lines = source.value.split("\n");
  $("highlight").innerHTML = lines
    .map((line, i) => {
      const pattern =
        /(\/\/.*$)|("(?:\\.|[^"\\])*")|(\$\w+)|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z]+(?=\())/g;
      let out = "",
        start = 0;
      for (const m of line.matchAll(pattern)) {
        out += escapeHTML(line.slice(start, m.index));
        const cls = m[1]
          ? "comment"
          : m[2]
            ? "string"
            : m[3]
              ? "param"
              : m[4]
                ? "number"
                : "fn";
        out += `<span class="tok-${cls}">${escapeHTML(m[0])}</span>`;
        start = m.index + m[0].length;
      }
      out += escapeHTML(line.slice(start));
      return `<span class="code-line${model.clips.find((c) => c.id === selected)?.line === i ? " selected" : ""}">${out || " "}</span>`;
    })
    .join("");
  $("lineNumbers").innerHTML = lines
    .map(
      (_, i) =>
        `<span${model.clips.find((c) => c.id === selected)?.line === i ? ' class="selected"' : ""}>${i + 1}</span>`,
    )
    .join("\n");
  $("lineCount").textContent = `${lines.length} lines`;
  $("highlight").scrollTop = scroll;
  $("highlight").scrollLeft = left;
  $("lineNumbers").scrollTop = scroll;
}
source.addEventListener("scroll", () => {
  $("highlight").scrollTop = source.scrollTop;
  $("highlight").scrollLeft = source.scrollLeft;
  $("lineNumbers").scrollTop = source.scrollTop;
});
function persist() {
  try {
    localStorage.setItem(
      "framecode.draft.v1",
      JSON.stringify({ source: source.value, lastValid }),
    );
    $("saveStatus").textContent = remix
      ? "Editable copy · saved on this device"
      : "Draft saved on this device";
  } catch {
    $("saveStatus").textContent = "Draft is in this tab only";
  }
}
function setCode(value, { isRemix = false, remember = false } = {}) {
  if (remember) undoSource = source.value;
  source.value = value;
  remix = isRemix;
  current = Math.min(current, 12);
  run();
}
function run() {
  clearTimeout(debounce);
  try {
    const next = compile(source.value);
    model = next;
    lastValid = source.value;
    valid = true;
    current = Math.min(current, model.duration);
    if (selected && !model.clips.some((c) => c.id === selected))
      selected = null;
    $("error").hidden = true;
    $("compileStatus").innerHTML =
      '<span class="status-dot"></span>Live · changes run automatically';
    $("compileStatus").parentElement.classList.remove("error-status");
    $("projectName").textContent = model.name;
    $("previewLabel").textContent = model.name.toUpperCase();
    $("draftBadge").textContent = remix
      ? "YOUR EDITABLE COPY"
      : "EXPERIMENT 001";
    $("openShare").disabled = false;
    renderParams();
    renderTimeline();
    renderSelection();
    updateTime();
  } catch (e) {
    valid = false;
    $("error").hidden = false;
    $("error").textContent =
      `Line ${e.line || 1}: ${e.message} Last valid preview is still shown.`;
    $("compileStatus").innerHTML =
      '<span class="status-dot"></span>Check your code';
    $("compileStatus").parentElement.classList.add("error-status");
    $("openShare").disabled = true;
    $("timelineStatus").textContent = "Showing the last valid composition";
    document
      .querySelectorAll("#params input,#selectionCard input")
      .forEach((el) => (el.disabled = true));
  }
  highlight();
  persist();
  draw();
}
source.addEventListener("input", () => {
  highlight();
  clearTimeout(debounce);
  $("compileStatus").innerHTML = '<span class="status-dot"></span>Updating…';
  debounce = setTimeout(run, 350);
});
source.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    source.setRangeText(
      "  ",
      source.selectionStart,
      source.selectionEnd,
      "end",
    );
    source.dispatchEvent(new Event("input"));
  }
});
function selectSourceLine() {
  if (!valid) return;
  const line =
    source.value.slice(0, source.selectionStart).split("\n").length - 1;
  selectClip(model.clips.find((clip) => clip.line === line)?.id || null);
}
source.addEventListener("click", selectSourceLine);
source.addEventListener("keyup", (event) => {
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
    selectSourceLine();
});
$("run").onclick = () => {
  run();
  if (valid) toast("Composition is up to date.");
};
function renderParams() {
  const signature = Object.entries(model.params)
    .map(
      ([key, val]) =>
        key +
        ":" +
        typeof val +
        ":" +
        (/^#[0-9a-f]{6}$/i.test(val) ? "color" : "plain"),
    )
    .join("|");
  if ($("params").dataset.signature !== signature) {
    $("params").dataset.signature = signature;
    $("params").replaceChildren();
    for (const [key, value] of Object.entries(model.params)) {
      const row = document.createElement("div");
      row.className = "parameter";
      row.dataset.key = key;
      const label = document.createElement("label");
      label.htmlFor = "param-" + key;
      label.append(document.createTextNode(key));
      const hint = document.createElement("code");
      hint.textContent = typeof value === "number" ? `${value}×` : "$" + key;
      hint.dataset.hint = key;
      label.append(hint);
      row.append(label);
      let input = document.createElement("input");
      input.id = "param-" + key;
      input.dataset.param = key;
      input.setAttribute("aria-label", key + " template parameter");
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        const group = document.createElement("div");
        group.className = "color-input";
        input.type = "color";
        input.value = value;
        const hex = document.createElement("input");
        hex.type = "text";
        hex.value = value;
        hex.dataset.hex = key;
        hex.maxLength = 7;
        hex.setAttribute("aria-label", key + " hex color");
        hex.addEventListener("change", () => changeParam(key, hex.value));
        group.append(input, hex);
        row.append(group);
      } else if (typeof value === "number") {
        input.type = key === "tempo" ? "range" : "number";
        input.step = key === "tempo" ? "0.1" : "0.1";
        if (key === "tempo") {
          input.min = "0.2";
          input.max = "3";
        }
        input.value = value;
        row.append(input);
      } else {
        input.type = "text";
        input.value = value;
        row.append(input);
      }
      input.addEventListener("input", () =>
        changeParam(
          key,
          typeof value === "number" ? Number(input.value) : input.value,
        ),
      );
      $("params").append(row);
    }
  }
  for (const input of $("params").querySelectorAll("input")) {
    input.disabled = false;
    const key = input.dataset.param || input.dataset.hex;
    if (document.activeElement !== input) input.value = model.params[key];
  }
  for (const hint of $("params").querySelectorAll("[data-hint]")) {
    if (typeof model.params[hint.dataset.hint] === "number")
      hint.textContent = model.params[hint.dataset.hint] + "×";
  }
}
function changeParam(key, value) {
  if (!valid) return;
  try {
    source.value = replaceParam(source.value, key, value);
    run();
  } catch (e) {
    toast(e.message);
  }
}
function renderTimeline() {
  const ticks = [];
  const step = model.duration <= 16 ? 2 : Math.ceil(model.duration / 8);
  for (let i = 0; i <= model.duration; i += step) {
    ticks.push(
      `<span class="ruler-tick" style="left:${(i / model.duration) * 100}%">${i === model.duration ? "" : String(i).padStart(2, "0")}</span>`,
    );
  }
  $("ruler").innerHTML = ticks.join("");
  $("tracks").replaceChildren();
  for (const c of model.clips) {
    const color = colors[c.type],
      row = document.createElement("div");
    row.className = "track-row";
    const label = document.createElement("div");
    label.className = "track-label";
    label.style.setProperty("--track-color", color.text);
    label.innerHTML = '<span class="track-dot"></span>';
    label.append(document.createTextNode(c.id));
    label.title = c.id;
    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.style.backgroundSize = 100 / (model.duration / step) + "% 100%";
    const clip = document.createElement("button");
    clip.className = "clip" + (c.id === selected ? " selected" : "");
    clip.dataset.clip = c.id;
    clip.style.cssText = `left:${(c.at / model.duration) * 100}%;width:${(c.for / model.duration) * 100}%;--clip-bg:${color.bg};--clip-border:${color.border};--clip-text:${color.text}`;
    clip.setAttribute(
      "aria-label",
      `${c.id}, starts at ${c.at} seconds, lasts ${c.for} seconds`,
    );
    clip.title = `${c.id} · ${c.at}s → ${+(c.at + c.for).toFixed(2)}s`;
    const name = document.createElement("span");
    name.textContent = c.type === "text" ? c.value : c.id;
    const type = document.createElement("span");
    type.className = "clip-type";
    type.textContent = c.type;
    clip.append(name, type);
    clip.addEventListener("pointerdown", (e) => startDrag(e, c, clip, lane));
    clip.addEventListener("click", () => selectClip(c.id));
    clip.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (!valid) return;
        const next = Math.max(
          0,
          Math.min(
            model.duration - c.for,
            c.at + (e.key === "ArrowRight" ? 0.1 : -0.1),
          ),
        );
        updateTiming(c.id, "at", next);
      }
    });
    lane.addEventListener("pointerdown", (e) => {
      if (e.target === lane) seekAt(e, lane);
    });
    lane.append(clip);
    row.append(label, lane);
    $("tracks").append(row);
  }
  $("clipCount").textContent = model.clips.length + " clips";
  $("durationLabel").textContent = model.duration.toFixed(1) + "s";
  $("timelineStatus").textContent = "Code and timeline are in sync";
  $("seek").max = model.duration;
  requestAnimationFrame(updatePlayhead);
}
function selectClip(id) {
  selected = id;
  const c = model.clips.find((c) => c.id === id);
  document
    .querySelectorAll(".clip")
    .forEach((el) => el.classList.toggle("selected", el.dataset.clip === id));
  renderSelection();
  highlight();
  if (c) {
    const size = parseFloat(getComputedStyle(source).lineHeight);
    const visibleTop = source.scrollTop,
      visibleBottom = visibleTop + source.clientHeight;
    if (c.line * size < visibleTop || c.line * size > visibleBottom - size) {
      source.scrollTop = Math.max(0, (c.line - 3) * size);
      source.dispatchEvent(new Event("scroll"));
    }
  }
}
function renderSelection() {
  const c = model.clips.find((c) => c.id === selected);
  $("selectionCard").hidden = !c;
  if (!c) return;
  $("selectedName").textContent = c.id;
  $("clipStart").value = +c.at.toFixed(2);
  $("clipDuration").value = +c.for.toFixed(2);
  $("clipStart").max = +(model.duration - c.for).toFixed(2);
  $("clipDuration").max = +(model.duration - c.at).toFixed(2);
  $("clipStart").disabled = !valid;
  $("clipDuration").disabled = !valid;
}
$("clearSelection").onclick = () => selectClip(null);
function updateTiming(id, key, value) {
  try {
    const restoreFocus = document.activeElement?.classList.contains("clip");
    source.value = replaceTiming(source.value, id, key, value);
    run();
    if (restoreFocus) {
      [...document.querySelectorAll(".clip")]
        .find((clip) => clip.dataset.clip === id)
        ?.focus();
    }
  } catch (e) {
    toast(e.message);
    renderSelection();
  }
}
$("clipStart").onchange = () =>
  updateTiming(selected, "at", Number($("clipStart").value));
$("clipDuration").onchange = () =>
  updateTiming(selected, "for", Number($("clipDuration").value));
function startDrag(e, clip, button, lane) {
  if (e.button !== 0) return;
  selectClip(clip.id);
  if (!valid) return;
  const startX = e.clientX,
    rect = lane.getBoundingClientRect(),
    original = clip.at;
  let proposed = original,
    moved = false;
  button.setPointerCapture(e.pointerId);
  const move = (event) => {
    const delta = ((event.clientX - startX) / rect.width) * model.duration;
    if (Math.abs(event.clientX - startX) > 3) moved = true;
    proposed = Math.min(
      model.duration - clip.for,
      Math.round(
        Math.max(0, Math.min(model.duration - clip.for, original + delta)) * 10,
      ) / 10,
    );
    button.style.left = (proposed / model.duration) * 100 + "%";
    $("timelineStatus").textContent =
      `${clip.id} starts at ${proposed.toFixed(1)}s`;
  };
  const end = () => {
    button.removeEventListener("pointermove", move);
    button.removeEventListener("pointerup", end);
    button.removeEventListener("pointercancel", cancel);
    if (moved) updateTiming(clip.id, "at", proposed);
    else $("timelineStatus").textContent = "Code and timeline are in sync";
  };
  const cancel = () => {
    moved = false;
    button.style.left = (original / model.duration) * 100 + "%";
    end();
  };
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerup", end, { once: true });
  button.addEventListener("pointercancel", cancel, { once: true });
}
function seekAt(e, el) {
  const rect = el.getBoundingClientRect();
  current = Math.max(
    0,
    Math.min(
      model.duration,
      ((e.clientX - rect.left) / rect.width) * model.duration,
    ),
  );
  updateTime();
  draw();
}
$("ruler").addEventListener("pointerdown", (e) => {
  seekAt(e, $("ruler"));
  $("ruler").setPointerCapture(e.pointerId);
  const move = (ev) => seekAt(ev, $("ruler"));
  $("ruler").addEventListener("pointermove", move);
  $("ruler").addEventListener(
    "pointerup",
    () => {
      $("ruler").removeEventListener("pointermove", move);
    },
    { once: true },
  );
});
$("seek").oninput = () => {
  current = Number($("seek").value);
  updateTime();
  draw();
};
function formatTime(time) {
  return (
    String(Math.floor(time / 60)).padStart(2, "0") +
    ":" +
    String(Math.floor(time % 60)).padStart(2, "0") +
    "." +
    String(Math.floor((time % 1) * 100)).padStart(2, "0")
  );
}
function updatePlayhead() {
  const ruler = $("ruler");
  $("playhead").style.left =
    ruler.offsetLeft + (current / model.duration) * ruler.clientWidth + "px";
}
function updateTime() {
  $("currentTime").textContent = formatTime(current);
  $("totalTime").textContent = formatTime(model.duration);
  $("seek").value = current;
  updatePlayhead();
}
function setPlaying(value) {
  playing = value;
  $("play").innerHTML = icon(playing ? "pause" : "play");
  $("play").setAttribute(
    "aria-label",
    playing ? "Pause preview" : "Play preview",
  );
  $("pausedChip").hidden = playing;
}
$("play").onclick = () => {
  if (current >= model.duration) current = 0;
  setPlaying(!playing);
};
$("restart").onclick = () => {
  current = 0;
  updateTime();
  draw();
};
$("loop").onclick = () => {
  loop = !loop;
  $("loop").classList.toggle("active", loop);
  $("loop").setAttribute("aria-pressed", loop);
};
function toast(message, withUndo = false) {
  clearTimeout(toastTimer);
  $("toastMessage").textContent = message;
  $("undo").hidden = !withUndo;
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => {
      $("toast").hidden = true;
    },
    withUndo ? 10000 : 4000,
  );
}
$("undo").onclick = () => {
  if (undoSource !== null) {
    const s = undoSource;
    undoSource = null;
    setCode(s);
    toast("Previous composition restored.");
  }
};
$("reset").onclick = () => {
  setCode(DEFAULT_SOURCE, { remember: true });
  current = 2;
  setPlaying(false);
  updateTime();
  draw();
  toast("Original example restored.", true);
};
for (const close of document.querySelectorAll(".close-dialog"))
  close.onclick = () => close.closest("dialog").close();
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        dialog.close();
    }
  });
$("openHelp").onclick = () => $("helpDialog").showModal();
$("openTemplates").onclick = () => $("templatesDialog").showModal();
for (const t of TEMPLATES) {
  const card = document.createElement("button");
  card.className = "gallery-card";
  card.setAttribute("aria-label", "Remix " + t.name);
  card.innerHTML = `<div class="gallery-art ${t.kind}"><span>${escapeHTML(compile(t.source).params.title)}</span></div><div class="gallery-info"><strong>${escapeHTML(t.name)}</strong><p>${escapeHTML(t.description)}</p><span class="remix-label">Remix this template ${icon("arrow")}</span></div>`;
  card.onclick = () => {
    setCode(t.source, { isRemix: true, remember: true });
    current = 2;
    setPlaying(false);
    updateTime();
    draw();
    $("templatesDialog").close();
    toast(`“${t.name}” is now your editable copy.`, true);
  };
  $("templateGallery").append(card);
}
$("openShare").onclick = () => {
  run();
  if (!valid) return;
  shareSnapshot = source.value;
  $("shareCode").value = shareSnapshot;
  $("shareName").textContent = model.name;
  $("shareDetails").textContent =
    `${Object.keys(model.params).length} controls · ${model.duration}s · ${model.clips.length} clips`;
  $("shareDialog").showModal();
};
async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    (document.querySelector("dialog[open]") || document.body).append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    toast(
      ok
        ? message
        : "Copy is unavailable. Select and copy the template source.",
    );
  }
}
$("copyCode").onclick = () => copy(shareSnapshot, "Template code copied.");
$("copyLink").onclick = () =>
  copy(
    location.origin +
      location.pathname +
      "#template=" +
      encodeTemplate(shareSnapshot),
    "Private remix link copied.",
  );
$("remixSnapshot").onclick = () => {
  setCode(shareSnapshot, { isRemix: true, remember: true });
  $("shareDialog").close();
  toast("You’re editing a copy. Change a control to make it yours.", true);
};
document.addEventListener("keydown", (e) => {
  const editing = ["INPUT", "TEXTAREA"].includes(
    document.activeElement?.tagName,
  );
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    run();
  }
  if (
    e.code === "Space" &&
    !editing &&
    !document.querySelector("dialog[open]") &&
    document.activeElement?.tagName !== "BUTTON"
  ) {
    e.preventDefault();
    if (current >= model.duration) current = 0;
    setPlaying(!playing);
  }
});
new ResizeObserver(updatePlayhead).observe($("timeline"));
function ease(v) {
  v = Math.max(0, Math.min(1, v));
  return 1 - Math.pow(1 - v, 3);
}
function wrapText(text, maxWidth, font) {
  ctx.font = font;
  const words = String(text).slice(0, 300).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}
function draw() {
  const W = 1920,
    H = 1080,
    active = visibleClips(model, current),
    scene = active.find((c) => c.type === "scene"),
    signal = active.find((c) => c.type === "shape"),
    accent = signal?.color || model.params.accent || "#d6fa69",
    tempo = Number(model.params.tempo) || 1,
    phase = current * tempo,
    look = scene?.look || "orbit";
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = scene
    ? look === "pulse"
      ? "#2a1e29"
      : look === "grid"
        ? "#142137"
        : "#e9e7dc"
    : "#171b18";
  ctx.fillRect(0, 0, W, H);
  const light = look === "orbit",
    ink = light ? "#202822" : "#e7eadf";
  if (scene) {
    ctx.save();
    ctx.strokeStyle = light ? "#20282220" : "#b0c8b71c";
    ctx.lineWidth = 2;
    if (look === "grid") {
      for (let x = 0; x < W; x += 90) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y < H; y += 90) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(80, 160);
      ctx.lineTo(1840, 160);
      ctx.moveTo(80, 942);
      ctx.lineTo(1840, 942);
      ctx.stroke();
    }
    ctx.fillStyle = ink;
    ctx.font = "23px monospace";
    ctx.fillText("FRAMECODE", 85, 107);
    ctx.textAlign = "right";
    ctx.fillText("A STUDY IN MOTION / 001", 1835, 107);
    ctx.fillStyle = light ? "#647265" : "#9aadab";
    ctx.font = "18px monospace";
    ctx.fillText("CODE → FORM → FEELING", 1835, 996);
    ctx.textAlign = "left";
    ctx.fillText(
      String(Math.floor(current * 30)).padStart(4, "0") +
        " / " +
        String(Math.round(model.duration * 30)).padStart(4, "0"),
      85,
      996,
    );
    ctx.restore();
  }
  if (signal) {
    const elapsed = current - signal.at,
      alpha =
        signal.motion === "none"
          ? 1
          : ease(elapsed / 0.6) *
            Math.min(1, (signal.at + signal.for - current) / 0.5);
    ctx.save();
    ctx.globalAlpha = alpha;
    const cx = 1380,
      cy = 548,
      rotation = signal.motion === "none" ? -0.32 : -0.32 + phase * 0.15,
      pulse =
        signal.motion === "pulse" || look === "pulse"
          ? 1 + Math.sin(phase * 2.5) * 0.08
          : 1;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(pulse, pulse);
    if (look === "grid") {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 11;
      for (let i = 0; i < 6; i++) {
        ctx.save();
        ctx.rotate(i * 0.23 + (signal.motion === "none" ? 0 : phase * 0.1));
        ctx.strokeRect(
          -210 - i * 18,
          -210 - i * 18,
          420 + i * 36,
          420 + i * 36,
        );
        ctx.restore();
      }
    } else {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 70;
      ctx.beginPath();
      ctx.ellipse(0, 0, 300, 300, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = light ? "#1b2922" : accent;
      ctx.lineWidth = 3;
      for (let i = 0; i < 10; i++) {
        ctx.beginPath();
        ctx.ellipse(
          0,
          0,
          90 + i * 23,
          260 + i * 10,
          Math.PI * 0.22,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
      ctx.fillStyle = accent;
      ctx.beginPath();
      const p = signal.motion === "none" ? 1 : phase * 0.85;
      ctx.arc(Math.cos(p) * 305, Math.sin(p) * 305, 51, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = light ? "#202822" : ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = light ? "#253428" : ink;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  for (const text of active.filter((c) => c.type === "text")) {
    const elapsed = current - text.at,
      remaining = text.at + text.for - current,
      animate = text.motion !== "none",
      progress = animate ? ease(elapsed / 0.7) : 1;
    ctx.save();
    ctx.globalAlpha = animate ? progress * Math.min(1, remaining / 0.4) : 1;
    ctx.fillStyle = ink;
    const bottom = text.place === "bottom",
      center = text.place === "center";
    let x = center ? 960 : 95,
      y = bottom ? 864 : center ? 470 : 343;
    let size = bottom ? 32 : 138;
    const font = (bottom ? "400 " : "800 ") + size + "px Arial, sans-serif";
    const maxWidth = center ? 1550 : bottom ? 1700 : 820;
    const lines = wrapText(text.value, maxWidth, font);
    ctx.font = font;
    ctx.textAlign = center ? "center" : "left";
    if (text.motion === "rise") y += (1 - progress) * 75;
    if (text.motion === "orbit") {
      x += Math.sin(phase) * 20;
      y += Math.cos(phase) * 20;
    }
    if (text.motion === "pulse")
      ctx.globalAlpha *= 0.7 + 0.3 * Math.sin(phase * 3) ** 2;
    for (let i = 0; i < lines.length; i++)
      ctx.fillText(lines[i], x, y + i * size * 1.02, maxWidth);
    ctx.restore();
  }
}
let previous = performance.now();
function frame(now) {
  const delta = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  if (playing && !document.hidden) {
    current += delta;
    if (current >= model.duration) {
      if (loop) current %= model.duration;
      else {
        current = model.duration;
        setPlaying(false);
      }
    }
    updateTime();
    draw();
  }
  requestAnimationFrame(frame);
}
renderParams();
renderTimeline();
renderSelection();
updateTime();
run();
if (remix) toast("Shared template loaded as your own editable copy.");
requestAnimationFrame(frame);
