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
// command, and a tokenless asset URL is always rejected. These tests prove
// the cache makes token readiness deterministic: no doomed request fires,
// and queued images start loading on their own the moment the token is
// delivered — with no unrelated user interaction.
test("a tokenless asset request is queued, never fired", async () => {
  const restore = fakeBrowserEnvironment();
  globalThis.window.framecodeDesktop = {
    assetToken: "",
    whenAssetTokenReady: () => new Promise(() => {}), // never settles
  };
  try {
    const requests = [];
    globalThis.Image = class {
      set src(url) {
        requests.push(url);
      }
    };
    const cache = new ImageCache();
    cache.get("C:\\imgs\\A.png");
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
    let token = "";
    let deliverToken;
    const tokenReady = new Promise((resolve) => {
      deliverToken = resolve;
    });
    globalThis.window.framecodeDesktop = {
      get assetToken() {
        return token;
      },
      whenAssetTokenReady: () => tokenReady,
    };
    globalThis.Image = class {
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
    const cache = new ImageCache();
    assert.equal(cache.get("C:\\imgs\\A.png"), null);
    assert.equal(requests.length, 0, "no doomed request while awaiting");

    // The token arrives on its own — no user interaction of any kind.
    token = "tok123";
    deliverToken("tok123");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

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

test("failed token delivery fires zero requests and keeps sources queued", async () => {
  const requests = [];
  const restore = fakeBrowserEnvironment();
  try {
    let token = "";
    let deliverToken;
    // The bridge resolves readiness with "" when delivery fails — the
    // cache must not mistake that for a usable token.
    const tokenReady = new Promise((resolve) => {
      deliverToken = resolve;
    });
    globalThis.window.framecodeDesktop = {
      get assetToken() {
        return token;
      },
      whenAssetTokenReady: () => tokenReady,
    };
    globalThis.Image = class {
      set src(url) {
        requests.push(url);
        queueMicrotask(() => {
          if (url.includes("token=")) this.onload?.();
          else this.onerror?.();
        });
      }
    };
    const cache = new ImageCache();
    cache.get("C:\\imgs\\A.png");
    assert.equal(requests.length, 0, "no request while awaiting");

    // The delivery fails: readiness settles with an empty token.
    deliverToken("");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

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
  } finally {
    restore();
  }
});

test("a retried token delivery recovers the queued images", async () => {
  const requests = [];
  const restore = fakeBrowserEnvironment();
  try {
    let token = "";
    let deliverFirst;
    let deliverRetry;
    const firstDelivery = new Promise((resolve) => {
      deliverFirst = resolve;
    });
    const retryDelivery = new Promise((resolve) => {
      deliverRetry = resolve;
    });
    let ready = firstDelivery;
    globalThis.window.framecodeDesktop = {
      get assetToken() {
        return token;
      },
      // Returns the desktop's current readiness signal; a retry
      // installs a fresh one.
      whenAssetTokenReady: () => ready,
    };
    globalThis.Image = class {
      set src(url) {
        requests.push(url);
        queueMicrotask(() => {
          if (url.includes("token=")) this.onload?.();
          else this.onerror?.();
        });
      }
    };
    const cache = new ImageCache();
    cache.get("C:\\imgs\\A.png");

    // First delivery fails.
    deliverFirst("");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, "failed delivery fires nothing");

    // The desktop retries: a new token and a fresh readiness signal.
    token = "tok456";
    ready = retryDelivery;
    // The next render calls get() again — the queue re-arms and the
    // recovered delivery starts the real load.
    cache.get("C:\\imgs\\A.png");
    deliverRetry("tok456");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests.length, 1, "exactly one real load fired");
    assert.ok(
      requests[0].includes("token=tok456"),
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
