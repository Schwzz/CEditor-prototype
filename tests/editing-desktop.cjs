const assert = require("node:assert/strict");
module.exports = async function ({
  page,
  click,
  field,
  replaceCode,
  source,
  key,
  drag,
  passed,
}) {
  const original = await source();
  const score =
    'composition("Editor tools").duration(12)\ntext("a").at(1).for(3).value("ALPHA").motion("none").position(200,400)\ntext("b").at(5).for(2).value("BETA").motion("none").position(1200,750)';
  await replaceCode(score);
  await field("timelineZoom", 3, "input");
  assert.ok(
    await page(() => {
      const e = document.querySelector(".timeline-scroll");
      return e.scrollWidth > e.clientWidth * 2;
    }),
  );
  await field("timelineZoom", 1, "input");
  await field("seek", 0, "input");
  await click("nextFrame");
  assert.ok(
    Math.abs(
      (await page(() => +document.getElementById("seek").value)) - 1 / 30,
    ) < 0.001,
  );
  await click("previousFrame");
  assert.equal(await page(() => +document.getElementById("seek").value), 0);
  await page(() => {
    document.querySelector('.clip-body[data-clip="a"]').click();
    document
      .querySelector('.clip-body[data-clip="b"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  });
  assert.equal(
    await page(() => document.querySelectorAll(".clip.selected").length),
    2,
  );
  assert.equal(
    await page(() => document.querySelectorAll(".cm-clip-line").length),
    2,
  );
  const start = await page(() => {
    const r = document
      .querySelector('.clip-body[data-clip="a"]')
      .getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await drag(start, { x: start.x + 35, y: start.y });
  const changed = await source();
  const starts = [...changed.matchAll(/\.at\(([\d.]+)\)/g)].map((m) => +m[1]);
  assert.ok(starts[0] > 1);
  assert.ok(Math.abs(starts[0] - 1 - (starts[1] - 5)) < 0.001);
  await click("undo");
  assert.equal(await source(), score);
  passed(
    "timeline zoom, 30fps stepping, multi-selection and one-step group movement",
  );
  await field("timelineZoom", 3, "input");
  const edge = await page(() => {
    const handle = document.querySelector('.resize-handle.end[data-clip="b"]');
    handle.scrollIntoView({ block: "nearest", inline: "center" });
    const r = handle.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      scroll: document.querySelector(".timeline-scroll").scrollLeft,
    };
  });
  assert.ok(edge.scroll > 0);
  await drag(edge, { x: edge.x + 35, y: edge.y });
  assert.ok(
    (await page(() => +document.getElementById("clipDuration").value)) > 2,
    "resizing a scrolled clip changes its duration",
  );
  await click("undo");
  assert.equal(await source(), score);
  await field("timelineZoom", 1, "input");
  passed(
    "timeline resizing remains accurate with zoom and horizontal scrolling",
  );
  await page(() => document.querySelector('.clip-body[data-clip="a"]').click());
  await field("clipLabel", "Renamed .at(5)");
  assert.match(await source(), /text\("a"\).*\.label\("Renamed \.at\(5\)"\)/);
  assert.equal(
    await page(() => document.querySelector(".clip.selected").dataset.clip),
    "a",
  );
  await page(() =>
    document.querySelector('[data-layer="a"][data-action="forward"]').click(),
  );
  assert.deepEqual(
    await page(() =>
      [...document.querySelectorAll(".clip")].map((e) => e.dataset.clip),
    ),
    ["b", "a"],
  );
  await page(() =>
    document.querySelector('[data-layer="a"][data-action="hide"]').click(),
  );
  assert.match(await source(), /\.hidden\(1\)/);
  await page(() =>
    document.querySelector('[data-layer="a"][data-action="lock"]').click(),
  );
  assert.equal(
    await page(() => document.getElementById("clipStart").disabled),
    true,
  );
  const locked = await source();
  await page(() => document.querySelector('.clip-body[data-clip="a"]').focus());
  await key("Delete");
  assert.equal(await source(), locked);
  await page(() =>
    document.querySelector('[data-layer="a"][data-action="lock"]').click(),
  );
  await page(() =>
    document.querySelector('[data-layer="a"][data-action="hide"]').click(),
  );
  assert.equal(
    await page(() => document.getElementById("clipStart").disabled),
    false,
  );
  passed(
    "layer rename, reorder, hide, lock and destructive-command protection",
  );
  await field("objectScale", 1.5);
  await field("objectRotation", 45);
  await field("objectOpacity", 0.4);
  assert.match(await source(), /\.scale\(1\.5\)/);
  assert.match(await source(), /\.rotation\(45\)/);
  assert.match(await source(), /\.opacity\(0\.4\)/);
  passed("numeric preview scale, rotation and opacity update shared source");
  const shape =
    'composition("Handles").duration(5)\nshape("s").at(0).for(5).motion("none").position(960,540)';
  await replaceCode(shape);
  await page(() => document.querySelector('.clip-body[data-clip="s"]').click());
  const geometry = await page(() => {
    const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const project = (p) => ({
    x: geometry.x + (p.x / 1920) * geometry.w,
    y: geometry.y + (p.y / 1080) * geometry.h,
  });
  const c = Math.cos(-0.32),
    sn = Math.sin(-0.32);
  const corner = { x: 960 + 375 * (c - sn), y: 540 + 375 * (sn + c) };
  await drag(
    project(corner),
    project({
      x: 960 + (corner.x - 960) * 1.25,
      y: 540 + (corner.y - 540) * 1.25,
    }),
  );
  const scale = await page(() => +document.getElementById("objectScale").value);
  assert.ok(scale > 1.1 && scale < 1.5, "corner drag changes scale");
  await click("undo");
  assert.equal(await source(), shape);
  const top = -375 - 3 * Math.max(12, (6 * 1920) / geometry.w),
    rx = -top * sn,
    ry = top * c;
  const angle = Math.PI / 4;
  await drag(
    project({ x: 960 + rx, y: 540 + ry }),
    project({
      x: 960 + rx * Math.cos(angle) - ry * Math.sin(angle),
      y: 540 + rx * Math.sin(angle) + ry * Math.cos(angle),
    }),
  );
  const rotation = await page(
    () => +document.getElementById("objectRotation").value,
  );
  assert.ok(rotation > 25 && rotation < 65, "rotation handle changes angle");
  await click("undo");
  assert.equal(await source(), shape);
  passed("preview corner and rotation handle pointer gestures each undo once");
  const newer = shape.replace("Handles", "New source during gesture");
  await drag(
    project(corner),
    project({ x: corner.x + 100, y: corner.y + 50 }),
    () => replaceCode(newer),
  );
  assert.equal(
    await source(),
    newer,
    "a stale preview gesture cannot overwrite code changes",
  );
  passed("source changes cancel pending preview gestures");
  const hiddenScore =
    'composition("Hidden group").duration(5)\nshape("visible").at(0).for(5).motion("none").position(400,540)\nshape("hidden").at(0).for(5).motion("none").position(1200,540).hidden(1)';
  await replaceCode(hiddenScore);
  await page(() => {
    document.querySelector('.clip-body[data-clip="visible"]').click();
    document
      .querySelector('.clip-body[data-clip="hidden"]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  });
  const visiblePoint = project({ x: 400, y: 540 });
  await drag(visiblePoint, { x: visiblePoint.x + 25, y: visiblePoint.y });
  assert.match(
    await source(),
    /shape\("hidden"\).*\.position\(1200,540\)/,
    "preview pointer movement leaves hidden members unchanged",
  );
  await page(() => document.getElementById("canvas").focus());
  await key("Right");
  assert.match(
    await source(),
    /shape\("hidden"\).*\.position\(1200,540\)/,
    "preview keyboard movement leaves hidden members unchanged",
  );
  passed(
    "hidden selected layers are protected from preview pointer and keyboard movement",
  );
  await replaceCode(original);
};
