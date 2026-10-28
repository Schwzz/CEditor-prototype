# Editing foundation and three feature groups

Authorized 2026-10-28: fix the editing foundation, then implement the first three rows of the proposed feature table: Timeline, Layers, Preview. The user requested execution; no additional approval gate. Retain Electron Windows desktop packaging and the existing code language. Do not implement media/audio/export/plugins/AI in this pass.

## Approach
Extend the existing restricted parser and shared history instead of replacing the project format or renderer. Existing statement root strings become stable keys; optional `.label("Display name")` permits renaming without changing keys or breaking old files. Retain the 60s/24-clip limits until real media and performance work justify increasing them. No export renderer exists to unify yet.

## Goals
- Foundation: stable identity on rename; validated batch edits apply atomically and create one Undo step; invalid drafts preserve the last valid model. Single/multiple selection remains linked across panels.
- Timeline: 1x–4x zoom and horizontal scroll, optional snap to frame/playhead/other clip edges, 30fps frame stepping, Ctrl/Shift click selection, group movement with shared boundary clamping.
- Layers: rename, earlier/later source stacking, hide and lock each clip. Persist in code via label/hidden/locked. Hidden clips do not render/hit-test; locked clips remain selectable in timeline but visual editing and destructive commands cannot alter them. No mute control until audio exists.
- Preview: text/shape corner resizing, rotation handle, logical-coordinate movement, center alignment guides, numeric X/Y/scale/rotation/opacity controls. Rotation degrees, scale 0.1–4, opacity 0–1. Use identical geometry for drawing, picking, outlines, and handles. Scenes fill the frame and have no transform handles.

## Validation
Unit tests for label identity and source preservation; batch failures/no partial edit; group bounds/snapping; flags/locks; transform geometry and rotated hit testing. Electron tests exercise controls, real pointer gestures, undo, file persistence, and existing lifecycle regressions. Windows CI packages and launches the deliverable. Continue hands-on DPI/IME/accessibility testing as a remaining improvement.
