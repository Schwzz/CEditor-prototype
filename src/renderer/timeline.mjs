import { compile } from "../core/engine.mjs";
import { updateClip, resizeClip, timingBounds } from "../core/operations.mjs";

const colors = {
  scene: ["#344337", "#52664b", "#bed2af"],
  text: ["#343447", "#5d5978", "#c2b9e1"],
  shape: ["#4a3c2a", "#77623c", "#ddc69d"],
};
export function createTimeline({
  store,
  ruler,
  tracks,
  playhead,
  getTime,
  onSeek,
  onSelect,
  onCommit,
  onPreview,
  onPause,
  onContext,
  onError,
}) {
  let cancelGesture = null;
  function setPlayhead() {
    playhead.style.left =
      ruler.offsetLeft +
      (getTime() / store.model.duration) * ruler.clientWidth +
      "px";
    ruler.setAttribute("aria-valuenow", getTime().toFixed(2));
  }
  function seek(event) {
    const rect = ruler.getBoundingClientRect();
    onSeek(
      Math.max(
        0,
        Math.min(
          store.model.duration,
          ((event.clientX - rect.left) / rect.width) * store.model.duration,
        ),
      ),
    );
  }
  ruler.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    seek(event);
    ruler.setPointerCapture(event.pointerId);
    const move = (next) => seek(next);
    const finish = () => {
      ruler.removeEventListener("pointermove", move);
      ruler.removeEventListener("pointerup", finish);
      ruler.removeEventListener("pointercancel", finish);
    };
    ruler.addEventListener("pointermove", move);
    ruler.addEventListener("pointerup", finish);
    ruler.addEventListener("pointercancel", finish);
  });
  ruler.tabIndex = 0;
  ruler.setAttribute("role", "slider");
  ruler.setAttribute("aria-label", "Timeline playhead");
  ruler.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      onSeek(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? store.model.duration
            : Math.max(
                0,
                Math.min(
                  store.model.duration,
                  getTime() + (event.key === "ArrowRight" ? 0.1 : -0.1),
                ),
              ),
      );
    }
  });
  function gesture(event, clip, container, lane, edge) {
    if (event.button !== 0 || store.error) return;
    event.stopPropagation();
    onPause();
    onSelect(clip.id);
    cancelGesture?.();
    const base = store.source,
      start = event.clientX,
      width = lane.clientWidth,
      bounds = timingBounds(clip, store.model.duration),
      target = event.currentTarget;
    let candidate = base,
      moved = false;
    target.setPointerCapture(event.pointerId);
    const move = (next) => {
      if (Math.abs(next.clientX - start) < 3 && !moved) return;
      moved = true;
      const delta = ((next.clientX - start) / width) * store.model.duration,
        round = (value) => Math.round(value * 10) / 10;
      try {
        if (edge === "start")
          candidate = resizeClip(
            base,
            clip.id,
            edge,
            Math.max(
              bounds.startMin,
              Math.min(bounds.startMax, round(clip.at + delta)),
            ),
          );
        else if (edge === "end")
          candidate = resizeClip(
            base,
            clip.id,
            edge,
            Math.max(
              bounds.endMin,
              Math.min(bounds.endMax, round(clip.at + clip.for + delta)),
            ),
          );
        else
          candidate = updateClip(base, clip.id, {
            at: Math.max(
              0,
              Math.min(store.model.duration - clip.for, round(clip.at + delta)),
            ),
          });
        const model = compile(candidate),
          changed = model.clips.find((item) => item.id === clip.id);
        container.style.left = (changed.at / model.duration) * 100 + "%";
        container.style.width = (changed.for / model.duration) * 100 + "%";
        onPreview(model);
      } catch (error) {
        onError(error.message);
      }
    };
    const finish = (cancelled) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      cancelGesture = null;
      if (moved && !cancelled && base === store.source)
        onCommit(candidate, edge ? "Resize clip" : "Move clip");
      else render();
      onPreview(store.model);
    };
    const up = () => finish(false),
      cancel = () => finish(true);
    cancelGesture = cancel;
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
  }
  function render() {
    const active = document.activeElement,
      focusId = active?.dataset.clip,
      focusEdge = active?.dataset.edge;
    const model = store.model,
      step = model.duration <= 16 ? 2 : Math.ceil(model.duration / 8);
    ruler.replaceChildren();
    tracks.replaceChildren();
    for (let time = 0; time < model.duration; time += step) {
      const tick = document.createElement("span");
      tick.className = "ruler-tick";
      tick.style.left = (time / model.duration) * 100 + "%";
      tick.textContent = String(time).padStart(2, "0");
      ruler.append(tick);
    }
    ruler.setAttribute("aria-valuemin", "0");
    ruler.setAttribute("aria-valuemax", model.duration);
    ruler.setAttribute("aria-valuenow", getTime().toFixed(2));
    for (const clip of model.clips) {
      const row = document.createElement("div");
      row.className = "track-row";
      const label = document.createElement("div");
      label.className = "track-label";
      label.textContent = clip.id;
      label.title = clip.id;
      label.style.color = colors[clip.type][2];
      const lane = document.createElement("div");
      lane.className = "track-lane";
      lane.style.backgroundSize = 100 / (model.duration / step) + "% 100%";
      const container = document.createElement("div");
      container.className =
        "clip" + (store.selected === clip.id ? " selected" : "");
      container.dataset.clip = clip.id;
      container.style.cssText = `left:${(clip.at / model.duration) * 100}%;width:${(clip.for / model.duration) * 100}%;--clip-bg:${colors[clip.type][0]};--clip-border:${colors[clip.type][1]};--clip-text:${colors[clip.type][2]}`;
      const body = document.createElement("button");
      body.className = "clip-body";
      body.dataset.clip = clip.id;
      body.setAttribute(
        "aria-label",
        `${clip.id}, starts at ${clip.at} seconds, lasts ${clip.for} seconds`,
      );
      body.setAttribute("aria-pressed", String(store.selected === clip.id));
      body.disabled = !!store.error;
      const name = document.createElement("span");
      name.textContent = clip.type === "text" ? clip.value || clip.id : clip.id;
      const type = document.createElement("span");
      type.className = "clip-type";
      type.textContent = clip.type;
      body.append(name, type);
      body.addEventListener("click", () => onSelect(clip.id));
      body.addEventListener("pointerdown", (event) =>
        gesture(event, clip, container, lane, null),
      );
      body.addEventListener("keydown", (event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          const rect = body.getBoundingClientRect();
          onContext(clip.id, rect.left + 20, rect.bottom, body);
        }
        if (["ArrowLeft", "ArrowRight"].includes(event.key) && !store.error) {
          event.preventDefault();
          onSelect(clip.id);
          onPause();
          try {
            onCommit(
              updateClip(store.source, clip.id, {
                at: Math.max(
                  0,
                  Math.min(
                    model.duration - clip.for,
                    Math.round(
                      (clip.at +
                        (event.key === "ArrowRight" ? 1 : -1) *
                          (event.shiftKey ? 1 : 0.1)) *
                        1000,
                    ) / 1000,
                  ),
                ),
              }),
              "Nudge clip",
            );
          } catch (error) {
            onError(error.message);
          }
        }
      });
      container.append(body);
      for (const edge of ["start", "end"]) {
        const handle = document.createElement("button");
        handle.className = "resize-handle " + edge;
        handle.dataset.clip = clip.id;
        handle.dataset.edge = edge;
        handle.setAttribute("aria-label", `Resize ${clip.id} ${edge}`);
        handle.title = `Drag to change ${edge}`;
        handle.disabled = !!store.error;
        handle.addEventListener("pointerdown", (event) =>
          gesture(event, clip, container, lane, edge),
        );
        handle.addEventListener("keydown", (event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key) && !store.error) {
            event.preventDefault();
            onSelect(clip.id);
            onPause();
            const bounds = timingBounds(clip, model.duration),
              old = edge === "start" ? clip.at : clip.at + clip.for;
            const time = old + (event.key === "ArrowRight" ? 0.1 : -0.1);
            try {
              onCommit(
                resizeClip(
                  store.source,
                  clip.id,
                  edge,
                  Math.max(
                    bounds[edge + "Min"],
                    Math.min(
                      bounds[edge + "Max"],
                      Math.round(time * 1000) / 1000,
                    ),
                  ),
                ),
                "Resize clip",
              );
            } catch (error) {
              onError(error.message);
            }
          }
        });
        container.append(handle);
      }
      container.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onContext(clip.id, event.clientX, event.clientY, body);
      });
      lane.addEventListener("pointerdown", (event) => {
        if (event.target === lane) {
          const rect = lane.getBoundingClientRect();
          onSeek(
            Math.max(
              0,
              Math.min(
                model.duration,
                ((event.clientX - rect.left) / rect.width) * model.duration,
              ),
            ),
          );
        }
      });
      lane.append(container);
      row.append(label, lane);
      tracks.append(row);
    }
    if (!model.clips.length) {
      const empty = document.createElement("p");
      empty.className = "empty-timeline";
      empty.textContent =
        "No clips yet. Open the code guide to add a text or shape statement.";
      tracks.append(empty);
    }
    if (focusId) {
      const target = [...tracks.querySelectorAll("button")].find(
        (button) =>
          button.dataset.clip === focusId &&
          (button.dataset.edge || undefined) === focusEdge,
      );
      target?.focus({ preventScroll: true });
    }
    setPlayhead();
  }
  function updateSelection() {
    tracks.querySelectorAll(".clip").forEach((clip) => {
      const selected = clip.dataset.clip === store.selected;
      clip.classList.toggle("selected", selected);
      clip
        .querySelector(".clip-body")
        .setAttribute("aria-pressed", String(selected));
    });
  }
  return {
    render,
    updateSelection,
    setPlayhead,
    cancel: () => cancelGesture?.(),
  };
}
