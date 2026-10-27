# Windows desktop prototype — approved scope

The user approved a Windows application, editor alignment fixes, a deeper code guide, preview selection/movement, timeline edge resizing and exact timing, right-click editing tools, shared Undo/Redo, and local project saving/recovery. Implement that scope now; AI-agent connectivity and community plugin loading remain future work.

## Architecture and decisions

- Package the existing visual direction in an Electron desktop window, with no local HTTP server, separate terminal, account, or browser tab required by the packaged app. Electron is the implementer's choice for reusing the existing renderer and distributing a consistent Windows runtime.
- Replace the custom textarea/highlight/gutter overlay with CodeMirror. This gives the caret, text, syntax colors and line numbers a single editor layout.
- Keep the restricted composition parser; never evaluate user code as JavaScript. Add explicit 1920×1080 logical-pixel positions and source-time offsets for continuous splitting.
- Route code, parameters, spatial edits, timing and clipboard operations through one document history. A completed pointer gesture is one history entry. Invalid source keeps its last valid model; secondary editing tools are disabled until repaired.
- Select by stable clip name across code, preview and timeline. Preview drags pause playback. Timeline has left/right resize handles and numeric start/end/duration fields. The context menu selects its target before offering split, cut, copy, paste, duplicate, delete and timing.
- Splitting must preserve the current visual phase. Clipboard data uses a versioned restricted format and safely imports referenced parameters; it never executes code.
- Native file dialogs open/save versioned `.framecode.json` projects. Save As, dirty-state prompts, bounded recovery records and atomic writes protect drafts. Restore recovery as an unsaved copy so it cannot silently overwrite a project.
- Electron's main process owns disk access and clipboard access. The sandboxed renderer uses a narrow validated preload bridge. Disallow remote navigation, arbitrary filesystem IPC, and external content.
- Ship a Windows x64 portable executable and installer through GitHub Actions. Keep tests, build and packaging reproducible with a lockfile. Signing is outside the prototype; report that honestly.
- Keep core, renderer and desktop integration separate for later extension APIs. No plugin loader, AI connection, network server, media import, audio or video export in this pass.

## Alternatives considered

The approved direction is a Windows application immediately. Continuing browser-only development does not match that choice. Electron reuses the current UI and provides a bundled renderer; a separate native UI rewrite would cost substantial work without helping test the approved interaction model. The choice of Electron and CodeMirror is the implementer's call, not an additional user requirement.

## Acceptance

An installed or portable Windows build opens its own window. Source edits, controls, preview transforms and timeline edits stay synchronized and are undoable. Long source files keep caret and gutter alignment while scrolling. Native Open/Save/Save As, cancelled dialogs, invalid drafts, autosave recovery and unsaved closing are handled without discarding work. CI runs core, desktop integration and packaging checks. Report remaining limitations and improvements after a separate review.
