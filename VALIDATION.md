# Windows prototype validation

## Local verification

- `npm run check`: JavaScript module syntax checks.
- `npm test`: Node test-suite covering the parser, positions, timing/source operations, continuous splitting, clipboard parameter conflicts, shared history, saved-state races, project validation, atomic replacement, recovery ordering, guide examples, settings persistence and validation, recents capping, preview geometry, and the Tauri desktop-bridge contract (every method surface, the shared `desktop:command` subscription lifecycle, and the clipboard editing commands). Media coverage: clip timing and the video pool (clock math, drift threshold, seek gating, eviction), video fit math, media clipboard parity, the media write guard and version ceiling, the 0.4 provenance text, and the CSP rule that allows same-origin media.
- `npm run build`: bundles CodeMirror and the renderer with esbuild, without external runtime resources.
- `cargo fmt --check`, `cargo check --locked`, `cargo test --locked` (src-tauri): Rust formatting, compilation, and the persistence/lifecycle unit and integration tests, including the window-lifecycle rules the native shell enforces (title text, dirty/stage validation, close decisions, unsaved-choice mapping, zoom steps), media probing, the range parser, and the 8 MiB media-response cap.
- `npm run test:tauri`: launches the real Tauri executable and drives it over WebView2's DevTools protocol — boot to Home with no uncaught startup errors, the full desktop-bridge surface installed, a real `appInfo` IPC round trip, the Stage 3 file operations (Open Recent → Save → recents), the Stage 4 asset pipeline (token delivery, the same-origin request matrix, an untainted canvas pixel read, recovery relinking), the Stage 5 window lifecycle (dirty/stage/code-panel/templates commands, stage validation, the close-handshake refusal on a dirty document, and a clean attestation that really ends the process), and the Stage 6 media slice: the range request matrix (206/416/HEAD, authorization before range handling), a media project save round-trip, a real MP4 opened through the Home → Recents flow with seek-and-paint assertions on the canvas, and a 512 MiB open-ended range answered as a bounded 8 MiB prefix without matching process growth.
- `npm run build:tauri`: the Tauri release build (executable + NSIS installer).

## Test environment and limits

The smoke test drives the real app through the DevTools protocol, so everything it asserts happened in the shipped runtime. Native dialogs (the unsaved-change Save / Don't Save / Cancel box, Open/Save pickers) cannot be driven unattended: their decision logic is covered by Rust tests, and their on-screen presentation is verified by hand. Human testing of native menu interaction, multiple monitors, mixed display scaling, IME input, and accessibility tools is still useful.

## Media verification scope

The Stage 6 decode check uses a generated 2-second, 160×90, 10 fps H.264 fixture whose first second is red and second second is blue. It proves the full path end to end: authorized range serving, container probing, decoder startup, seeking to a real source time, and painting the decoded frame on the app-origin canvas. It does not prove production-scale behaviour. No 30-second 1080p file, long playback session, hardware-decoder variation, 4K/high-bitrate content, or other container/codec combination was exercised by automation; those remain manual checks.

The 512 MiB case is a sparse fixture that proves an open-ended `Range: bytes=0-` is answered with an 8 MiB `206` prefix and that the app process does not grow by the file size. It does not play the file: it verifies the bounded-response rule, not full-length playback. The cap applies to ranged requests; a range-less request is still served whole.

## Windows CI gates

The Windows workflow must pass all of the following before producing a successful downloadable artifact:

1. Linux syntax/core tests and renderer build.
2. Windows dependency installation and renderer build.
3. Rust formatting, cargo check, and the Rust test suite.
4. The Tauri release build (executable + NSIS installer).
5. Launch of the real app and the full smoke-test check list.
6. SHA256 checksum generation and upload of the executable and installer.

Build results are authoritative in GitHub Actions. This document describes the gates; it does not claim a particular remote run passed before its result exists.

## Intentional prototype limits

Video import, decoding, and muted preview playback are implemented. Audio clips can be stored, saved, and relinked, but they do not play, and no video or audio is rendered to a file. Keyframes, cloud projects, collaboration, third-party plugin loading, and an AI-agent connection are not implemented. Non-media positions and motions are procedural. The Windows executables are unsigned and no automatic update service is installed.
