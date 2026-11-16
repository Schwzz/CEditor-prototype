import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, DEFAULT_SOURCE } from "../src/core/engine.mjs";
import { splitClip } from "../src/core/operations.mjs";
import {
  motionState,
  frameGeometry,
  hitTest,
  ImageCache,
} from "../src/renderer/renderer.mjs";
import {
  createTauriDesktopBridge,
  createTokenHolder,
} from "../src/renderer/tauri-bridge.mjs";
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

// The capability token is delivered asynchronously by the Rust asset_token
// command, and a tokenless asset URL is always rejected. These tests wire
// the real desktop bridge (createTauriDesktopBridge + createTokenHolder,
// with a fake invoke standing in for the Rust command) to the real
// ImageCache: no test ever replaces the readiness promise. They prove the
// cache makes token readiness deterministic, that failed deliveries never
// fire a doomed request, and that the bridge's paced retry path flushes
// queued images on its own — no restart, no user interaction.
const flushEvents = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

// A real bridge wired like the install block does, with immediate pacing
// so tests drive the retry loop without real timers. Production paces
// re-invocations tokenRetryMs (default 1000 ms) apart.
const testBridge = (invoke) =>
  createTauriDesktopBridge({
    invoke,
    clipboard: null,
    platform: "win32",
    tokenHolder: createTokenHolder(invoke),
    tokenRetryMs: 0,
    delay: () => Promise.resolve(),
  });

const tokenedImageStub = (requests) =>
  class {
    set src(url) {
      requests.push(url);
      // Simulate the Rust protocol: tokenless requests are rejected,
      // tokened requests succeed — asynchronously, like a real load.
      queueMicrotask(() => {
        if (url.includes("token=")) this.onload?.();
        else this.onerror?.();
      });
    }
  };

test("a tokenless asset request is queued, never fired", async () => {
  const restore = fakeBrowserEnvironment();
  try {
    // The asset_token delivery is in flight (the Rust command has not
    // resolved yet), so the getter still reads "".
    globalThis.window.framecodeDesktop = testBridge(
      () => new Promise(() => {}),
    );
    const requests = [];
    globalThis.Image = tokenedImageStub(requests);
    const cache = new ImageCache();
    cache.get("C:\\imgs\\A.png");
    await flushEvents();
    assert.equal(
      requests.length,
      0,
      "a URL without the capability token can only be rejected, so it must not fire",
    );
  } finally {
    restore();
  }
});

test("delayed token: queued images load automatically once the token arrives", async () => {
  const requests = [];
  const restore = fakeBrowserEnvironment();
  try {
    // The real bridge with a delivery that lands late.
    let releaseToken;
    globalThis.window.framecodeDesktop = testBridge(async (command) => {
      assert.equal(command, "asset_token");
      return new Promise((resolve) => {
        releaseToken = resolve;
      });
    });
    globalThis.Image = tokenedImageStub(requests);
    const cache = new ImageCache();
    assert.equal(cache.get("C:\\imgs\\A.png"), null);
    assert.equal(requests.length, 0, "no doomed request while awaiting");

    // Let the first attempt chain actually reach the (pending) invoke.
    await flushEvents();
    // The delivery lands on its own — no user interaction of any kind.
    releaseToken("tok123");
    for (let i = 0; i < 50 && requests.length === 0; i++) {
      cache.get("C:\\imgs\\A.png");
      await flushEvents();
    }

    assert.equal(requests.length, 1, "exactly one real load fired");
    assert.ok(
      requests[0].includes("token=tok123"),
      "the retry carries the delivered token",
    );
    assert.ok(
      cache.get("C:\\imgs\\A.png"),
      "the image is cached after the automatic retry",
    );
    assert.equal(cache.hasFailed("C:\\imgs\\A.png"), false);
  } finally {
    restore();
  }
});

test("failed token delivery fires zero requests and keeps re-invoking", async () => {
  const requests = [];
  const restore = fakeBrowserEnvironment();
  try {
    let calls = 0;
    globalThis.window.framecodeDesktop = testBridge(async (command) => {
      assert.equal(command, "asset_token");
      calls++;
      throw new Error("backend not ready");
    });
    globalThis.Image = tokenedImageStub(requests);
    const cache = new ImageCache();
    // Several render-loop rounds while delivery keeps failing: every
    // round re-arms the wait, which drives one paced retry attempt.
    for (let round = 0; round < 5; round++) {
      cache.get("C:\\imgs\\A.png");
      await flushEvents();
      assert.equal(
        requests.length,
        0,
        "a failed delivery must not fire the exact 403 request we meant to prevent",
      );
      assert.equal(
        cache.hasFailed("C:\\imgs\\A.png"),
        false,
        "the source is preserved, never poisoned with a failure entry",
      );
    }
    assert.ok(
      calls >= 3,
      "the bridge really re-invoked asset_token after the failures",
    );
  } finally {
    restore();
  }
});

test("a retried token delivery recovers the queued images", async () => {
  const requests = [];
  const restore = fakeBrowserEnvironment();
  try {
    let calls = 0;
    globalThis.window.framecodeDesktop = testBridge(async (command) => {
      assert.equal(command, "asset_token");
      calls++;
      if (calls <= 2) throw new Error("backend not ready yet");
      return "tok789";
    });
    globalThis.Image = tokenedImageStub(requests);
    const cache = new ImageCache();
    // The render loop keeps calling get() while delivery fails; when the
    // retry finally delivers, the queued image loads without any user
    // action and without restarting the app.
    for (let i = 0; i < 50 && requests.length === 0; i++) {
      cache.get("C:\\imgs\\A.png");
      await flushEvents();
    }

    assert.equal(calls, 3, "two failed attempts, then the successful retry");
    assert.equal(requests.length, 1, "exactly one real load fired");
    assert.ok(
      requests.every((url) => url.includes("token=")),
      "no request was ever issued with an empty token",
    );
    assert.ok(
      requests[0].includes("token=tok789"),
      "the recovered load carries the delivered token",
    );
    assert.ok(
      cache.get("C:\\imgs\\A.png"),
      "the image is cached after the retry recovered it",
    );
    assert.equal(cache.hasFailed("C:\\imgs\\A.png"), false);
  } finally {
    restore();
  }
});

// Installs the window/location/Image globals renderer.mjs's ImageCache
// reads, and restores the previous values afterwards.
function fakeBrowserEnvironment() {
  const previous = {
    window: globalThis.window,
    location: globalThis.location,
    Image: globalThis.Image,
  };
  globalThis.window = { __TAURI__: true, framecodeDesktop: null };
  globalThis.location = { origin: "http://localhost:5173" };
  globalThis.Image = class {
    set src(url) {}
  };
  return () => {
    globalThis.window = previous.window;
    globalThis.location = previous.location;
    globalThis.Image = previous.Image;
  };
}
