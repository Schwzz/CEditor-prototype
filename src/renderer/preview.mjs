import { renderFrame, hitTest, WIDTH, HEIGHT } from "./renderer.mjs";
import { updateClips } from "../core/operations.mjs";
import { defaultPosition, itemCorners, transformHandles } from "./geometry.mjs";

export function createPreview(
  canvas,
  { store, getTime, onSelect, onPause, onCommit, onError },
) {
  const ctx = canvas.getContext("2d");
  let items = [],
    gesture = null,
    guides = [];
  const handleSize = () =>
    Math.max(
      12,
      (6 * WIDTH) / Math.max(1, canvas.getBoundingClientRect().width),
    );
  const point = (event) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) / r.width) * WIDTH,
      y: ((event.clientY - r.top) / r.height) * HEIGHT,
    };
  };
  function draw(model = store.model) {
    items = renderFrame(ctx, model, getTime(), {
      selected: store.selectedIds,
      primary: store.selected,
      handleSize: handleSize(),
      guides,
    });
  }
  function handleAt(p) {
    const item = items.find((i) => i.clip.id === store.selected);
    if (!item || item.kind === "scene" || item.clip.locked) return null;
    const handle = transformHandles(item, handleSize() * 3).find(
      (h) => Math.hypot(h.x - p.x, h.y - p.y) <= handleSize() * 1.8,
    );
    return handle ? { ...handle, item } : null;
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || store.error) return;
    const start = point(event),
      handle = handleAt(start),
      item = handle?.item || hitTest(items, start.x, start.y);
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      onSelect(item?.clip.id || null, { toggle: true });
      return;
    }
    if (!item) {
      onSelect(null);
      return;
    }
    if (!store.selectedIds.includes(item.clip.id)) onSelect(item.clip.id);
    if (item.kind === "scene" || item.clip.locked) return;
    onPause();
    const ids = handle ? [item.clip.id] : store.selectedIds;
    const clips = store.model.clips.filter(
      (c) => ids.includes(c.id) && c.type !== "scene" && !c.hidden,
    );
    if (clips.some((c) => c.locked)) {
      onError("Unlock selected objects before moving them.");
      return;
    }
    const corners = itemCorners(item),
      center = {
        x: corners.reduce((v, p) => v + p.x, 0) / 4,
        y: corners.reduce((v, p) => v + p.y, 0) / 4,
      };
    gesture = {
      source: store.source,
      start,
      item,
      center,
      mode: handle?.kind || "move",
      clips,
      bases: clips.map(defaultPosition),
      changes: [],
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
  });
  canvas.addEventListener("pointermove", (event) => {
    const current = point(event);
    if (!gesture) {
      const handle = handleAt(current),
        hit = hitTest(items, current.x, current.y);
      canvas.style.cursor = store.error
        ? "default"
        : handle
          ? handle.kind === "rotate"
            ? "crosshair"
            : "nwse-resize"
          : hit && hit.kind !== "scene"
            ? "grab"
            : "default";
      return;
    }
    if (gesture.source !== store.source) {
      end(true);
      return;
    }
    if (
      Math.hypot(current.x - gesture.start.x, current.y - gesture.start.y) <
        3 &&
      !gesture.moved
    )
      return;
    gesture.moved = true;
    guides = [];
    const { item, start } = gesture;
    if (gesture.mode === "move") {
      let dx = current.x - start.x,
        dy = current.y - start.y;
      const threshold = (8 * WIDTH) / canvas.getBoundingClientRect().width;
      if (Math.abs(gesture.center.x + dx - WIDTH / 2) < threshold) {
        dx = WIDTH / 2 - gesture.center.x;
        guides.push("x");
      }
      if (Math.abs(gesture.center.y + dy - HEIGHT / 2) < threshold) {
        dy = HEIGHT / 2 - gesture.center.y;
        guides.push("y");
      }
      dx = Math.max(
        -Math.min(...gesture.bases.map((p) => p[0])),
        Math.min(WIDTH - Math.max(...gesture.bases.map((p) => p[0])), dx),
      );
      dy = Math.max(
        -Math.min(...gesture.bases.map((p) => p[1])),
        Math.min(HEIGHT - Math.max(...gesture.bases.map((p) => p[1])), dy),
      );
      gesture.changes = gesture.clips.map((clip, i) => ({
        id: clip.id,
        properties: {
          position: [gesture.bases[i][0] + dx, gesture.bases[i][1] + dy],
        },
      }));
    } else if (gesture.mode === "resize") {
      const ratio =
        Math.hypot(current.x - item.x, current.y - item.y) /
        Math.max(1, Math.hypot(start.x - item.x, start.y - item.y));
      gesture.changes = [
        {
          id: item.clip.id,
          properties: {
            scale: Math.max(0.1, Math.min(4, item.clip.scale * ratio)),
          },
        },
      ];
    } else {
      const angle =
        ((Math.atan2(current.y - item.y, current.x - item.x) -
          Math.atan2(start.y - item.y, start.x - item.x)) *
          180) /
        Math.PI;
      let rotation = ((item.clip.rotation + angle + 540) % 360) - 180;
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      gesture.changes = [{ id: item.clip.id, properties: { rotation } }];
    }
    const changes = new Map(gesture.changes.map((c) => [c.id, c.properties]));
    draw({
      ...store.model,
      clips: store.model.clips.map((c) => ({ ...c, ...changes.get(c.id) })),
    });
    canvas.style.cursor = gesture.mode === "move" ? "grabbing" : "crosshair";
  });
  function end(cancelled) {
    const current = gesture;
    gesture = null;
    guides = [];
    canvas.style.cursor = "default";
    if (current?.moved && !cancelled && current.source === store.source) {
      try {
        onCommit(
          updateClips(current.source, current.changes),
          current.mode === "move"
            ? "Move objects"
            : current.mode === "resize"
              ? "Resize object"
              : "Rotate object",
        );
      } catch (error) {
        onError(error.message);
      }
    }
    draw();
  }
  canvas.addEventListener("pointerup", () => end(false));
  canvas.addEventListener("pointercancel", () => end(true));
  canvas.addEventListener("lostpointercapture", () => {
    if (gesture) end(true);
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && gesture) {
      event.preventDefault();
      end(true);
      return;
    }
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
        event.key,
      ) ||
      store.error
    )
      return;
    const clips = store.model.clips.filter(
      (c) =>
        store.selectedIds.includes(c.id) && c.type !== "scene" && !c.hidden,
    );
    if (!clips.length) return;
    event.preventDefault();
    onPause();
    const step = event.shiftKey ? 10 : 1;
    try {
      const changes = clips.map((clip) => {
        const p = defaultPosition(clip);
        return {
          id: clip.id,
          properties: {
            position: [
              Math.max(
                0,
                Math.min(
                  WIDTH,
                  p[0] +
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
                  p[1] +
                    (event.key === "ArrowDown"
                      ? step
                      : event.key === "ArrowUp"
                        ? -step
                        : 0),
                ),
              ),
            ],
          },
        };
      });
      onCommit(updateClips(store.source, changes), "Nudge objects");
    } catch (error) {
      onError(error.message);
    }
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  return { draw, cancel: () => end(true) };
}
