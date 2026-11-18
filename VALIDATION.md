# Windows prototype validation

## Local verification

- `npm run check`: JavaScript module syntax checks.
- `npm test`: Node test-suite covering the parser, positions, timing/source operations, continuous splitting, clipboard parameter conflicts, shared history, saved-state races, project validation, atomic replacement, recovery ordering, guide examples, settings persistence and validation, recents capping, preview geometry, and the Tauri desktop-bridge contract (every method surface, the shared `desktop:command` subscription lifecycle, and the clipboard editing commands).
- `npm run build`: bundles CodeMirror and the renderer with esbuild, without external runtime resources.
- `cargo fmt --check`, `cargo check --locked`, `cargo test --locked` (src-tauri): Rust formatting, compilation, and the persistence/lifecycle unit and integration tests, including the window-lifecycle rules the native shell enforces (title text, dirty/stage validation, close decisions, unsaved-choice mapping, zoom steps).
- `npm run test:tauri`: launches the real Tauri executable and drives it over WebView2's DevTools protocol — boot to Home with no uncaught startup errors, the full desktop-bridge surface installed, a real `appInfo` IPC round trip, the Stage 3 file operations (Open Recent → Save → recents), the Stage 4 asset pipeline (token delivery, the same-origin request matrix, an untainted canvas pixel read, recovery relinking), and the Stage 5 window lifecycle: dirty/stage/code-panel/templates commands, stage validation, the close-handshake refusal on a dirty document, and a clean attestation that really ends the process.
- `npm run build:tauri`: the Tauri release build (executable + NSIS installer).

## Test environment and limits

The smoke test drives the real app through the DevTools protocol, so everything it asserts happened in the shipped runtime. Native dialogs (the unsaved-change Save / Don't Save / Cancel box, Open/Save pickers) cannot be driven unattended: their decision logic is covered by Rust tests, and their on-screen presentation is verified by hand. Human testing of native menu interaction, multiple monitors, mixed display scaling, IME input, and accessibility tools is still useful.

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

No media import, audio, rendered-video export, keyframes, cloud projects, collaboration, third-party plugin loading, or AI-agent connection is implemented. Positions and motions are procedural. The Windows executables are unsigned and no automatic update service is installed.
