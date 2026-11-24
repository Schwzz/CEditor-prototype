# Stage 6 — Media Engine: Technical Assessment & Implementation Plan

Status: **planning complete; implementation tracked separately as M1**
Base: `main` @ `d37d977` (Stage 5 merged). §1–§2 are a snapshot of that baseline.
Scope note: rendering/export is **out of scope** (Stage 8). This stage ends at
"video and audio can be imported, placed, trimmed, played back, and relinked".

## Approved decisions

1. **Document format stays v1.** No schema bump, no new fields, no side-car
   metadata. Media clips live in the existing `source` text and are referenced
   by path.
2. **Phases A–F are approved** in the order below.
3. **M1 is the first milestone** (§5), expanded to include the
   backward-compatibility guard in §3.0.
4. **Backward compatibility is a hard requirement**: an older Framecode build
   must never load a media project and later overwrite it as if the media were
   gone. §3.0 defines the guard, the exact failure behaviour and the message.
5. Rendering/export remains out of scope for Stage 6.

---

## 1. Current architecture (as built)

> Baseline snapshot of `main` @ `d37d977`, before Stage 6. M1 work on
> `stage-6-media-engine-m1` has since extended the clip vocabulary, asset
> kinds, bridge surface and project-format guard; read §1–§2 as the
> pre-Stage-6 starting point, not as the current branch state.

### 1.1 Document model — text is the single source of truth

`src/core/document.mjs` stores only `{ source, lastValid, selectedIds }` in a
150-step undo history; `dirty` is a fingerprint of `source + lastValid`.
`src/core/project-format.mjs` defines format `framecode-project` **version 1**
with exactly `format/version/source/lastValid`, capped at 1 MiB, and compiles
`lastValid` with the JS engine on read and write.

Consequence: there is **no binary state, no media table, and no side-car
metadata**. A media file can only be referenced by path, exactly like images
are today.

### 1.2 Composition engine — pure, no I/O

`src/core/engine.mjs` parses the DSL into `{ name, duration, params,
paramLines, clips }`. Clip vocabulary is fixed at
`scene | text | shape | image` (line 180). Every clip already has:

- composition timing: `at`, `for` (validated inside `duration`, 1–60 s)
- an animation-phase source window: `sourceAt` (default `0`) and
  `sourceDuration ??= sourceAt + for`, with
  `sourceAt + for <= sourceDuration <= 60`
- `hasSourceWindow` — **only** true when the author wrote `.sourceAt()` /
  `.sourceDuration()` (line 264–265)

`image` clips add `source` (path string) and `fit` (`contain|cover|fill`).
`visibleClips(model, time)` is a pure time-window filter.

**Key reuse point:** the source window is already a real trim model — it is
just currently interpreted as "seconds into an animation", not "seconds into a
file". `src/core/operations.mjs::timingBounds` already limits drag-trims to
`[at - sourceAt, at + sourceDuration - sourceAt]`, `resizeClip("start")`
shifts `sourceAt`, and `splitClip` preserves/re-bases `sourceAt`.

### 1.3 Preview and rendering — one canvas, synchronous, same-origin

- `src/renderer/renderer.mjs`: `ImageCache` (64 entries, token-gated queuing,
  load/fail listeners) builds same-origin URLs
  `/assets/?path=…&token=…`; `frameGeometry()` computes per-clip geometry and
  `renderFrame()` draws with `ctx.drawImage` for images.
- `src/renderer/preview.mjs`: a single `<canvas>` (`#canvas`, 1920×1080) with
  `renderFrame()`, hit-testing and transform gestures. **There is no DOM
  overlay layer over the canvas** — anything visible must be painted.
- `renderer.mjs` also holds selection handles and guide drawing, all
  canvas-native.

Same-origin serving is deliberate (canvas pixel reads must not taint), and
must be preserved for video frames.

### 1.4 Playback — wall-clock, composition-only

`src/renderer/app.mjs`:

- `frame(now)` advances `current += (now - previous) / 1000` and re-renders;
  `loop` wraps with `current %= duration`; `setPlaying(false)` cancels rAF.
- `seek()` clamps, stops playback, updates the transport and redraws.
- Clip time is never mapped to any media element; there is no decoder, no
  `currentTime` synchronization, no drift correction, no audio clock.

### 1.5 Timeline — one row per clip, type-coloured

`src/renderer/timeline.mjs` renders one row per clip (z-order = source order),
with `colors` keyed by clip type, `resizeClip`/`moveClips` gestures, frame
snapping (`FPS = 30`) and a duration-proportional ruler. There is **no
track/lane concept**.

### 1.6 Asset pipeline — the strongest part to build on

`src-tauri/src/assets.rs` implements the Electron-era security model:

- `MAX_ASSET_BYTES = 50 MiB`
- `ALLOWED_EXTENSIONS`: `jpg, jpeg, png, webp, gif` (image MIME only)
- per-webview `AssetAuthorizer` (normalized + canonical identities, symlink
  escape re-check) and `CapabilityTokens` (token ↔ webview label)
- one guard chain in `decide_asset_request`: method → absolute path → token →
  authorization → 403

`src-tauri/src/lib.rs::tauri_protocol` serves `/assets/` on the app origin.
**It calls `std::fs::read(&path)` and returns a single 200 body** — no
`Content-Length`, no `Accept-Ranges`, no `206`, no streaming. Authorization is
minted only in Rust at trusted moments (`scan_project_assets` on open/recent,
`image_import_dialog`, `relink_recovery_assets`); the renderer only ever
receives a token.

`src-tauri/src/composition.rs::image_clip_sources` is a **second
implementation of `compile()`** used to find asset paths for authorization and
recovery relink. `src-tauri/src/file_operations.rs` restricts the import
dialog to the five image extensions.

### 1.7 Bridge and tests

`src/renderer/tauri-bridge.mjs` exposes a frozen method map
(`importImage → image_import_dialog`, `relinkRecoveryAssets → …`), contract-
tested in `tests/tauri-bridge.test.mjs`, which enumerates the whole surface.
`scripts/test-tauri.mjs` boots the real app and asserts the bridge surface and
token shape.

---

## 2. Gaps and technical limitations

| # | Gap | Evidence | Impact |
|---|-----|----------|--------|
| G1 | No `video`/`audio` clip types | `engine.mjs:180` | Any media file is unrepresentable |
| G2 | No metadata anywhere | no probe call in renderer or Rust | cannot default duration, aspect, or validate trims |
| G3 | `sourceDuration <= 60` and composition 1–60 s | `engine.mjs:273,346` | most real clips are rejected |
| G4 | Asset protocol is not a media server | `lib.rs:203` (`fs::read`) | WebView2 cannot seek; whole files land in RAM |
| G5 | 50 MiB cap + image-only allowlist | `assets.rs:37,41` | video import impossible |
| G6 | Canvas-only compositing | `preview.mjs`, no overlay markup | video frames must be `drawImage`d frame-by-frame |
| G7 | Wall-clock playback, no media clock | `app.mjs:146` | no A/V sync, no seek-to-media-time, no drift control |
| G8 | Seek stops playback | `app.mjs` `seek()` | scrubbing/transport toggle behaviour is wrong for media |
| G9 | No track/lane model | `timeline.mjs` | audio rows collide with visual rows; z-order ambiguity |
| G10 | Relink scans images only | `composition.rs:377`, `assets.rs:414` | recovered drafts silently lose audio/video |
| G11 | Engine duplicated in Rust | `composition.rs` | every clip-type change needs a lockstep port |
| G12 | No decode-error surface | `renderer.mjs` draws only loaded images | unsupported codec shows a blank frame with no explanation |

Not a gap: `sourceAt`/`sourceDuration` trim mechanics, snapping, undo, autosave,
recovery, and per-webview authorization already exist and should be reused.

---

## 3. Recommended scope and phases

Guiding decisions:

1. **No new subsystem.** Media becomes two more clip types in the existing DSL,
   riding the existing source window, operations, history, snapping, format v1,
   and Rust asset gate.
2. **Metadata is derived, never persisted.** The probe result lives in an
   in-memory cache keyed by normalized path; the project file stays
   `source + lastValid`. This preserves format compatibility and avoids drift
   when a file is replaced.
3. **`sourceDuration` stays author-declared.** The engine is pure and
   Rust-parsed; it cannot know a real file length. Import writes
   `.sourceDuration(<probed>)`; playback clamps to the probe and surfaces
   mismatch instead of failing to compile.
4. **Relax the cap only for media clips** (declared `sourceDuration` up to
   1 h), leaving composition duration and all animation-clip rules untouched.
5. **Keep the same-origin token URL** for media; extend the Rust handler with
   byte ranges rather than adding direct file access to the renderer.
6. **Compatibility is enforced, not assumed** — the write-time invariant in
   §3.0 is what stops an older build from ever adopting a media project.

### 3.0 Backward-compatibility guard (mandatory, ships in M1)

Older builds cannot be patched, so the guard has to be carried by the files the
new build writes and enforced at the new build's own choke points.

**Requirement.** An older build must either open a media project with its media
intact or refuse it outright. It must never adopt the project and later rewrite
it as if the media were gone. Because the old binary cannot be changed, the only
lever is the *saved file*: a file that uses media must be unreadable by any build
that does not understand that media. The same rule applies to any
future clip type added under v1 — `declaresMedia` must be extended with it.

**What a 0.3 build actually does with a media project** (verified in code):

1. `src-tauri/src/project_files.rs` validates structure only — it does not
   compile the composition.
2. `src/core/project-format.mjs::decodeProject` delegates to `encodeProject`,
   which calls `compile(value.lastValid)`.
3. `src/core/document.mjs::load` compiles `lastValid` again *before* touching
   history.

So if `lastValid` contains a media statement, a 0.3 build throws
`Line N: Unknown function: video.` (in `engine.mjs::compile` at `d37d977`)
before adopting the document: no history entry, no autosave, no save path,
project file untouched.

**The invariant:** a saved project that uses media must have a `lastValid`
that also uses media. Every older build then fails at open, by construction.

**Why the invariant is not automatic.** `commit()` only advances `lastValid`
while the source compiles, but `saveSnapshot` (`app.mjs`) serializes the
*current* source and `encodeProject` compiles only `lastValid`. An author can
therefore: import a video → delete the media lines (a valid compile, making
`lastValid` media-free) → type broken media text. The saved file would then
have media in `source` and a media-free `lastValid` — exactly the silent-load
case an older build would accept.

**Guard design**

- **C1 — Save-time invariant enforcement (primary).** `encodeProject` gains a
  media-safety check on write: scan `source` for line-anchored `video(` /
  `audio(` statements (skipping `//` lines, mirroring the engine's line-based
  parser) and require `lastValid` to contain at least one. On violation it
  refuses to write and throws:

  > This project uses media, but its last valid composition does not. Saving is
  > blocked: an older Framecode version could open it and silently drop the
  > media. Fix the composition error, then save again.

  Opening such a file stays allowed (the decode path uses the canonicalizer,
  not the write guard), so the user can open it, see the error banner, repair
  it and save. Failing closed on the write is the only way to guarantee an
  older build never sees a media `source` with a legacy `lastValid`.
- **C2 — Version ceiling on open.** Split the current single
  "Unsupported or invalid Framecode project." rejection: `version > 1` now
  reports "This project was created by a newer version of Framecode. Update
  Framecode to open it." This makes the v1 decision explicit and protects the
  next format change.
- **C3 — Recovery and clipboard parity.** Recovery drafts go through
  `store.load` (which compiles `lastValid`), so a media draft fails to restore
  in an older build instead of half-adopting. Clipboard payloads are pasted
  through `commit`, which compiles, so a media clip pasted into an older build
  is rejected at paste. Both get regression tests rather than new code.
- **C4 — User-facing provenance.** The media import flow and the preview meta
  show "Media · requires Framecode 0.4+" (0.4 is the app release that ships
  this; the document format stays v1), and the release note documents that
  v1 files containing `video()`/`audio()` are intentionally unreadable by 0.3
  builds. This is the limit of what is achievable: the wording *inside* an old
  build is fixed, and it will read
  `Line N: Unknown function: video. The last valid preview is shown.`

**Deliberately not done**

- No `version` bump (approved decision).
- No advisory `features` field: `encodeProject` rebuilds the canonical object
  (so the field would be dropped on read) and old builds ignore unknown
  fields — it would add risk with no gate.
- No media embedding, no proxies, no schema change.

**Compatibility tests (part of M1)**

- `tests/project-files.test.mjs`: write guard rejects media `source` with a
  media-free `lastValid` (exact message); accepts media + media; `version: 2`
  yields the newer-version message; a v1 media fixture encodes/decodes
  round-trip unchanged.
- `tests/engine.test.mjs`: pin the legacy error contract — an unknown root
  produces `Unknown function: <name>.`; assert `video`/`audio` are the first
  tokens a 0.3 parser would reject, so the documented failure text stays true.
- `tests/document.test.mjs`: `load` still compiles `lastValid` before mutating
  history (media case), and a media project survives
  `serialize → encodeProject → decodeProject → load`.
- `tests/tauri-bridge.test.mjs`: `saveProject` and `writeRecovery` both route
  through `encodeProject`, so no second writer can bypass the media guard.
- `scripts/test-tauri.mjs`: save a media fixture in the real app, reopen it,
  and assert the on-disk `lastValid` still contains the media statement.

### Phase A — Media asset foundation (import, probe, streaming)

Dependencies: none. Blocks B, C, D, E.

- `src-tauri/src/media.rs` (new): extension registry
  - video: `mp4, mov, m4v, webm`
  - audio: `mp3, wav, m4a, aac, flac, ogg`
  - probe via a pure-Rust demuxer (`mp4`+`symphonia`), returning
    `{ duration, width, height, fps, video_codec, audio_codec, channels,
    sample_rate, rotation }`; hard timeout; failures return a structured error,
    never a panic
- `assets.rs`: asset-kind aware authorization (`AssetKind::Image|Video|Audio`),
  media size policy (stream, no whole-file read; a generous ceiling such as
  4 GiB), MIME + extension tables split per kind
- `lib.rs::tauri_protocol`: add `Range` support
  - signature change to receive headers (`decide_asset_request` must take the
    request headers, not just method/path/token)
  - `Accept-Ranges: bytes`, `Content-Length`, `206` + `Content-Range`,
    suffix/open-ended ranges, `416` on unsatisfiable, `HEAD` parity
  - range parsing in `u64`; authorization still runs **first** (403 before any
    byte accounting)
  - stream with a bounded buffer instead of `fs::read`
- `file_operations.rs`: `pick_media(kind)` dialog filters; keep `pick_image`
  untouched
- `engine.mjs`: `video()` and `audio()` clip types
  - shared: `at/for/sourceAt/sourceDuration`, `hidden/locked/label`
  - `video`: `source`, `fit`, existing transform props
  - `audio`: `source`, `gain` (0–2, default 1), transform props rejected
  - force `hasSourceWindow: true` for both; media `sourceDuration` ceiling 3600
- `composition.rs`: **lockstep** port — rename to `clip_sources()` returning
  `(Kind, path)`, keep `image_clip_sources` as a thin wrapper so existing
  callers/tests stay valid; add engine-parity tests for the new types
- `tauri-bridge.mjs` + `tests/tauri-bridge.test.mjs`:
  `importVideo`, `importAudio`, `probeMedia`
- Import UX (`app.mjs`): choose kind → pick file → probe → insert
  `video("Name").at(current).for(min(5, duration)).source(path).sourceDuration(duration)`

### Phase B — Video playback, seeking, synchronization

Dependencies: A.

- `src/renderer/media.mjs` (new):
  - `VideoPool`: one `<video>` per active video clip, capped (3–4 decoders),
    LRU-released; `muted`, `preload="auto"`, token URL
  - `sourceTimeFor(clip, t) = clip.sourceAt + (t - clip.at)`
  - `seekTo(element, time)` returning a promise resolved on `seeked` (with a
    timeout fallback that renders the last decoded frame)
  - drift policy: correct when `|el.currentTime - expected| > 1.5 / 30 s`
- `renderer.mjs`: `frameGeometry` video branch (same `fit` math as images,
  rotated/scaled identically) and `drawImage(el, …)` when
  `readyState >= HAVE_CURRENT_DATA`; otherwise a neutral placeholder + a
  "decoding" state item, never a silent blank
- `app.mjs`:
  - `frame()` keeps the composition clock as UI authority but slaves each
    playing video element to it
  - `seek()` becomes "pause → set every active element's `currentTime` → await
    `seeked` → paint once"; frame stepping (±1/30 s) uses the same path
  - playback start/stop fans out to the pool; loop wrap re-seeks all elements
- Gesture correctness: dragging/trimming a playing clip pauses it first
  (existing `onPause` hook), then resumes only on explicit play

### Phase C — Audio integration

Dependencies: A; shares the clock module from B.

- `src/renderer/media.mjs`: `AudioGraph` — one `AudioContext`, one
  `MediaElementAudioSourceNode` + `GainNode` per audio clip, master gain,
  `suspend()` while paused
- Clock authority: when audio is playing, the composition clock is **corrected
  against the audio element** (audio is the sample-accurate reference); video
  elements remain slaves. Target drift ≤ 20 ms audio, ≤ 1 frame video
- `timeline.mjs`: minimal lane grouping — `visual` lane (existing rows) and
  `audio` lane rendered beneath, derived from clip type. Data model stays
  one-row-per-clip; existing projects render identically
- Inspector: `gain` control for audio clips; position/transform fields hidden
- Canvas: audio contributes nothing to `frameGeometry`; selection and
  hit-testing stay in the timeline row only

### Phase D — Media duration, trimming, source-time semantics

Dependencies: A (+B/C for live feedback).

- Keep the declared-vs-actual rule: engine validates declared window;
  `timingBounds` additionally clamps to the probed duration in the UI layer
  (single helper in `media.mjs`, so operations stay pure)
- End-trim must not move `sourceAt` (already true); start-trim shifts it
  (already true); `splitClip` re-bases the right half (already true) — add
  explicit coverage for video/audio so regressions are caught
- Inspector: expose read-only `sourceAt` + "trim to playhead" actions for media
  clips (slip editing explicitly out of scope)
- Mismatch handling: if probe duration < declared `sourceDuration`, toast once
  per clip and clamp playback; if the file is shorter than `sourceAt + for`,
  show "source ends at Xs" on the clip instead of failing compile
- Snapping keeps working untouched (media edges are ordinary clip edges)

### Phase E — Missing media detection and relinking

Dependencies: A; reuses existing recovery plumbing.

- `app.mjs`: per-source runtime state from the media pool
  (`loading | ready | unauthorized | missing | unsupported`); a missing or
  unauthorized clip renders a labelled placeholder in the preview and a warning
  badge on its timeline row
- Relink flow: pick file → Rust authorizes (normal gates) → `updateClip`
  rewrites `.source()` → single undoable history entry → cache evicts and
  reloads
- Recovery: `relink_recovery_assets` uses the extended `clip_sources()` scan, so
  video/audio appear in the consent dialog; the dialog copy becomes
  "Relink media" (images unchanged in behaviour)
- `scan_project_assets` on open/recent already authorizes whatever the scan
  returns — no extra wiring once the scan is extended
- Open must stay resilient: a missing media file never fails the project open
  (current image behaviour)

### Phase F — Codec compatibility and large-file reliability

Dependencies: A+B+C.

- Pre-flight on import: probe + a can-decode check in the WebView (a short
  detached `loadedmetadata`/`error` race). Unsupported combos (HEVC without the
  codec pack, ProRes, some MKV/VP9-in-MP4) fail with an actionable message
  *before* a clip is inserted
- Large files: assert no code path reads a media file wholly into memory; test
  multi-GiB sparse files; verify range seeks near EOF and 4 GiB+ offsets;
  verify aborted/rapid seeks do not leak decoders or throw unhandled rejections
- Stress: 10+ clips on one timeline with 3 concurrent decoders; scrub while
  playing; loop wrap; project reopen with all elements re-created
- Robustness: probe timeout, unreadable file, deleted-while-open, and
  token-expiry-style 403s all produce a defined UI state

---

## 4. Acceptance criteria and focused tests

### Phase A
- [ ] Importing an MP4/MOV/WebM creates a `video()` clip whose `.for()` and
      `.sourceDuration()` come from the probe, and the file compiles.
- [ ] `GET /assets/?path=…&token=…` with `Range: bytes=0-1023` returns `206`,
      `Content-Range`, `Accept-Ranges: bytes`, exact 1024 bytes.
- [ ] The same URL without a token, or for a non-media extension, still returns
      `403`/`400` **before** any range handling.
- [ ] A 500 MB file plays without the process growing by 500 MB.
- [ ] Old v1 projects open unchanged; every existing test stays green.
- [ ] A media project writes a `lastValid` that contains media, so a 0.3 build
      throws `Unknown function: video.` at open and adopts nothing (§3.0 C1).
- [ ] Saving a source with media text but a media-free `lastValid` is refused
      with the §3.0 message, and the file is not written.
- [ ] Opening a `version: 2` file reports the newer-version message, not the
      generic one.
- Tests: `tests/engine.test.mjs`, `tests/operations.test.mjs`,
      `tests/project-files.test.mjs`, `tests/document.test.mjs`,
      `tests/tauri-bridge.test.mjs`, `src-tauri` unit tests in `media.rs` /
      `assets.rs` (range parser: closed, open-ended, suffix, inverted, huge,
      zero-length), `scripts/test-tauri.mjs` (real-app range probe + media save
      round-trip).

### Phase B
- [ ] Playhead at `t` paints the frame at `sourceAt + (t - at)` (±1 frame).
- [ ] Scrubbing then pausing lands on the requested frame, not the previous one.
- [ ] 10 s of playback keeps video within ±1 frame of the composition clock.
- [ ] Loop wrap re-seeks and continues without a stale frame.
- [ ] Trimming/dragging a clip pauses playback and paints a consistent frame.
- Tests: new `tests/media.test.mjs` (clock math, drift thresholds, seek gating,
      pool eviction), `tests/renderer.test.mjs` (video branch, fit math,
      not-ready placeholder), `scripts/test-tauri.mjs` (seek + paint smoke).

### Phase C
- [ ] Audio import produces an `audio()` clip in the audio lane with a gain
      control; visual rows are unchanged.
- [ ] Play/pause/seek start and stop audio at the same composition time as
      video (±20 ms).
- [ ] Loop wrap does not double-trigger or clip audio.
- [ ] Muting the app (or no audio clips) leaves video timing unaffected.
- Tests: `tests/media.test.mjs` (audio graph lifecycle, gain mapping),
      `tests/renderer.test.mjs` / `tests/operations.test.mjs` (lane derivation,
      audio inspector field set).

### Phase D
- [ ] Start-trim of a video clip shifts `sourceAt` by exactly the delta and
      paints the new first frame.
- [ ] End-trim leaves `sourceAt` untouched and cannot exceed probed duration.
- [ ] Splitting a media clip yields two clips with correct `sourceAt`/`for`.
- [ ] Declared `sourceDuration` > probed duration warns once and clamps
      playback instead of failing compilation.
- Tests: `tests/operations.test.mjs` (trim/split matrix for both new types),
      `tests/engine.test.mjs` (declared window validation, cap boundaries).

### Phase E
- [ ] Deleting/renaming a media file marks the clip missing without breaking
      the project, the preview, or autosave.
- [ ] Relink authorizes, rewrites `.source()`, is undoable, and immediately
      renders.
- [ ] Recovered draft with video/audio offers "Relink media" listing those
      files, not only images.
- Tests: `src-tauri` tests for `clip_sources()` and relink candidates,
      `tests/tauri-bridge.test.mjs` (new methods), `scripts/test-tauri.mjs`
      (missing → relink round-trip).

### Phase F
- [ ] Unsupported codec is rejected at import with a specific message; no clip
      is inserted and no console error escapes.
- [ ] 4 GiB+ sparse file seeks correctly; memory stays flat.
- [ ] Rapid 20× scrubbing leaks neither decoders nor intervals.
- Tests: `src-tauri` range/stream tests, `tests/media.test.mjs` (pool under
      churn), `scripts/test-tauri.mjs` (large-file and churn smoke).

---

## 5. Recommended first milestone

**M1 — "Import a video, see a real frame, seek to a real frame."**
A vertical slice, no audio, no playback sync yet:

1. `src-tauri/src/media.rs` probe + `media_import_dialog("video")` +
   `video` extensions in the authorization registry.
2. Range-capable `/assets/` serving with the guard chain unchanged and
   authorization still first.
3. `engine.mjs` `video()` clip type (declared source window, media-only cap
   relaxation) + lockstep `composition.rs` port.
4. `renderer.mjs` video branch drawing a paused frame; `media.mjs` with a
   single-element pool and `seekTo`.
5. `app.mjs` seek path that awaits `seeked` before painting; import appends a
   probed clip.
6. Bridge methods + contract test + one real-app smoke assertion
   (206 on a range request, frame painted after seek).
7. §3.0 compatibility guard: save-time media invariant (C1) + version ceiling
   (C2) + provenance note (C4), plus the recovery/clipboard parity tests (C3),
   with the §3.0 tests.

Definition of done: on Windows, import a 30 s 1080p MP4, see it in the
timeline with a 30 s source window, click at 0:12 and see the correct frame,
close and reopen the project and get the same behaviour — with the full
existing suite green and format v1 untouched. In addition, the saved file's
`lastValid` contains the media statement, the write guard refuses the
stale-`lastValid` case with the §3.0 message, and a 0.3 build opening the
project fails with `Unknown function: video.` without adopting or rewriting
anything.

Why this slice first: it proves the three riskiest assumptions at once — that
the pure engine can carry real media without a format change, that the
authorized same-origin protocol can stream ranges, and that the single-canvas
renderer can show decoded frames — before any clock, audio, or relink work
depends on them. It also locks the compatibility contract before media files
exist in the wild.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Engine/Rust drift silently drops media authorization | single `clip_sources()` port + parity tests in both languages; fail-closed scan |
| Canvas taint from video frames | keep same-origin token URL; never `crossOrigin=""`/blob-from-file; assert pixel read in a smoke test |
| Decoder exhaustion on many clips | pool cap + LRU + placeholders; stress test in F |
| Audio clock vs rAF clock fight | one authority at a time (audio when present), slaved video, explicit drift thresholds |
| 30 fps grid vs 23.976/29.97/60 sources | always seek in seconds, never in frame indices; no frame-rate assumptions in `media.mjs` |
| Autoplay policy blocks audio | playback is user-initiated; `AudioContext.resume()` on play; video muted |
| Old builds opening media projects | §3.0: media `lastValid` gates the open (`Unknown function: video.`), save-time invariant guard prevents the stale-`lastValid` hole, version ceiling gives the forward message; no format bump |
| 1 MiB project cap | paths only; unchanged |

## 7. Explicitly out of scope

Rendering/export (Stage 8), proxies/transcoding, waveforms and thumbnail
strips, slip/ripple editing, full multi-track lanes, keyframes, per-clip
effects, and any change to the saved project schema.
