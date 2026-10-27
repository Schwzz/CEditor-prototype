export const FPS = 30;
export const frameTime = (seconds) => Math.round(seconds * FPS) / FPS;
export function snapTime(value, targets = [], threshold = 0) {
  let closest = frameTime(value),
    distance = threshold;
  for (const target of targets) {
    const next = Math.abs(value - target);
    if (next <= distance) {
      closest = target;
      distance = next;
    }
  }
  return closest;
}
export function movementBounds(model, ids) {
  const clips = ids.map((id) => model.clips.find((c) => c.id === id));
  if (!clips.length || clips.some((c) => !c))
    throw new Error("Select existing clips.");
  return {
    min: -Math.min(...clips.map((c) => c.at)),
    max: model.duration - Math.max(...clips.map((c) => c.at + c.for)),
  };
}

export function snapDelta(delta, anchors, targets, threshold) {
  let correction = null;
  for (const anchor of anchors)
    for (const target of targets) {
      const change = target - anchor - delta;
      if (
        Math.abs(change) <= threshold &&
        (correction === null || Math.abs(change) < Math.abs(correction))
      )
        correction = change;
    }
  return correction === null
    ? frameTime(anchors[0] + delta) - anchors[0]
    : delta + correction;
}
