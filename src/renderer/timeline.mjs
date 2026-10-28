import { compile } from "../core/engine.mjs";
import { moveClips, resizeClip, timingBounds } from "../core/operations.mjs";
import { snapTime, snapDelta, FPS } from "../core/timeline-math.mjs";

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
  makeLabel,
}) {
  let cancelGesture = null,
    zoom = 1,
    snapping = true;
  const grid = tracks.closest(".timeline-grid"),
    scroll = grid.parentElement;
  function setPlayhead() {
    playhead.style.left =
      ruler.offsetLeft +
      (getTime() / store.model.duration) * ruler.clientWidth +
      "px";
    ruler.setAttribute("aria-valuenow", getTime().toFixed(3));
  }
  function applyZoom() {
    const width =
      Math.max(
        scroll.clientWidth,
        scroll.clientWidth + (scroll.clientWidth - 212) * (zoom - 1),
      ) + "px";
    if (grid.style.width !== width) grid.style.width = width;
    setPlayhead();
  }
  let resizeFrame = null;
  new ResizeObserver(() => {
    if (resizeFrame === null)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        applyZoom();
      });
  }).observe(scroll);
  function seek(event) {
    const r = ruler.getBoundingClientRect();
    onSeek(
      Math.max(
        0,
        Math.min(
          store.model.duration,
          ((event.clientX - r.left) / r.width) * store.model.duration,
        ),
      ),
    );
  }
  ruler.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    seek(event);
    ruler.setPointerCapture(event.pointerId);
    const move = (e) => seek(e),
      end = () => {
        ruler.removeEventListener("pointermove", move);
        ruler.removeEventListener("pointerup", end);
        ruler.removeEventListener("pointercancel", end);
      };
    ruler.addEventListener("pointermove", move);
    ruler.addEventListener("pointerup", end);
    ruler.addEventListener("pointercancel", end);
  });
  ruler.tabIndex = 0;
  ruler.setAttribute("role", "slider");
  ruler.setAttribute("aria-label", "Timeline playhead");
  ruler.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    onSeek(
      Math.max(
        0,
        Math.min(
          store.model.duration,
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? store.model.duration
              : getTime() +
                ((event.key === "ArrowRight" ? 1 : -1) *
                  (event.shiftKey ? 10 : 1)) /
                  FPS,
        ),
      ),
    );
  });
  function gesture(event, clip, lane, edge) {
    if (event.button !== 0 || store.error) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      onSelect(clip.id, { toggle: true });
      return;
    }
    if (!store.selectedIds.includes(clip.id)) onSelect(clip.id);
    if (clip.locked) return;
    onPause();
    cancelGesture?.();
    const base = store.source,
      start = event.clientX,
      width = lane.clientWidth,
      ids = edge ? [clip.id] : store.selectedIds,
      bounds = timingBounds(clip, store.model.duration),
      target = event.currentTarget;
    if (store.model.clips.some((c) => ids.includes(c.id) && c.locked)) {
      onError("Unlock selected clips before moving them.");
      return;
    }
    const targets = [
      0,
      store.model.duration,
      getTime(),
      ...store.model.clips
        .filter((c) => !ids.includes(c.id))
        .flatMap((c) => [c.at, c.at + c.for]),
    ];
    let candidate = base,
      moved = false;
    target.setPointerCapture(event.pointerId);
    const move = (next) => {
      if (base !== store.source) {
        finish(true);
        return;
      }
      if (Math.abs(next.clientX - start) < 3 && !moved) return;
      moved = true;
      let delta = ((next.clientX - start) / width) * store.model.duration;
      const snap = (value) =>
        snapping
          ? snapTime(value, targets, (8 / width) * store.model.duration)
          : value;
      try {
        if (edge) {
          const old = edge === "start" ? clip.at : clip.at + clip.for;
          candidate = resizeClip(
            base,
            clip.id,
            edge,
            Math.max(
              bounds[edge + "Min"],
              Math.min(bounds[edge + "Max"], snap(old + delta)),
            ),
          );
        } else {
          // Snap either edge of any selected clip, preserving their relative offsets.
          if (snapping) {
            const anchors = store.model.clips
              .filter((c) => ids.includes(c.id))
              .flatMap((c) => [c.at, c.at + c.for]);
            delta = snapDelta(
              delta,
              anchors,
              targets,
              (8 / width) * store.model.duration,
            );
          }
          candidate = moveClips(base, ids, delta);
        }
        const model = compile(candidate);
        for (const changed of model.clips.filter((c) => ids.includes(c.id))) {
          const box = [...tracks.querySelectorAll(".clip")].find(
            (e) => e.dataset.clip === changed.id,
          );
          box.style.left = (changed.at / model.duration) * 100 + "%";
          box.style.width = (changed.for / model.duration) * 100 + "%";
        }
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
        onCommit(
          candidate,
          edge
            ? "Resize clip"
            : ids.length > 1
              ? "Move selected clips"
              : "Move clip",
        );
      render();
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
    for (const clip of model.clips) {
      const row = document.createElement("div");
      row.className =
        "track-row" +
        (clip.hidden ? " is-hidden" : "") +
        (clip.locked ? " is-locked" : "");
      const label = makeLabel ? makeLabel(clip) : document.createElement("div");
      label.classList.add("track-label");
      if (!makeLabel) label.textContent = clip.label;
      label.title = clip.label;
      label.style.color = colors[clip.type][2];
      const lane = document.createElement("div");
      lane.className = "track-lane";
      lane.style.backgroundSize = 100 / (model.duration / step) + "% 100%";
      const container = document.createElement("div");
      container.className = "clip";
      container.dataset.clip = clip.id;
      container.style.cssText = `left:${(clip.at / model.duration) * 100}%;width:${(clip.for / model.duration) * 100}%;--clip-bg:${colors[clip.type][0]};--clip-border:${colors[clip.type][1]};--clip-text:${colors[clip.type][2]}`;
      const body = document.createElement("button");
      body.className = "clip-body";
      body.dataset.clip = clip.id;
      body.setAttribute(
        "aria-label",
        `${clip.label}, starts at ${clip.at} seconds, lasts ${clip.for} seconds${clip.locked ? ", locked" : ""}`,
      );
      body.disabled = !!store.error;
      const name = document.createElement("span");
      name.textContent = clip.label;
      const type = document.createElement("span");
      type.className = "clip-type";
      type.textContent = clip.type;
      body.append(name, type);
      body.addEventListener("click", (event) => {
        if (event.detail === 0)
          onSelect(clip.id, {
            toggle: event.ctrlKey || event.metaKey || event.shiftKey,
          });
      });
      body.addEventListener("pointerdown", (e) => gesture(e, clip, lane, null));
      body.addEventListener("keydown", (event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          const r = body.getBoundingClientRect();
          onContext(clip.id, r.left + 20, r.bottom, body);
        }
        if (
          ["ArrowLeft", "ArrowRight"].includes(event.key) &&
          !store.error &&
          !clip.locked
        ) {
          event.preventDefault();
          if (!store.selectedIds.includes(clip.id)) onSelect(clip.id);
          onPause();
          try {
            onCommit(
              moveClips(
                store.source,
                store.selectedIds,
                (event.key === "ArrowRight" ? 1 : -1) *
                  (event.shiftKey ? 1 : 0.1),
              ),
              "Nudge selected clips",
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
        handle.setAttribute("aria-label", `Resize ${clip.label} ${edge}`);
        handle.title = `Drag to change ${edge}`;
        handle.disabled = !!store.error || !!clip.locked;
        handle.addEventListener("pointerdown", (e) =>
          gesture(e, clip, lane, edge),
        );
        handle.addEventListener("keydown", (event) => {
          if (
            !["ArrowLeft", "ArrowRight"].includes(event.key) ||
            store.error ||
            clip.locked
          )
            return;
          event.preventDefault();
          onSelect(clip.id);
          onPause();
          const bounds = timingBounds(clip, model.duration),
            old = edge === "start" ? clip.at : clip.at + clip.for;
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
                    Math.round(
                      (old + (event.key === "ArrowRight" ? 0.1 : -0.1)) * 1000,
                    ) / 1000,
                  ),
                ),
              ),
              "Resize clip",
            );
          } catch (error) {
            onError(error.message);
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
          const r = lane.getBoundingClientRect();
          onSeek(
            Math.max(
              0,
              Math.min(
                model.duration,
                ((event.clientX - r.left) / r.width) * model.duration,
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
      const p = document.createElement("p");
      p.className = "empty-timeline";
      p.textContent =
        "No clips yet. Open the code guide to add text or shapes.";
      tracks.append(p);
    }
    updateSelection();
    if (focusId)
      [...tracks.querySelectorAll(".clip button")]
        .find(
          (b) =>
            b.dataset.clip === focusId &&
            (b.dataset.edge || undefined) === focusEdge,
        )
        ?.focus({ preventScroll: true });
    applyZoom();
  }
  function updateSelection() {
    tracks.querySelectorAll(".clip").forEach((box) => {
      const selected = store.selectedIds.includes(box.dataset.clip);
      box.classList.toggle("selected", selected);
      box
        .querySelector(".clip-body")
        .setAttribute("aria-pressed", String(selected));
    });
  }
  return {
    render,
    updateSelection,
    setPlayhead,
    cancel: () => cancelGesture?.(),
    setZoom(value) {
      zoom = Math.max(1, Math.min(4, value));
      applyZoom();
    },
    setSnap(value) {
      snapping = value;
    },
  };
}
