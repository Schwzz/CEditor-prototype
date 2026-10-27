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

test("rotation handle stays within a small preview frame", async () => {
  const { transformHandles } = await import("../src/renderer/geometry.mjs");
  const [item] = frameGeometry(
    ctx,
    compile(
      'composition("Small").duration(5)\nshape("s").at(0).for(5).motion("none").position(960,540)',
    ),
    2,
  );
  const handle = transformHandles(item, 216).at(-1);
  assert.ok(handle.x >= 72 && handle.x <= 1848);
  assert.ok(handle.y >= 72 && handle.y <= 1008);
});
