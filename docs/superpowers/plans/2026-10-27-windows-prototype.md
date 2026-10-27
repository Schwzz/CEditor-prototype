# Windows Prototype Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver the eight approved improvements as a Windows desktop prototype with a downloadable build.

**Architecture:** Electron owns native operations; CodeMirror owns source editing. A restricted composition engine and shared document history power timeline, parameter and preview edits. A bundled renderer loads locally without a server.

**Tech Stack:** JavaScript ESM, Electron, CodeMirror 6, esbuild, electron-builder, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-27-windows-prototype-design.md`

## Global Constraints

- Windows x64 packaged app; no required browser tab or separate terminal.
- Keep code as a restricted language and preserve last-valid rendering.
- Logical preview dimensions: 1920×1080; composition duration 1–60 seconds, up to 24 clips, source under 50,000 characters.
- One source of truth and shared Undo/Redo; one completed drag is one edit.
- Do not implement community plugins or AI connectivity yet.
- Do not republish or modify the previous hosted browser prototype.

## Review Focus

- Invalid drafts, failed saves and cancelled native dialogs must retain source, history and dirty state.
- Dragging at display zoom, bottom-of-document scrolling and keyboard-only editing must remain aligned and usable.
- Quoted names, Unicode, parameter conflicts and malformed clipboard/project inputs must not corrupt source or gain native access.
- Splits and trims must preserve phase and respect composition/source bounds without tiny or negative clips.
- Autosave and Save operations finishing after another edit must not mark newer work clean or restore stale recovery.

### Task 1: Composition operations and shared history

**Files:** `src/core/engine.mjs`, `src/core/operations.mjs`, `src/core/document.mjs`, `tests/engine.test.mjs`, `tests/operations.test.mjs`, `tests/document.test.mjs`.

**Interfaces:** `compile(source) -> model`; `updateClip(source,id,properties) -> source`; `resizeClip(source,id,edge,time) -> source`; `splitClip(source,id,time) -> {source,id}`; clipboard and duplicate/delete operations return validated source. `DocumentStore` exposes source/model/error/selected/dirty, commit/undo/redo/select/load/markSaved plus a subscriber.

- [x] Write failing cases for positions, source offsets, split phase, edge limits, quoted labels, clipboard parameter conflicts, invalid source/history and save-after-new-edits.
- [x] Run tests to observe the missing operations fail.
- [x] Migrate existing parser/tests, implement atomic source operations and bounded shared history.
- [x] Run `npm test`; all core tests must pass.
- [x] Commit core changes and record progress.

### Task 2: Native shell and project persistence

**Files:** `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/project-files.mjs`, `tests/project-files.test.mjs`, `package.json`, `scripts/build.mjs`.

**Interfaces:** preload `framecodeDesktop` exposes explicit open/save/new/recovery/clipboard/dirty/confirm/close operations. `ProjectFiles` validates versioned data and writes atomically; caller owns selected native paths. Build emits `build/renderer` and packages only required local assets and desktop/core modules.

- [x] Write failing tests for project round trips, invalid/oversized/unsupported data, atomic replacement, recovery and failed writes.
- [x] Run those tests before implementation.
- [x] Implement sandboxed local shell, restricted IPC and native project dialogs with close/save coordination.
- [x] Run `npm test` and build renderer; failures must be resolved before proceeding.
- [x] Commit shell/persistence and record progress.

### Task 3: Desktop editing workspace and guide

**Files:** `src/renderer/index.html`, `src/renderer/app.mjs`, `src/renderer/editor.mjs`, `src/renderer/timeline.mjs`, `src/renderer/preview.mjs`, `src/renderer/renderer.mjs`, `src/renderer/guide.mjs`, `src/renderer/styles.css`, `tests/desktop-smoke.cjs`.

**Interfaces:** editor emits source and line selections; timeline emits validated timing actions; preview renderer returns the same geometry used for hit testing and drawing. The controller consumes `DocumentStore` and the preload API; no component writes files directly.

- [x] Add desktop smoke expectations for loaded shell/bridge, real CodeMirror caret/gutter, guide, linked selection, preview position updates, timeline resize/context operations, Undo/Redo and native file cancellation/recovery.
- [x] Run to observe missing UI failures where the environment supports Electron; otherwise preserve tests for Windows CI and report the limit.
- [x] Implement the workspace and built-in lessons, with keyboard-accessible menus and numeric alternatives to dragging.
- [x] Run core tests, build and desktop smoke; verify original and new interaction paths.
- [x] Commit UI and record progress.

### Task 4: Windows builds, documentation and review

**Files:** `.github/workflows/check.yml`, `electron-builder.yml`, `assets/`, `README.md`, `VALIDATION.md`, `docs/ROADMAP.md`.

**Interfaces:** `npm run build`, `npm run test:desktop`, `npm run dist:win` produce a tested Windows x64 installer and portable build; CI uploads artifacts and SHA256 hashes.

- [x] Add pinned dependency lockfile, build configuration and Windows workflow with tests before packaging.
- [x] Record exact verification results and future AI/plugin scope; no claims of Windows runtime testing without evidence.
- [x] Run all checks and inspect package contents, then obtain one independent whole-change review.
- [x] Resolve important review findings with regression tests, run suite again and push a reviewable feature branch/PR.
- [ ] Inspect Windows CI/build results and provide the artifact/run link with the final feature and follow-up report.
