# Windows prototype implementation report

## 0.3.0 editing pass — 28 October 2026

The authorized first three feature groups are Timeline, Layers and Preview.

- Foundation fixes: separate stable keys from display labels; compile batch edits before committing; shared multiple selection; locks reject whole group edits without partial changes. Legacy version1 project files and long stable keys remain readable.
- Timeline: 1×–4× zoom with horizontal scrolling, optional snapping to frames/playhead/clip edges, 30fps stepping, Ctrl/Shift multi-selection and group drag/nudge/Delete.
- Layers: rename, backward/forward source stacking, hide/show and lock/unlock, persisted as readable source methods.
- Preview: uniform corner resizing, rotation handle, Shift 15° rotation snapping, exact scale/rotation/opacity/X/Y fields, center guides, and shared transformed geometry for picking and outlines.
- One completed gesture/batch is one shared Undo step. Inspector fields and Copy/Cut/Duplicate/Split operate on the primary selection. Locks protect visual/destructive commands; intentional code/shared-parameter edits remain possible.
- Fixed two issues caught by the desktop checks: the seek slider was rounding frame times to centiseconds; a synchronous ResizeObserver width update caused a layout feedback warning at zoom changes.

Local verification: 46 Node tests and 35 real Electron checks pass, alongside syntax/build checks. Pointer tests cover zoom plus horizontal scrolling, actual corner/rotation handles, and source changes during a gesture. The test harness now carries the held-left-button flag on drag moves; without it Chromium released pointer capture and produced a false scrolled-resize failure. Independent review found no Critical issues and two Important issues: a boundary no-op collapsed a group selection, and preview movement changed hidden selected layers. Both were reproduced by failing regressions and fixed. No actionable Minor issues were reported. The Windows CI result is linked at handoff.



## Original desktop scope

1. Electron desktop window and Windows x64 portable/installer packaging; no server, browser tab, separate terminal or account required by the packaged app.
2. CodeMirror source editor with one caret/text/gutter layout, dark syntax colors, code search, and verified long-document scrolling at 100%/125% zoom.
3. Nine built-in guide lessons with complete examples, exercises, language reference and shortcut explanations.
4. Preview hit testing, shared selection outlines, pointer/keyboard positioning, numeric X/Y controls, and playback pausing during movement.
5. Timeline moving, left/right resize handles, numeric start/end/length editing, keyboard alternatives and composition/source boundaries.
6. Right-click and Shift+F10 clip tools: split, cut/copy/paste, duplicate, delete, and precise timing.
7. Shared bounded Undo/Redo across source, parameters and gestures; one completed drag is one undo entry. Invalid code keeps its last valid composition.
8. Versioned local project files, native Open/Save/Save As dialogs, atomic replacement, autosave recovery and Save/Discard/Cancel handling.

The desktop panels remain inside the window. Code, inspector and timeline content scroll within their own panels. The previous hosted browser prototype is not republished.

## Fixes found during implementation and review

- Retained regression protection for method-like quoted labels in source-edit targets.
- Fixed clipboard parameter aliases cascading into another original reference.
- Fixed long code expanding the workspace instead of scrolling inside the editor.
- Corrected clipboard handling for the pinned Electron runtime's asynchronous API.
- Preserved recovery data when the window closes before a recovery choice.
- Required an explicit desktop-test completion marker so a premature clean exit cannot falsely pass CI.
- Independent review identified one Important issue: native Open/New could change the save destination before a rejected recovery-cleanup operation left the old source visible. The regression was reproduced, then fixed by adopting the matching document and file identity before treating cleanup as a separate, non-fatal operation. Failed cleanup pauses autosave and reports its state. The regression also checks that ordinary Save cannot overwrite another project with stale source. Explicit Close/Discard is not blocked by a failed recovery cleanup.

No Critical issues were identified by the independent review. The one Important issue has a passing regression. This is a bounded review, not a guarantee that no bugs remain.

## Verification

- 32 Node tests cover the engine, source operations, history, project files, recovery, guide examples and preview geometry.
- 28 actual Electron integration checks cover gestures, selection, clipboard, guide, alignment, file lifecycle, cancelled/failed dialogs, cleanup failures, and recovery across window recreation.
- Windows CI independently runs desktop integration, packages both executables, opens the packaged native window and checks clean shutdown before uploading artifacts.
- Exact remote build results and downloadable artifacts are available in the pull request's GitHub Actions checks.

Native file-dialog choices are fixtures in automated tests; filesystem operations and Electron renderer interactions are real. The local host uses a headless Linux test launch. Windows CI uses the normal Windows runtime.

## Remaining fixes and improvements

- Windows builds are unsigned. Add code signing and a deliberate release/update process before broader distribution.
- Do hands-on Windows testing of native dialogs, mixed monitor scaling, IME input and assistive technology. Automated alignment checks currently exercise 100% and 125% zoom, not every display configuration.
- Continue testing source/timeline round trips with real editing sessions; the language remains intentionally small and line-based.
- The renderer/controller can be split further as the editor grows; keep new features behind the shared document operations.
- Real media import, audio, video export, keyframes remain later milestones, not missing pieces of the approved prototype scope.

## Future features recorded

Community plugin loading and connecting an external AI agent are recorded in ROADMAP.md. No loader, SDK, model provider, network listener or remote execution endpoint was added. Existing core/UI/native boundaries are intended to make those later designs manageable.

## Implementation decisions and workflow rulings

- Used a fresh checkout and a feature branch to isolate desktop changes from the previous Site-backed checkout. The hosted prototype is preserved; the repository's desktop branch removes obsolete hosting/server source.
- Executed the user's approved scope without another design-approval gate. Electron and CodeMirror were implementation choices to reuse the working visual direction and replace the fragile editor overlay; a different desktop stack would require another packaging/integration pass.
- Moved the renderer build check from the native-shell task to the workspace task because that task creates the renderer entry/HTML. The integrated build and runtime checks passed before the complete work was submitted.

## Editing-pass scope decisions

- Interpreted “first three” as the first three feature-table rows: Timeline, Layers, Preview. The user authorized implementation, so this pass did not add another approval round. If that interpretation differs, the scope will need correction.
- Continued on the existing dedicated desktop feature branch/PR, preserving main and the old hosted prototype. The PR contains the desktop conversion plus this pass.
- Retained the measured 60s/24-clip limits. No export pipeline or audio type exists yet, so renderer/export unification and audio mute await those milestones.
- No media import, export, plugin loader, SDK, agent connection or model provider was added. They remain explicit later milestones.

## Editing-pass review rulings

- Hidden layers remain intentionally editable through the timeline. Preview movement excludes hidden members to prevent invisible changes; the two paths have separate regression coverage.
- Direct code and shared template parameters can deliberately change locked layers; locks protect visual/destructive tools, as documented.
- Picking uses transformed selection bounds, not pixel-perfect decorative strokes. This retains the prototype’s existing bounding-box interaction.
- Media, audio, export, plugins, AI and increasing prototype limits remain deferred. Their absence limits the editor to procedural compositions.
- Native Windows scaling/IME/accessibility and signing still need platform/manual validation beyond CI.
