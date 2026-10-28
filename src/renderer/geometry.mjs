export function defaultPosition(clip) {
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
export function toWorld(item, x, y) {
  const c = Math.cos(item.rotation),
    s = Math.sin(item.rotation),
    scale = item.scale;
  return {
    x: item.x + (x * c - y * s) * scale,
    y: item.y + (x * s + y * c) * scale,
  };
}
export function toLocal(item, x, y) {
  const dx = x - item.x,
    dy = y - item.y,
    c = Math.cos(item.rotation),
    s = Math.sin(item.rotation);
  return {
    x: (dx * c + dy * s) / item.scale,
    y: (-dx * s + dy * c) / item.scale,
  };
}
export function itemCorners(item) {
  const l = item.localLeft,
    t = item.localTop,
    r = l + item.width,
    b = t + item.height;
  return [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
  ].map(([x, y]) => toWorld(item, x, y));
}
export function transformHandles(
  item,
  gap = 60,
  frame = { width: 1920, height: 1080 },
) {
  const corners = itemCorners(item);
  const rotate = toWorld(
    item,
    item.localLeft + item.width / 2,
    item.localTop - gap / item.scale,
  );
  const margin = Math.min(gap / 3, Math.min(frame.width, frame.height) / 4);
  rotate.x = Math.max(margin, Math.min(frame.width - margin, rotate.x));
  rotate.y = Math.max(margin, Math.min(frame.height - margin, rotate.y));
  return [
    ...corners.map((p, i) => ({
      ...p,
      kind: "resize",
      key: ["nw", "ne", "se", "sw"][i],
    })),
    {
      ...rotate,
      kind: "rotate",
      key: "rotate",
    },
  ];
}
