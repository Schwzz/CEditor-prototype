import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, DEFAULT_SOURCE } from "../src/core/engine.mjs";
import { splitClip } from "../src/core/operations.mjs";
import {
  motionState,
  frameGeometry,
  hitTest,
} from "../src/renderer/renderer.mjs";
import { LESSONS } from "../src/renderer/guide.mjs";
const context = {
  font: "",
  measureText: (text) => ({ width: text.length * 65 }),
};
test("all guide lessons are executable complete compositions", () => {
  assert.equal(LESSONS.length, 9);
  for (const lesson of LESSONS)
    assert.ok(compile(lesson.code).clips.length > 0);
});
test("rendering uses identical animation phase before and after splitting", () => {
  const before = compile(DEFAULT_SOURCE).clips[1],
    split = splitClip(DEFAULT_SOURCE, "Headline", 4),
    after = compile(split.source).clips.find((c) => c.id === split.id);
  assert.deepEqual(motionState(before, 4.1, 1.2), motionState(after, 4.1, 1.2));
});
test("hit testing uses rendered text geometry and selects the topmost visible object", () => {
  const source =
    'composition("Hit test").duration(5)\ntext("Back").at(0).for(5).value("BACK").position(200, 400).motion("none")\ntext("Front").at(0).for(5).value("FRONT").position(200, 400).motion("none")';
  const items = frameGeometry(context, compile(source), 2);
  assert.equal(hitTest(items, 210, 390).clip.id, "Front");
  assert.equal(hitTest(items, 1800, 1000), null);
});
