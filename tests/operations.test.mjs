import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, DEFAULT_SOURCE } from "../src/core/engine.mjs";
import {
  updateClip,
  resizeClip,
  splitClip,
  duplicateClip,
  deleteClip,
  copyClip,
  pasteClip,
} from "../src/core/operations.mjs";

test("position edits are explicit, validated, and preserve template bindings", () => {
  const source = updateClip(DEFAULT_SOURCE, "Headline", {
    position: [480, 320],
  });
  const clip = compile(source).clips.find((c) => c.id === "Headline");
  assert.deepEqual(clip.position, [480, 320]);
  assert.match(source, /\.value\(\$title\)/);
  assert.throws(() =>
    updateClip(source, "Headline", { position: [Infinity, 20] }),
  );
});
test("atomic timing changes can move and extend together without intermediate invalid source", () => {
  const source = updateClip(DEFAULT_SOURCE, "Headline", { at: 0, for: 12 });
  assert.equal(compile(source).clips[1].for, 12);
});
test("resizing either edge updates both source and duration", () => {
  let source = resizeClip(DEFAULT_SOURCE, "Headline", "start", 1.4);
  let clip = compile(source).clips[1];
  assert.equal(clip.at, 1.4);
  assert.equal(clip.for, 9.8);
  source = resizeClip(source, "Headline", "end", 10);
  assert.equal(compile(source).clips[1].for, 8.6);
  assert.throws(() => resizeClip(source, "Headline", "start", 10));
  assert.throws(() => resizeClip(source, "Headline", "end", 61));
});
test("source operations do not touch quoted method names", () => {
  const source = DEFAULT_SOURCE.replace('"Headline"', '"Keep .position(1,2)"');
  const result = compile(
    updateClip(source, "Keep .position(1,2)", { position: [200, 300], at: 1 }),
  );
  assert.equal(result.clips[1].id, "Keep .position(1,2)");
  assert.equal(result.clips[1].at, 1);
});
test("splits preserve source phase and the original animation end", () => {
  const result = splitClip(DEFAULT_SOURCE, "Headline", 4);
  const model = compile(result.source),
    left = model.clips.find((c) => c.id === "Headline"),
    right = model.clips.find((c) => c.id === result.id);
  assert.equal(left.for, 3.6);
  assert.equal(right.at, 4);
  assert.equal(right.for, 7.2);
  assert.equal(left.sourceAt + 4 - left.at, right.sourceAt);
  assert.equal(left.sourceDuration, right.sourceDuration);
  const again = splitClip(result.source, result.id, 6);
  assert.equal(
    compile(again.source).clips.find((c) => c.id === again.id).sourceAt,
    5.6,
  );
  assert.throws(() => splitClip(DEFAULT_SOURCE, "Headline", 0.4));
});
test("split trims respect their source boundaries", () => {
  const result = splitClip(DEFAULT_SOURCE, "Headline", 4);
  const changed = resizeClip(result.source, result.id, "start", 3);
  const clip = compile(changed).clips.find((c) => c.id === result.id);
  assert.equal(clip.sourceAt, 2.6);
  assert.equal(clip.at, 3);
  assert.throws(() => resizeClip(changed, result.id, "start", 0));
});
test("duplicate and delete preserve references and unique clip identities", () => {
  const duplicated = duplicateClip(DEFAULT_SOURCE, "Headline");
  assert.equal(compile(duplicated.source).clips.length, 5);
  assert.notEqual(duplicated.id, "Headline");
  assert.match(duplicated.source, /\.value\(\$title\)/);
  assert.equal(
    compile(deleteClip(duplicated.source, duplicated.id)).clips.length,
    4,
  );
});
test("clipboard imports conflicting parameters without changing existing template values", () => {
  const payload = copyClip(DEFAULT_SOURCE, "Headline");
  const target = DEFAULT_SOURCE.replace("MAKE IT MOVE.", "OTHER TITLE");
  const result = pasteClip(target, payload, 0.5);
  const model = compile(result.source);
  assert.equal(model.params.title, "OTHER TITLE");
  assert.equal(
    model.clips.find((c) => c.id === result.id).value,
    "MAKE IT MOVE.",
  );
  assert.equal(model.clips.find((c) => c.id === result.id).at, 0.5);
});
test("malformed clipboard content cannot append code or exceed clip limits", () => {
  for (const payload of [
    "alert(1)",
    "{}",
    JSON.stringify({
      format: "framecode-clip",
      version: 999,
      statement: 'text("X")',
      params: {},
    }),
    JSON.stringify({
      format: "framecode-clip",
      version: 1,
      statement: 'text("X")\ntext("Y")',
      params: {},
    }),
  ])
    assert.throws(() => pasteClip(DEFAULT_SOURCE, payload, 0));
  let source = DEFAULT_SOURCE;
  while (compile(source).clips.length < 24)
    source = duplicateClip(source, "Headline").source;
  assert.throws(() => duplicateClip(source, "Headline"), /24/);
});
test("clipboard parameter renaming cannot cascade into another original reference", () => {
  const source =
    'composition("Copy").duration(5)\nparam("title", "A")\nparam("title_2", "rise")\ntext("Text").at(0).for(5).value($title).motion($title_2)';
  const target = 'composition("Paste").duration(5)\nparam("title", "OLD")';
  const result = pasteClip(target, copyClip(source, "Text"), 0),
    clip = compile(result.source).clips[0];
  assert.equal(clip.value, "A");
  assert.equal(clip.motion, "rise");
});
