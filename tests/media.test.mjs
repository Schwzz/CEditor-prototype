import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/core/engine.mjs";
import {
  DRIFT_TOLERANCE_SECONDS,
  MAX_VIDEO_ELEMENTS,
  VideoPool,
  needsCorrection,
  seekTo,
  sourceTimeFor,
} from "../src/renderer/media.mjs";
import { frameGeometry, renderFrame } from "../src/renderer/renderer.mjs";

// Renderer modules build same-origin asset URLs from the desktop bridge;
// in Node there is no DOM, so the pool tests supply fake <video> elements.
globalThis.window ??= {};

const clipSource = (id, at, forSeconds, path = `C:/clips/${id}.mp4`) =>
  `video(${JSON.stringify(id)}).at(${at}).for(${forSeconds}).source(${JSON.stringify(path)})`;

const modelWith = (...lines) =>
  compile(
    `composition("Media").duration(10)\n${lines.join("\n")}`,
  );

/// A fake <video>: real event plumbing, instant `seeked` delivery, and
/// no media decoding (tests assert policy, not pixels).
class FakeVideo {
  constructor() {
    this.listeners = new Map();
    this.time = 0;
    this.readyState = 3;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.src = "";
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener();
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(value) {
    this.time = value;
    queueMicrotask(() => this.emit("seeked"));
  }
  get src() {
    return this._src || "";
  }
  set src(value) {
    this._src = value;
    queueMicrotask(() => {
      this.emit("loadedmetadata");
      this.emit("loadeddata");
    });
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  load() {
    this.loadCalls += 1;
  }
}

const poolWithFakes = (options = {}) => {
  const elements = [];
  const pool = new VideoPool({
    createElement: () => {
      const element = new FakeVideo();
      elements.push(element);
      return element;
    },
    ...options,
  });
  return { pool, elements };
};

test("sourceTimeFor maps composition time onto the clip's source window", () => {
  assert.equal(sourceTimeFor({ at: 2, sourceAt: 0 }, 3), 1);
  assert.equal(sourceTimeFor({ at: 2, sourceAt: 4 }, 3.5), 5.5);
  assert.equal(sourceTimeFor({ at: 0, sourceAt: 1.25 }, 0), 1.25);
});

test("needsCorrection uses the one-and-a-half-frame drift tolerance", () => {
  assert.equal(DRIFT_TOLERANCE_SECONDS, 0.05);
  assert.equal(needsCorrection({ currentTime: 1.0 }, 1.04), false);
  assert.equal(needsCorrection({ currentTime: 1.0 }, 1.06), true);
  assert.equal(needsCorrection({ currentTime: 2.0 }, 2.0), false);
  assert.equal(needsCorrection(null, 5), false);
});

test("seekTo resolves once the browser reports seeked", async () => {
  const element = new FakeVideo();
  assert.equal(await seekTo(element, 2.5), true);
  assert.equal(element.currentTime, 2.5);
  // Already on the requested frame: no seek and no wait.
  assert.equal(await seekTo(element, 2.5), true);
});

test("seekTo falls back after the timeout instead of freezing the transport", async () => {
  const element = new FakeVideo();
  element.readyState = 0;
  // A decoder that never reports seeked (stalled range request).
  Object.defineProperty(element, "currentTime", {
    get: () => 0,
    set: () => {},
  });
  let scheduled = null;
  const pending = seekTo(element, 4, {
    timeoutMs: 50,
    setTimer: (fn) => {
      scheduled = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  assert.equal(typeof scheduled, "function", "a fallback timer was armed");
  scheduled();
  assert.equal(await pending, false);
});

test("the pool keeps one element per clip and rebuilds it on a source change", () => {
  const model = modelWith(clipSource("intro", 0, 5));
  const clip = model.clips[0];
  const { pool, elements } = poolWithFakes();
  const first = pool.entryFor(clip);
  assert.equal(pool.entryFor(clip), first, "same clip reuses its element");
  assert.equal(pool.size(), 1);
  assert.equal(elements.length, 1);
  const moved = { ...clip, source: "C:/clips/Other.mp4" };
  const rebuilt = pool.entryFor(moved);
  assert.notEqual(rebuilt.element, first.element, "a new source gets a new element");
  assert.equal(elements.length, 2);
  assert.equal(pool.size(), 1, "the stale element is released");
});

test("the pool caps decoders and evicts the least recently used clip", () => {
  const model = modelWith(
    clipSource("a", 0, 1),
    clipSource("b", 1, 1),
    clipSource("c", 2, 1),
  );
  const { pool } = poolWithFakes({ max: 2 });
  for (const clip of model.clips) pool.entryFor(clip);
  assert.equal(pool.size(), 2);
  assert.equal(MAX_VIDEO_ELEMENTS, 4, "production cap is four decoders");
  // The most recently used clip survived; the first was released.
  assert.ok(pool.get(model.clips[2]));
  assert.ok(pool.get(model.clips[1]));
  assert.equal(pool.get(model.clips[0]), null);
});

test("seekActive lands every visible video on its real source time", async () => {
  const model = modelWith(clipSource("a", 0, 2), clipSource("b", 5, 2));
  const { pool, elements } = poolWithFakes();
  const offscreen = pool.entryFor(model.clips[1]);
  await pool.seekActive(model, 1.5);
  const active = pool.get(model.clips[0]);
  assert.equal(active.element.currentTime, 1.5, "clip a: sourceAt 0 + 1.5");
  assert.equal(elements.length, 2, "one element per instantiated clip");
  assert.equal(
    offscreen.element.currentTime,
    0,
    "a clip outside the window is not seeked",
  );
  assert.equal(offscreen.element.paused, true);
  // After the seek the element is on the displayed frame.
  assert.equal(pool.get(model.clips[0]).ready, true);
});

test("syncActive corrects drift only beyond tolerance and starts playback", () => {
  const model = modelWith(clipSource("a", 0, 5));
  const { pool, elements } = poolWithFakes();
  const entry = pool.entryFor(model.clips[0]);
  entry.element.time = 1;
  pool.syncActive(model, 1.02);
  assert.equal(entry.element.paused, false, "a paused element starts playing");
  assert.equal(entry.element.currentTime, 1, "within tolerance: no seek");
  entry.element.time = 1;
  pool.syncActive(model, 3);
  assert.equal(entry.element.currentTime, 3, "beyond tolerance: seeked back");
});

test("a failed element is reported once and drawn as a failure state", () => {
  const model = modelWith(clipSource("broken", 0, 5));
  const { pool, elements } = poolWithFakes();
  const notified = [];
  pool.subscribe((source) => notified.push(source));
  const entry = pool.entryFor(model.clips[0]);
  elements[0].emit("error");
  assert.equal(entry.failed, true);
  assert.deepEqual(notified, [model.clips[0].source]);
  const items = frameGeometry(
    { measureText: () => ({ width: 0 }) },
    model,
    1,
    null,
    pool,
  );
  assert.equal(items[0].kind, "video");
  assert.equal(items[0].state, "failed");
  assert.equal(items[0].width, 1280, "falls back to the 16:9 box");
});

test("video geometry and painting use the decoded frame and real size", () => {
  const model = modelWith(clipSource("hero", 0, 5));
  const { pool } = poolWithFakes();
  const entry = pool.entryFor(model.clips[0]);
  entry.element.videoWidth = 1080;
  entry.element.videoHeight = 1920;
  entry.element.emit("loadedmetadata");
  assert.equal(entry.width, 1080);
  const items = frameGeometry(
    { measureText: () => ({ width: 0 }) },
    model,
    1,
    null,
    pool,
  );
  assert.equal(items[0].kind, "video");
  assert.equal(items[0].state, "ready");
  // contain with a 9:16 source inside a 16:9 box: full height, narrow width.
  assert.equal(items[0].height, 720);
  assert.equal(items[0].width, 405);
  const draws = [];
  const context = {
    canvas: {},
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    beginPath() {},
    rect() {},
    clip() {},
    translate() {},
    rotate() {},
    scale() {},
    drawImage: (...args) => draws.push(args),
  };
  renderFrame(context, model, 1, { videoCache: pool });
  assert.equal(draws.length, 1, "the decoded element is drawn, not a placeholder");
  assert.equal(draws[0][0], entry.element);
  assert.equal(draws[0][3], 405);
  assert.equal(draws[0][4], 720);
});

test("video fit rules match the image box math", () => {
  const model = modelWith(
    `video("cover").at(0).for(2).source("C:/clips/tall.mp4").fit("cover")`,
    `video("fill").at(2).for(2).source("C:/clips/tall.mp4").fit("fill")`,
  );
  const { pool } = poolWithFakes();
  for (const clip of model.clips) {
    const entry = pool.entryFor(clip);
    entry.element.videoWidth = 1080;
    entry.element.videoHeight = 1920;
    entry.element.emit("loadedmetadata");
  }
  const itemsAt = (time) =>
    frameGeometry(
      { measureText: () => ({ width: 0 }) },
      model,
      time,
      null,
      pool,
    );
  const cover = itemsAt(1).find((item) => item.clip.id === "cover");
  const fill = itemsAt(2.5).find((item) => item.clip.id === "fill");
  assert.equal(fill.width, 1280);
  assert.equal(fill.height, 720);
  assert.equal(cover.width, 1280, "cover fills the box width");
  assert.ok(cover.height > 720, "cover overflows vertically and is clipped");
});

test("a video that has not decoded paints the DECODING placeholder", () => {
  const model = modelWith(clipSource("loading", 0, 5));
  const { pool } = poolWithFakes();
  const entry = pool.entryFor(model.clips[0]);
  entry.ready = false;
  entry.element.readyState = 0;
  const labels = [];
  const draws = [];
  const context = {
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText: (text) => labels.push(text),
    beginPath() {},
    rect() {},
    clip() {},
    translate() {},
    rotate() {},
    scale() {},
    drawImage: (...args) => draws.push(args),
  };
  renderFrame(context, model, 1, { videoCache: pool });
  assert.equal(draws.length, 0, "no frame is painted before HAVE_CURRENT_DATA");
  assert.deepEqual(labels, ["DECODING"]);
});

test("pausing the pool pauses every decoder it owns", () => {
  const model = modelWith(clipSource("a", 0, 5), clipSource("b", 5, 5));
  const { pool, elements } = poolWithFakes();
  for (const clip of model.clips) pool.entryFor(clip);
  pool.pauseAll();
  assert.deepEqual(
    elements.map((element) => element.pauseCalls),
    [1, 1],
  );
  pool.clear();
  assert.equal(pool.size(), 0);
  assert.ok(elements.every((element) => element.loadCalls >= 1));
});
