# Editing Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task by task.

**Goal:** Strengthen identity/history then deliver timeline tools, layer controls and preview transforms in the Windows prototype.
**Architecture:** Extend restricted source statements and one DocumentStore. Pure operations/maths feed renderer controllers; no new runtime dependencies.
**Tech Stack:** Electron 45, CodeMirror 6, canvas, Node tests.
**Spec:** docs/superpowers/specs/2026-10-28-editing-basics-design.md

## Global Constraints
Windows desktop only. Preserve version1 project files and old code. No media/export/plugin/AI implementation. Limits 60s/24 clips remain.

## Review Focus
- Rename/reorder with quoted method-like labels keeps stable identity and comments.
- Invalid/locked members cause entire group operation to reject without partial commit.
- Source changes mid-gesture cancel the pending gesture.
- Rotated/scaled objects draw and hit-test the same; hidden/locked objects cannot accidentally be manipulated.
- Zoom/scroll and frame snapping remain accurate near both timeline boundaries.

### Task 1: Foundation
Files: engine.mjs, operations.mjs, document.mjs; tests/editing.test.mjs.
Interfaces: updateClips(source, [{id,properties}]) -> source, moveClips(source, ids, delta) -> source, store.selectedIds and store.select(id,{toggle,add}).
- [x] Add RED tests for display label identity, batch atomicity, multiple selection, locked operations.
- [x] Add typed label/hidden/locked/scale/rotation/opacity validation; atomic updates and lock guards; multiple selection.
- [x] Run npm test, commit.

### Task 2: Timeline
Files: new core/timeline-math.mjs; renderer/timeline.mjs, app.mjs, index.html, styles.css; tests/editing.test.mjs and desktop-smoke.cjs.
Interfaces: snapTime(value,targets,threshold); movementBounds(model,ids); createTimeline.setZoom(value), setSnap(value).
- [x] Add RED math and desktop tests for group movement, zoom, snap and frame stepping.
- [x] Add zoom controls/scroll geometry, frame snap/clip snap, selection and group gestures with one commit.
- [x] Run Node tests and desktop checks, commit.

### Task 3: Layers
Files: operations.mjs; new renderer/layers.mjs; app.mjs, index.html, styles.css; tests/editing.test.mjs and desktop-smoke.cjs.
Interfaces: renameClip(source,id,label); reorderClip(source,id,direction); layer manager uses shared callbacks.
- [x] Add RED identity/order/hidden/locked and desktop control tests.
- [x] Add rename, reorder, visibility and lock controls; synchronize selection and guard editing paths.
- [x] Run Node tests and desktop checks, commit.

### Task 4: Preview transforms
Files: new renderer/geometry.mjs; renderer.mjs, preview.mjs, app.mjs, index.html, styles.css; tests/editing.test.mjs and desktop-smoke.cjs.
Interfaces: frameGeometry and shared local/world transform functions; preview gestures commit validated scale/rotation/position changes.
- [x] Add RED transformed picking/handle geometry and real pointer tests.
- [x] Add handles/guides and exact transform inspector; selection outlines for all selected objects; cancel stale gestures.
- [x] Run Node tests, syntax, build and desktop checks, commit.

### Task 5: Review and Windows delivery
Files: README.md, VALIDATION.md, docs/IMPLEMENTATION_REPORT.md, ROADMAP.md, guide.mjs, package.json/lock.
- [x] Update lessons/docs/version; run full verification and review the entire change with a fresh reviewer.
- [x] Reproduce and fix important findings; record remaining limitations.
- [ ] Publish branch/PR, verify Windows CI, provide exact download run and feature report.
