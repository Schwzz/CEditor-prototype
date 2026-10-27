import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/core/engine.mjs";
import { frameGeometry, hitTest } from "../src/renderer/renderer.mjs";
const ctx = { font: "", measureText: (text) => ({ width: text.length * 65 }) };
test("rotated scaled text uses one geometry for drawing, handles and picking", async () => {
  const { toWorld, toLocal, transformHandles } = await import(
    "../src/renderer/geometry.mjs"
  );
  const model = compile(
    'composition("G").duration(5)\ntext("x").at(0).for(5).value("ABC").position(500,500).motion("none").scale(2).rotation(90).opacity(0.5)',
  );
  const [item] = frameGeometry(ctx, model, 2);
  assert.equal(item.alpha, 0.5);
  const point = toWorld(item, 50, -50),
    local = toLocal(item, point.x, point.y);
  assert.ok(Math.abs(local.x - 50) < 0.001 && Math.abs(local.y + 50) < 0.001);
  assert.equal(hitTest([item], point.x, point.y).clip.id, "x");
  assert.equal(hitTest([item], 1000, 100), null);
  assert.equal(transformHandles(item).length, 5);
});
test("hidden and locked objects are excluded from preview picking", () => {
  const model = compile(
    'composition("G").duration(5)\ntext("x").at(0).for(5).value("ABC").position(200,400).motion("none").locked(1)\ntext("y").at(0).for(5).value("ABC").hidden(1)',
  );
  const items = frameGeometry(ctx, model, 2);
  assert.equal(items.length, 1);
  assert.equal(hitTest(items, 210, 390), null);
});
