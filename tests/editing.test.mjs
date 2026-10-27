import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, visibleClips } from "../src/core/engine.mjs";
import * as ops from "../src/core/operations.mjs";
import { DocumentStore } from "../src/core/document.mjs";

export const SCORE =
  'composition("Edits").duration(12)\n// keep this comment\ntext("a").at(1).for(3).value("A").motion("none")\ntext("b").at(5).for(2).value("B").motion("none")';
test("display rename preserves stable key, selection, comments and Undo", () => {
  const store = new DocumentStore(SCORE, { lastValid: SCORE });
  store.select("a");
  const changed = ops.renameClip(store.source, "a", 'New .at(2) "name"');
  store.commit(changed);
  assert.equal(store.model.clips[0].id, "a");
  assert.equal(store.model.clips[0].label, 'New .at(2) "name"');
  assert.equal(store.selected, "a");
  assert.match(changed, /keep this comment/);
  store.undo();
  assert.equal(store.source, SCORE);
  store.redo();
  assert.equal(store.model.clips[0].id, "a");
});
test("batch edits validate the final composition and reject an invalid member atomically", () => {
  const store = new DocumentStore(SCORE, { lastValid: SCORE });
  const changed = ops.updateClips(SCORE, [
    { id: "a", properties: { at: 2, for: 4 } },
    { id: "b", properties: { at: 8 } },
  ]);
  store.commit(changed);
  assert.deepEqual(
    store.model.clips.map((c) => c.at),
    [2, 8],
  );
  store.undo();
  assert.equal(store.source, SCORE);
  assert.throws(() =>
    ops.updateClips(SCORE, [
      { id: "a", properties: { at: 2 } },
      { id: "b", properties: { at: 11 } },
    ]),
  );
  assert.equal(store.source, SCORE);
});
test("multiple selection survives one atomic group move and its undo", () => {
  const store = new DocumentStore(SCORE, { lastValid: SCORE });
  store.select("a");
  store.select("b", { toggle: true });
  assert.deepEqual(store.selectedIds, ["a", "b"]);
  const changed = ops.moveClips(SCORE, store.selectedIds, 20);
  store.commit(changed);
  assert.deepEqual(
    store.model.clips.map((c) => c.at),
    [6, 10],
  );
  assert.deepEqual(store.selectedIds, ["a", "b"]);
  store.undo();
  assert.equal(store.source, SCORE);
  store.select("b", { toggle: true });
  assert.deepEqual(store.selectedIds, ["a"]);
});
test("hidden clips disappear; locks reject transforms, deletion, split and whole group movement", () => {
  const source = ops.updateClips(SCORE, [
    { id: "a", properties: { hidden: 1, locked: 1 } },
  ]);
  const model = compile(source);
  assert.deepEqual(visibleClips(model, 2), []);
  assert.throws(
    () => ops.updateClip(source, "a", { position: [2, 3] }),
    /locked/i,
  );
  assert.throws(() => ops.moveClips(source, ["b", "a"], 1), /locked/i);
  assert.throws(() => ops.deleteClip(source, "a"), /locked/i);
  assert.throws(() => ops.splitClip(source, "a", 2), /locked/i);
  assert.equal(
    compile(ops.updateClip(source, "a", { locked: 0 })).clips[0].locked,
    0,
  );
});
test("new flags and transforms have strict bounded values; old statements remain compatible", () => {
  const changed = ops.updateClip(SCORE, "a", {
    scale: 2,
    rotation: 90,
    opacity: 0.5,
  });
  assert.equal(compile(changed).clips[0].opacity, 0.5);
  for (const properties of [
    { hidden: 2 },
    { locked: "yes" },
    { scale: 0 },
    { rotation: Infinity },
    { opacity: 1.1 },
  ])
    assert.throws(() => ops.updateClip(SCORE, "a", properties));
  assert.equal(compile(SCORE).clips[0].label, "a");
});

test("timeline snapping chooses the nearest target within a pixel-scaled threshold", async () => {
  const { snapTime, frameTime, movementBounds } = await import(
    "../src/core/timeline-math.mjs"
  );
  assert.equal(snapTime(2.04, [1, 2, 8], 0.06), 2);
  assert.equal(snapTime(2.2, [2], 0.06), frameTime(2.2));
  assert.equal(frameTime(1 / 30), 1 / 30);
  assert.deepEqual(movementBounds(compile(SCORE), ["a", "b"]), {
    min: -1,
    max: 5,
  });
});

test("group snapping prefers clip targets over unrelated frame-rounded anchors", async () => {
  const { snapDelta } = await import("../src/core/timeline-math.mjs");
  assert.equal(snapDelta(2, [1, 4, 5, 7], [3.08], 0.1), 2.08);
  assert.ok(Math.abs(snapDelta(0.017, [1, 4], [], 0.1) - 1 / 30) < 0.000001);
});
test("legacy long stable keys still load while new display labels are bounded", () => {
  const source =
    'composition("Old").duration(1)\ntext(' +
    JSON.stringify("x".repeat(180)) +
    ").at(0).for(1)";
  assert.equal(compile(source).clips[0].id.length, 180);
  assert.throws(() => ops.renameClip(SCORE, "a", "x".repeat(180)), /160/);
});

test("a boundary no-op preserves group selection for the next inward movement", () => {
  const store = new DocumentStore(SCORE, { lastValid: SCORE });
  store.select("a");
  store.select("b", { toggle: true });
  store.commit(ops.moveClips(store.source, store.selectedIds, -100));
  const before = store.source;
  store.commit(ops.moveClips(store.source, store.selectedIds, -1));
  assert.equal(store.source, before);
  assert.deepEqual(store.selectedIds, ["a", "b"]);
  store.commit(ops.moveClips(store.source, store.selectedIds, 0.1));
  assert.deepEqual(
    store.model.clips.map((c) => c.at),
    [0.1, 4.1],
  );
});
