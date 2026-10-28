import { renameClip, reorderClip, updateClip } from "../core/operations.mjs";

export function createLayerLabel(clip, { store, onSelect, onCommit, onError }) {
  const label = document.createElement("div");
  label.className = "layer-controls";
  const name = document.createElement("button");
  name.className = "layer-name";
  name.textContent = clip.label;
  name.title = "Select " + clip.label;
  name.dataset.layer = clip.id;
  name.dataset.action = "select";
  name.onclick = (event) =>
    onSelect(clip.id, {
      toggle: event.ctrlKey || event.metaKey || event.shiftKey,
    });
  label.append(name);
  const definitions = [
    [
      "backward",
      "↑",
      "Move backward",
      () => reorderClip(store.source, clip.id, -1),
    ],
    [
      "forward",
      "↓",
      "Move forward",
      () => reorderClip(store.source, clip.id, 1),
    ],
    [
      "hide",
      clip.hidden ? "○" : "◉",
      clip.hidden ? "Show" : "Hide",
      () => updateClip(store.source, clip.id, { hidden: clip.hidden ? 0 : 1 }),
    ],
    [
      "lock",
      clip.locked ? "▣" : "□",
      clip.locked ? "Unlock" : "Lock",
      () => updateClip(store.source, clip.id, { locked: clip.locked ? 0 : 1 }),
    ],
  ];
  for (const [action, text, title, change] of definitions) {
    const button = document.createElement("button");
    button.className = "layer-tool";
    button.textContent = text;
    button.dataset.layer = clip.id;
    button.dataset.action = action;
    button.title = title + " " + clip.label;
    button.setAttribute("aria-label", title + " " + clip.label);
    if (action === "hide" || action === "lock")
      button.setAttribute(
        "aria-pressed",
        String(!!clip[action === "hide" ? "hidden" : "locked"]),
      );
    const index = store.model.clips.indexOf(clip);
    button.disabled =
      !!store.error ||
      (["backward", "forward"].includes(action) &&
        (!!clip.locked ||
          (action === "backward"
            ? index === 0
            : index === store.model.clips.length - 1)));
    button.onclick = () => {
      try {
        onSelect(clip.id, { preserve: true });
        onCommit(change(), title + " layer");
      } catch (error) {
        onError(error.message);
      }
    };
    label.append(button);
  }
  return label;
}
export { renameClip };
