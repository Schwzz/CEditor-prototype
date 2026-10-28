# Windows prototype validation

## Local verification

- `npm run check`: JavaScript module syntax checks.
- `npm test`: 47 tests covering the parser, positions, timing/source operations, continuous splitting, clipboard parameter conflicts, shared history, saved-state races, project validation, atomic replacement, recovery ordering, guide examples, and preview geometry.
- `npm run build`: bundles CodeMirror and the renderer with esbuild, without external runtime resources.
- `npm run test:desktop`: 35 integration checks in a real Electron process, including actual pointer input and filesystem writes.

Desktop integration covers source/parameter synchronization, linked selection, timing handles, one-step drag Undo, preview hit testing/movement, context-menu splitting, clipboard snapshots, cancelled saves, native project serialization, invalid-source recovery, saving invalid drafts, unsaved Open/Close cancellation, cancelled and successful Open, recovery-cleanup failures, failed Save As, closing with Save and cancelled pickers, New/reset history, guide loading, scrolling/caret alignment at 100% and 125% zoom, recovery across window recreation, saving a restored draft, and preserving recovery when closed before a choice.

The editing pass adds stable label identity, atomic batches/group bounds, lock rejection, visibility, reordering, 30fps stepping, zoom, snapping, transformed picking, numeric transform controls, and real pointer resizing/rotation with one-step undo.

The editor regression checks verify that a long document scrolls inside the editor, line-number and text rows stay aligned, and the caret remains centered on its line. The checks caught and corrected a flex layout that initially allowed long source to stretch the workspace.

## Test environment and limits

Local desktop integration runs on Linux using Electron's headless Ozone backend. The restricted execution container needs a test-launch-only `--no-sandbox` flag; the application window configuration retains sandboxing and shipped Windows launches do not use that flag. Desktop host-service diagnostics about unavailable D-Bus/udev/netlink services are environment messages, not renderer errors.

Native file-dialog choices are test fixtures so tests do not require a person to select files. Serialization, atomic writes, clipboard APIs, source editor, pointer gestures, and app state transitions execute for real. Human testing of actual Windows dialog presentation, multiple monitors, mixed display scaling, IME input, and accessibility tools is still useful.

## Windows CI gates

The Windows workflow must pass all of the following before producing a successful downloadable artifact:

1. Linux syntax/core tests and renderer build.
2. Windows dependency installation and renderer build.
3. The Electron desktop integration suite on Windows, without the Linux headless flags.
4. Portable executable and installer packaging.
5. Launch of `release/win-unpacked/Framecode.exe` and detection of its initialized native window title.
6. SHA256 checksum generation and upload of both Windows executables.

Build results are authoritative in GitHub Actions. This document describes the gates; it does not claim a particular remote run passed before its result exists.

## Intentional prototype limits

No media import, audio, rendered-video export, keyframes, cloud projects, collaboration, third-party plugin loading, or AI-agent connection is implemented. Positions and motions are procedural. The Windows executables are unsigned and no automatic update service is installed.
