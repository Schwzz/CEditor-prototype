import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentStore } from "../src/core/document.mjs";
import { DEFAULT_SOURCE, replaceParam } from "../src/core/engine.mjs";

test("shared undo restores code and resolved parameters after an edit", () => {
  const store = new DocumentStore();
  store.select("Headline");
  store.commit(replaceParam(store.source, "title", "NEW"), { label: "Title" });
  assert.equal(store.model.params.title, "NEW");
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.source, DEFAULT_SOURCE);
  assert.equal(store.selected, "Headline");
  assert.equal(store.dirty, false);
  store.redo();
  assert.equal(store.model.params.title, "NEW");
});
test("invalid source retains its last valid model through undo and redo", () => {
  const store = new DocumentStore();
  const valid = replaceParam(store.source, "title", "VALID");
  store.commit(valid);
  store.commit(valid + "\nbroken(");
  assert.ok(store.error);
  assert.equal(store.model.params.title, "VALID");
  const saved = store.serialize();
  const restored = new DocumentStore(saved.source, {
    lastValid: saved.lastValid,
  });
  assert.ok(restored.error);
  assert.equal(restored.model.params.title, "VALID");
  store.undo();
  assert.equal(store.error, null);
  store.redo();
  assert.ok(store.error);
});
test("typing coalesces but a subsequent gesture remains a separate undo step", () => {
  const store = new DocumentStore();
  store.commit(replaceParam(store.source, "title", "A"), {
    coalesce: "typing",
  });
  store.commit(replaceParam(store.source, "title", "AB"), {
    coalesce: "typing",
  });
  store.commit(replaceParam(store.source, "title", "DRAG"), { label: "Drag" });
  store.undo();
  assert.equal(store.model.params.title, "AB");
  store.undo();
  assert.equal(store.source, DEFAULT_SOURCE);
});
test("saving an older snapshot never marks newer edits clean", () => {
  const store = new DocumentStore();
  store.commit(replaceParam(store.source, "title", "SAVE THIS"));
  const saving = store.serialize();
  store.commit(replaceParam(store.source, "title", "NEWER"));
  store.markSaved(saving);
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, false);
});
test("loading a project resets cross-project history and validates selected identity", () => {
  const store = new DocumentStore();
  store.commit(replaceParam(store.source, "title", "OLD"));
  store.select("Headline");
  store.load({ source: DEFAULT_SOURCE, lastValid: DEFAULT_SOURCE });
  assert.equal(store.canUndo, false);
  assert.equal(store.selected, null);
  assert.equal(store.dirty, false);
  store.select("unknown");
  assert.equal(store.selected, null);
});
