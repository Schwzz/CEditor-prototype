import { renderFrame, hitTest, WIDTH, HEIGHT } from "./renderer.mjs";
import { updateClip } from "../core/operations.mjs";

export function createPreview(
  canvas,
  { store, getTime, onSelect, onPause, onCommit, onError },
) {
  const ctx = canvas.getContext("2d");
  let items = [],
    gesture = null;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
  };
  function draw(model = store.model) {
    items = renderFrame(ctx, model, getTime(), { selected: store.selected });
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || store.error) return;
    const start = point(event),
      item = hitTest(items, start.x, start.y);
    onSelect(item?.clip.id || null);
    if (!item || item.kind === "scene") return;
    onPause();
    const base = item.clip.position || [
      item.kind === "shape" ? 1380 : item.clip.place === "center" ? 960 : 95,
      item.kind === "shape"
        ? 548
        : item.clip.place === "bottom"
          ? 864
          : item.clip.place === "center"
            ? 470
            : 343,
    ];
    gesture = {
      id: item.clip.id,
      source: store.source,
      start,
      base,
      position: base,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const current = point(event);
    if (!gesture) {
      const hit = hitTest(items, current.x, current.y);
      canvas.style.cursor =
        hit && hit.kind !== "scene" && !store.error ? "grab" : "default";
      return;
    }
    if (
      Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) > 3
    )
      gesture.moved = true;
    gesture.position = [
      Math.max(
        0,
        Math.min(WIDTH, gesture.base[0] + current.x - gesture.start.x),
      ),
      Math.max(
        0,
        Math.min(HEIGHT, gesture.base[1] + current.y - gesture.start.y),
      ),
    ];
    const model = {
      ...store.model,
      clips: store.model.clips.map((clip) =>
        clip.id === gesture.id ? { ...clip, position: gesture.position } : clip,
      ),
    };
    draw(model);
    canvas.style.cursor = "grabbing";
  });
  const end = (cancelled) => {
    const current = gesture;
    gesture = null;
    canvas.style.cursor = "default";
    if (current?.moved && !cancelled && current.source === store.source) {
      try {
        onCommit(
          updateClip(current.source, current.id, {
            position: current.position,
          }),
          "Move object",
        );
      } catch (error) {
        onError(error.message);
      }
    }
    draw();
  };
  canvas.addEventListener("pointerup", () => end(false));
  canvas.addEventListener("pointercancel", () => end(true));
  canvas.addEventListener("keydown", (event) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
        event.key,
      ) ||
      store.error
    )
      return;
    const item = items.find((item) => item.clip.id === store.selected);
    if (!item || item.kind === "scene") return;
    event.preventDefault();
    onPause();
    const step = event.shiftKey ? 10 : 1,
      base = item.clip.position || [
        item.kind === "shape" ? 1380 : item.clip.place === "center" ? 960 : 95,
        item.kind === "shape"
          ? 548
          : item.clip.place === "bottom"
            ? 864
            : item.clip.place === "center"
              ? 470
              : 343,
      ];
    const position = [
      Math.max(
        0,
        Math.min(
          WIDTH,
          base[0] +
            (event.key === "ArrowRight"
              ? step
              : event.key === "ArrowLeft"
                ? -step
                : 0),
        ),
      ),
      Math.max(
        0,
        Math.min(
          HEIGHT,
          base[1] +
            (event.key === "ArrowDown"
              ? step
              : event.key === "ArrowUp"
                ? -step
                : 0),
        ),
      ),
    ];
    try {
      onCommit(
        updateClip(store.source, item.clip.id, { position }),
        "Nudge object",
      );
    } catch (error) {
      onError(error.message);
    }
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  return { draw, cancel: () => end(true) };
}
