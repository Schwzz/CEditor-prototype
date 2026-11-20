// Stage 6 media pool: one <video> element per active video clip, slaved to
// the composition clock.
//
// The composition clock stays the UI authority: `current` (theme time) is
// what the timeline, inspector and renderer read. Video elements are
// followers — they are seeked to `sourceTimeFor(clip, clock)` when the
// transport pauses or jumps, and allowed to run between frames while
// playing. Drift is corrected only when it exceeds a frame-and-a-half, so
// playback is never a seek-per-frame loop.
//
// The pool is deliberately injectable (`createElement`) so the seek/drift
// policy is testable in Node without a DOM.

import { visibleClips } from "../core/engine.mjs";
import { assetUrl } from "./renderer.mjs";

/// One decoder per active clip, capped so a dense timeline cannot open
/// dozens of hardware decoders at once.
export const MAX_VIDEO_ELEMENTS = 4;

/// Correct a playing element once it is more than 1.5 frames from where the
/// composition clock says it should be (the plan's drift policy).
export const DRIFT_TOLERANCE_SECONDS = 1.5 / 30;

/// How long `seekTo` waits for a `seeked` event before rendering whatever
/// frame is decoded; a slow or stalled range request must never freeze the
/// transport.
export const SEEK_TIMEOUT_MS = 1500;

/// The source time a clip should show at composition time `time`.
export function sourceTimeFor(clip, time) {
  return (Number(clip.sourceAt) || 0) + (time - clip.at);
}

/// Whether an element has drifted far enough from the expected source time
/// to need a correcting seek.
export function needsCorrection(
  element,
  expected,
  tolerance = DRIFT_TOLERANCE_SECONDS,
) {
  if (!element) return false;
  return Math.abs((Number(element.currentTime) || 0) - expected) > tolerance;
}

/// Seeks one element and resolves when the browser reports `seeked` (or
/// when the timeout fires, with `false`). A target the element already
/// shows resolves immediately, so pausing on the current frame costs
/// nothing. Timers are injectable for tests.
export function seekTo(
  element,
  time,
  {
    timeoutMs = SEEK_TIMEOUT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {},
) {
  if (!element) return Promise.resolve(false);
  const target = Math.max(0, Number(time) || 0);
  if (
    Math.abs((Number(element.currentTime) || 0) - target) < 1e-3 &&
    Number(element.readyState) >= 2
  )
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (seeking) => {
      if (settled) return;
      settled = true;
      element.removeEventListener?.("seeked", onSeeked);
      clearTimer(timer);
      resolve(seeking);
    };
    const onSeeked = () => finish(true);
    const timer = setTimer(() => finish(false), timeoutMs);
    element.addEventListener?.("seeked", onSeeked);
    try {
      element.currentTime = target;
    } catch {
      finish(false);
    }
  });
}

export class VideoPool {
  #entries = new Map(); // clip id -> entry
  #listeners = new Set();
  #createElement;
  #max;
  #timers;
  #clock = 0;

  constructor({
    createElement = () => document.createElement("video"),
    max = MAX_VIDEO_ELEMENTS,
    timers = {},
  } = {}) {
    this.#createElement = createElement;
    this.#max = Math.max(1, max);
    this.#timers = timers;
  }

  /// The pool entry for a clip, creating its element on first use. A clip
  /// whose source changed gets a fresh element (the old URL is not
  /// reused); the same clip keeps its element across renders.
  entryFor(clip) {
    if (!clip || clip.type !== "video" || !clip.source) return null;
    const existing = this.#entries.get(clip.id);
    if (existing && existing.source === clip.source) {
      existing.lastUsed = ++this.#clock;
      return existing;
    }
    if (existing) this.#destroy(clip.id);
    const entry = this.#create(clip);
    this.#entries.set(clip.id, entry);
    this.#evictIfNeeded(clip.id);
    return entry;
  }

  /// The entry previously created for this clip, if any (render-only path).
  get(clip) {
    if (!clip) return null;
    return this.#entries.get(clip.id) || null;
  }

  #create(clip) {
    const element = this.#createElement();
    element.muted = true;
    element.preload = "auto";
    element.playsInline = true;
    const entry = {
      clip,
      source: clip.source,
      element,
      ready: false,
      failed: false,
      width: 0,
      height: 0,
      lastUsed: ++this.#clock,
    };
    const measure = () => {
      const width = Number(element.videoWidth) || 0;
      const height = Number(element.videoHeight) || 0;
      if (width > 0 && height > 0) {
        entry.width = width;
        entry.height = height;
      }
      entry.ready = Number(element.readyState) >= 2 || entry.ready;
      this.#emit(entry.source);
    };
    element.addEventListener("loadedmetadata", measure);
    element.addEventListener("loadeddata", measure);
    element.addEventListener("canplay", measure);
    element.addEventListener("error", () => {
      entry.failed = true;
      this.#emit(entry.source);
    });
    const url = assetUrl(clip.source);
    // Under Tauri a tokenless asset URL is always rejected; wait for the
    // capability token instead of poisoning the entry with a failure.
    if (window.__TAURI__ && !(window.framecodeDesktop?.assetToken || "")) {
      const ready = window.framecodeDesktop?.whenAssetTokenReady?.();
      if (typeof ready?.then === "function")
        ready
          .catch(() => {})
          .then(() => {
            if (!entry.failed && entry.element === element)
              element.src = assetUrl(clip.source);
          });
    } else element.src = url;
    return entry;
  }

  #destroy(id) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    try {
      entry.element.pause?.();
      entry.element.removeAttribute?.("src");
      entry.element.load?.();
    } catch {
      // A detached element is already gone; nothing left to release.
    }
  }

  #evictIfNeeded(keepId) {
    while (this.#entries.size > this.#max) {
      const victim = [...this.#entries.entries()]
        .filter(([id]) => id !== keepId)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) return;
      this.#destroy(victim[0]);
    }
  }

  /// Seeks every video clip visible at `time` and awaits the seeks, so a
  /// paused transport paints the real frame it landed on.
  async seekActive(model, time) {
    const pending = [];
    for (const clip of visibleClips(model, time)) {
      if (clip.type !== "video") continue;
      const entry = this.entryFor(clip);
      if (!entry) continue;
      pending.push(
        seekTo(entry.element, sourceTimeFor(clip, time), this.#timers),
      );
    }
    await Promise.all(pending);
    for (const entry of this.#entries.values()) {
      if (entry.clip && !isActive(entry.clip, model, time))
        entry.element.pause?.();
    }
  }

  /// Starts (or keeps) playback of the video clips visible at `time`,
  /// seeking first when the element is outside the drift tolerance.
  playActive(model, time) {
    for (const clip of visibleClips(model, time)) {
      if (clip.type !== "video") continue;
      const entry = this.entryFor(clip);
      if (!entry) continue;
      const expected = sourceTimeFor(clip, time);
      if (needsCorrection(entry.element, expected)) {
        void seekTo(entry.element, expected, this.#timers);
      }
      if (entry.element.paused !== false) {
        try {
          const played = entry.element.play?.();
          played?.catch?.(() => {});
        } catch {
          // Autoplay refusal leaves the element paused; the composition
          // clock keeps running and the next sync retries.
        }
      }
    }
  }

  /// Per-frame drift control while playing: correct only entries beyond
  /// tolerance, start newly-visible clips, and pause clips that left the
  /// frame.
  syncActive(model, time) {
    for (const clip of visibleClips(model, time)) {
      if (clip.type !== "video") continue;
      const entry = this.entryFor(clip);
      if (!entry) continue;
      if (needsCorrection(entry.element, sourceTimeFor(clip, time))) {
        void seekTo(
          entry.element,
          sourceTimeFor(clip, time),
          this.#timers,
        );
      }
      if (entry.element.paused !== false) {
        try {
          entry.element.play?.()?.catch?.(() => {});
        } catch {
          // See playActive.
        }
      }
    }
    for (const entry of this.#entries.values()) {
      if (entry.clip && !isActive(entry.clip, model, time))
        entry.element.pause?.();
    }
  }

  pauseAll() {
    for (const entry of this.#entries.values()) entry.element.pause?.();
  }

  clear() {
    for (const id of [...this.#entries.keys()]) this.#destroy(id);
  }

  size() {
    return this.#entries.size;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(source) {
    for (const listener of this.#listeners) listener(source);
  }
}

function isActive(clip, model, time) {
  return time >= clip.at && time < clip.at + clip.for;
}
