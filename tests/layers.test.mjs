import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/core/engine.mjs";
import * as ops from "../src/core/operations.mjs";
const SCORE =
  'composition("Edits").duration(12)\n// keep this comment\ntext("a").at(1).for(3).value("A").motion("none")\ntext("b").at(5).for(2).value("B").motion("none")';

test("layer reordering swaps draw order while keeping stable IDs and comment content", () => {
  const changed = ops.reorderClip(SCORE, "a", 1);
  assert.deepEqual(
    compile(changed).clips.map((c) => c.id),
    ["b", "a"],
  );
  assert.match(changed, /keep this comment/);
  assert.equal(ops.reorderClip(changed, "a", 1), changed);
  const locked = ops.updateClip(SCORE, "a", { locked: 1 });
  assert.throws(() => ops.reorderClip(locked, "a", 1), /locked/i);
});
test("deleting multiple selected clips is atomic and refuses locked members", () => {
  assert.equal(compile(ops.deleteClips(SCORE, ["a", "b"])).clips.length, 0);
  assert.throws(
    () =>
      ops.deleteClips(ops.updateClip(SCORE, "b", { locked: 1 }), ["a", "b"]),
    /locked/i,
  );
});
