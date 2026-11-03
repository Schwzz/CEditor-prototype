# Phase 2 — Main Menu & Product Foundation: Audit & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Framecode's main menu a fully functional product surface — state-aware enable/disable, an Open Recent list persisted by the main process, and launch-with-file support — without touching the editor's Phase 1 behavior.

**Architecture:** The Electron menu already forwards commands to the sandboxed renderer over the existing `desktop:command` bridge; Phase 2 extends this in place: a new pure persistence module beside `project-files.mjs`, three new IPC channels using the existing per-window registry, menu rebuilds driven by state main already tracks (`window.__dirty`, `window.__currentPath`), and one new renderer command branch reusing `fileCommand`. No architural change.

**Tech Stack:** Electron 45 (Menu/ipcMain/preload contextBridge), Node 22 `node --test`, esbuild renderer bundle, existing desktop-smoke Electron harness.

**Spec:** This document. Audit findings are sections 1–4; the task plan is sections 5–7. Context specs in-repo: `docs/superpowers/specs/2026-10-27-windows-prototype-design.md` (approved Phase 1 scope), `docs/ROADMAP.md` (no Phase 2 menu scope exists yet — scope here is derived from the Phase 2 task brief only).

## Global Constraints

- Preserve all accepted Phase 1 behavior: recovery/autosave flow, unsaved-changes guard, consent-gated image relink, asset capability tokens, atomic project writes.
- Main process owns all disk access. The renderer never reads the filesystem; new surfaces follow the `handle(channel, fn)` registry pattern with its framecode-origin check.
- The renderer remains untouched except for the new command branch and one boot-completion IPC (Task 5); the editor layout and CodeMirror flow are not redesigned.
- `Menu.setApplicationMenu` is app-wide; menu state must always target the focused window because `command(name)` sends via `window.webContents`.
- No protocol, security-model, or packaging (`electron-builder.yml`) changes; new `desktop/*.mjs` files are already covered by the `desktop/**` file glob.
- Keep Windows x64 as the shipped platform; macOS-only conveniences stay out of scope.

## Review Focus

The failure modes most likely to bite a real user, each pinned by a test in its owning task:

1. **Opening a recent project while the current draft is dirty** must offer Save/Discard/Cancel exactly like Ctrl+O (pinned by desktop-smoke check in Task 4).
2. **A recent entry pointing at a deleted file** must be pruned with a clear error, never crash the menu or leave the app in a half-opened state (pinned by unit tests in Task 2 + smoke check in Task 4).
3. **Save/Open menu items enabled at the wrong time** (e.g., Save always clickable) would silently diverge from the toolbar's disable logic (pinned by enable-state assertions in Task 3's test plan).
4. **Menu rebuilt for the wrong window** in the multi-window smoke recreation (`tests/desktop-smoke.cjs:437`, `:870`) — commands must land in the focused window, not the defunct one (Task 3).
5. **Launch-with-file racing the recovery dialog** — passing a path at startup must not bypass or corrupt the recovery prompt flow (Task 5, ordering pinned by test).

## 1. Current state summary (audit)

**Startup flow.** `desktop/main.cjs` is the Electron entry (`package.json: main`). `start()` registers the `framecode://` privileged scheme, takes a single-instance lock, awaits `app.whenReady()`, calls `installProtocol()`, then `createDesktopWindow()` and `installMenu(window)`. `createDesktopWindow()` creates a sandboxed BrowserWindow (contextIsolation, no node integration, permission handlers deny-all, navigation restricted to `framecode://app/index.html`), wires 16 IPC channels through a per-window channel registry (`channelRegistry` → `ensureChannel` validates sender frame origin), injects a capability asset token, loads the entry URL, and returns the window plus a `RecoveryFile` bound to `app.getPath("userData")`.

**Renderer boot.** `src/renderer/app.mjs` (`boot()`, lines 944–994) reads the recovery file, shows a blocking recovery dialog when a draft exists (restore → consent-gated relink of images), then sets `booting = false`, renders, and starts autosave scheduling. Before `booting` clears, all commands and commits are ignored — the app effectively boots into the editor with the default example composition.

**Project workflows.** All file operations are renderer-initiated through `window.framecodeDesktop` (`desktop/preload.cjs`, frozen contextBridge API): `openProject()` (`project:open` → native dialog → `readProject`, asset rescan, `window.__currentPath` update), `saveProject(project, saveAs)` (`project:save` → `encodeProject` validation → dialog for new/Save-As → `writeProject` atomic), `newProject()` (resets path + authorized assets), `confirmUnsaved()` (native Save/Discard/Cancel), `setDirty()` (title, `window.__dirty`, `setDocumentEdited`). The renderer wraps everything in `runFile` (busy guard, `fileBusy`) and `guardUnsaved`, and adopts the document only after the native path succeeds (`fileCommand`, app.mjs:693–732). Closing with dirty state loops through renderer (`window.on("close")` → `desktop:command "close"` → `finishClose`).

**Recent-project handling.** None exists. No recents list, no `project:open-at` path channel, no `process.argv`/`open-file` handling at startup.

**Main ↔ renderer interaction.** One command channel: `installMenu()` items send the strings `"new" | "open" | "save" | "saveAs" | "undo" | "redo" | "cut" | "copy" | "paste" | "duplicate" | "guide" | "close"` via `window.webContents.send("desktop:command", name)`; the renderer's `command(name)` (app.mjs:817–885) dispatches them, and `desktop.onCommand` subscribes. Menu items are never disabled — they stay clickable at all times — while toolbar buttons are accurately disabled via `render()`.

## 2. Relevant files and components

| File | Role in Phase 2 |
|---|---|
| `desktop/main.cjs` | `start()`, `createDesktopWindow()` (IPC handlers, dirty/path state), `installMenu()` — all menu/Persistence wiring lands here |
| `desktop/preload.cjs` | Frozen bridge; add `openProjectAt(path)` |
| `desktop/project-files.mjs` | Donor patterns: `RecoveryFile` queueing, `atomicWrite`, `decodeProject` validation |
| `src/renderer/app.mjs` | `command()` dispatcher, `fileCommand()`, `boot()` — one new command branch, one boot-completion signal |
| `src/renderer/index.html` | No change required (toolbar remains the visual file-actions surface) |
| `tests/desktop-smoke.cjs` | Electron integration harness; imports `createDesktopWindow/installMenu`; ~35 checks incl. multi-window recreation |
| `tests/project-files.test.mjs` | Pattern for pure `node --test` file-store tests |
| `scripts/build.mjs`, `scripts/test-desktop.mjs` | Build bundles `src/renderer/app.mjs` → `build/renderer/app.js`; desktop tests rebuild first — renderer changes must build |
| `electron-builder.yml` | Confirmed: `desktop/**` glob already packages any new desktop module; no file-association registration exists (out of scope) |
| `VALIDATION.md`, `README.md` | Acceptance documentation to update in the final task |

## 3. Design decisions (locked)

- **Recents live in the main process** (`userData/recents.json`), owned by a new pure module; the renderer only ever sends command strings and never receives raw paths it doesn't echo back into an `openProjectAt` call.
- **Menu stays native** (Electron application menu). Building a parallel in-window menu system would duplicate accelerators that already work (Ctrl+N/O/S/Z…, all handled twice today: natively and in the renderer keydown) and violate "keep the existing architecture." The in-window toolbar remains as-is.
- **`Open Recent` opens through the same guard chain as `Open`**: menu → command string `open-recent:<path>` → renderer `fileCommand("openRecent", path)` (which runs `guardUnsaved` and the adopt/cleanup sequence) → `desktop.openProjectAt(path)` → main does dialog-less `readProject` + asset rescan + `window.__currentPath` + records the recency. Phase 1 flow untouched.
- **Menu enable/disable is computed in main** from state it already maintains (`project:dirty` handler sets `window.__dirty`/title). Items get `id`s; `updateMenuState()` disables Save/Save-As (no dirty, no path), Open Recent (empty list), Undo/Redo menu items stay always-enabled (renderer no-ops them safely today; changing that requires renderer state sync that isn't worth Phase 2 risk).
- **Command-string encoding**: `open-recent:` + raw absolute path (paths never contain parseable structure; the prefix is split on first occurrence). No JSON in command strings.

## 4. Gaps this phase closes (scope fence)

| Gap | In scope | Out of scope (Phase 3+) |
|---|---|---|
| Menu items always enabled | Yes (Task 3) | Per-snapshot Command palette |
| Open Recent | Yes (Tasks 1–4) | Cloud/template hub, project database |
| Launch with file (argv) | Yes, minimal (Task 5) | `.framecode.json` shell association/Jump List, macOS `open-file`, drag-and-drop onto exe |
| Recents pruning | Missing-file prune (Task 2) | Recents management UI, pinning |

## 5. Task plan

### Task 1: Recent-projects store module

**Files:**
- Create: `desktop/recent-projects.mjs`
- Test: `tests/recent-projects.test.mjs`

**Interfaces:**
- Produces: `class RecentProjectsFile { constructor(directory) ; async list() → Array<{path, name, openedAt}> ; async add(path) → entries ; async remove(path) → entries ; async pruneMissing() → entries }` mirroring `RecoveryFile`'s shape (`this.path = join(directory, "recents.json")`, queued writes via `#enqueue`).
- Format: `{ format: "framecode-recents", version: 1, projects: [...] }`, atomic via `import { atomicWrite } from "./project-files.mjs"`. Max 10 entries, most-recent first, deduplicated case-insensitively on `win32` (normalize with the same lower-on-win32 rule as `normalizeAssetPath` in `main.cjs:62`).

- [ ] **Step 1: Write failing unit tests** in `tests/recent-projects.test.mjs` (`node --test`): fresh directory → `list()` returns `[]`; `add()` twice (same file different case on win32) → single entry moved to front, `name` is basename, stale entries evicted beyond 10; `add/remove/add` ordering; `pruneMissing()` drops entries whose `path` fails `fs.stat` and persists the result; corrupt/unknown-format file → treated as empty, not a crash.
- [ ] **Step 2:** `node --test tests/recent-projects.test.mjs` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the module; no Electron imports.
- [ ] **Step 4:** Same command — expect PASS; run full `npm test` to confirm no regressions.
- [ ] **Step 5: Commit** `feat: add recent-projects store for the main menu` (both files).

### Task 2: IPC channels for open-at and recents

**Files:**
- Modify: `desktop/main.cjs` (createDesktopWindow: new handlers alongside `project:open` at :237), `desktop/preload.cjs`
- Test: extend `tests/desktop-smoke.cjs` (plain-invocation checks, following the existing injected-dialog fixture pattern)

**Interfaces:**
- Consumes: Task 1's `RecentProjectsFile`; existing `exclusive()`, `readProject`, `scanForAssets`, `handle()`.
- Produces:
  - `handle("project:open-at", path)` — validates non-empty string; `exclusive()`-wrapped: `readProject(path)`; on success sets `window.__currentPath`, clears `__authorizedAssets`, scans project source + lastValid, `recentProjects.add(path)` → returns `{ name, path, project }` (same shape as `project:open`). On `ENOENT`/read failure: `recentProjects.remove(path)` and rethrow the original error (renderer shows the toast; menu prunes on next rebuild).
  - `handle("recents:list")` → `recentProjects.list()` (renderer-agnostic; used by `updateRecentMenu`).
  - preload: `openProjectAt: (path) => invoke("project:open-at", path)` added to the frozen bridge object.
- Recording hooks: the success paths of existing `project:open` and `project:save` handlers also call `recentProjects.add(...)` (one-line additions).

- [ ] **Step 1:** Add the two handlers + recording lines in `project:open`/`project:save`; construct `new RecentProjectsFile(dataDirectory)` next to `new RecoveryFile(dataDirectory)` (`main.cjs:178`) so the smoke harness's injected `dataDirectory` keeps tests hermetic.
- [ ] **Step 2:** Add `openProjectAt` to `desktop/preload.cjs` (one line, frozen object untouched otherwise).
- [ ] **Step 3:** Extend `tests/desktop-smoke.cjs`: (a) `openProjectAt` on a fixture project returns the `{name, path, project}` shape and sets `metadata().path`; (b) opening a missing path throws a toastable error and removes the entry (verified via `recents:list`); (c) a successful real open/save records into the store.
- [ ] **Step 4:** `npm run check` (syntax), `npm test`, `npm run test:desktop` — all PASS (existing 35 checks unaffected).
- [ ] **Step 5: Commit** `feat: open-at and recents IPC channels`.

### Task 3: State-aware menu with Open Recent submenu

**Files:**
- Modify: `desktop/main.cjs` (`installMenu`, `createDesktopWindow` dirty handler :308)

**Interfaces:**
- Consumes: Task 2's `recents:list`; existing `command(name)` forwarding; `window.__dirty`, `window.__currentPath`.
- Produces: `installMenu(window)` gains a second parameter if the smoke harness needs to inject recents for assertions; exposes internal `updateRecentMenu(window)` and `updateMenuState(window)` (not exported; kept testable via the harness's window handle). Items get `id:` values: `menu-new`, `menu-open`, `menu-save`, `menu-save-as`, `menu-open-recent`.

- [ ] **Step 1:** Rebuild the File menu template with ids and a dynamic `Open Recent` submenu built from `recents:list()` (label = basename, tooltip-less; separators + `Clear recent projects` item calling `recents clear`… implemented as `RecentProjectsFile.clear()` if not present from Task 1 — add it there instead if missing, with a test). Empty list → single disabled placeholder item "No recent projects".
- [ ] **Step 2:** In the `project:dirty` handler and after every successful `project:open`/`project:open-at`/`project:save`, call `updateMenuState(window)`: `menu-save`/`menu-save-as` enabled = `__dirty || __currentPath`; `menu-open-recent` enabled = list non-empty. After any recents mutation, call `updateRecentMenu(window)`.
- [ ] **Step 3:** Because `setApplicationMenu` is app-wide but `command()` targets one window: re-install/rebind on `app.on("browser-window-focus", …)` so the focused window's menu is authoritative (the multi-window smoke recreation at `desktop-smoke.cjs:437/:870` is the regression to watch).
- [ ] **Step 4:** Smoke checks: Save menu item enabled ⟺ `window.__dirty || window.__currentPath` after a real edit; Open Recent submenu lists a saved fixture project; clicking its item (via the harness invoking the renderer command path, Task 4 dependency) loads it with the unsaved-guard applied.
- [ ] **Step 5:** `npm run test:desktop` PASS; **Commit** `feat: state-aware application menu with Open Recent`.

### Task 4: Renderer command branch for recent opens

**Files:**
- Modify: `src/renderer/app.mjs` (`command()` :817, `fileCommand()` :693)

**Interfaces:**
- Consumes: preload `openProjectAt`; the command channel strings from Task 3.
- Produces: `command(name)` recognizes `open-recent:<path>` before the exact-name checks and routes to `fileCommand("openRecent", path)`; `fileCommand` treats `openRecent` identically to `open` except `desktop.openProjectAt(path)` replaces the dialog call. Unsaved-guard, adoption, recovery-cleanup ordering inherited for free — this is the phase's key regression-safety property.

- [ ] **Step 1:** Implement the prefix parse (split on first `:`; empty path → toast "That project could not be opened" and bail).
- [ ] **Step 2:** Smoke check: dirty window + recent-menu open → native Save/Discard/Cancel dialog appears (fixture), Cancel aborts cleanly, Save-then-open completes; missing recent file → error toast, editor unchanged.
- [ ] **Step 3:** `npm run test:desktop` PASS; **Commit** `feat: open recent projects through the unsaved-changes guard`.

### Task 5: Launch-with-file foundation

**Files:**
- Modify: `desktop/main.cjs` (`start()` :516, `createDesktopWindow` returns pending-open plumbing), `src/renderer/app.mjs` (`boot()` :944), `desktop/preload.cjs`
- Test: extend `tests/desktop-smoke.cjs`

**Interfaces:**
- Produces: preload `finishBoot: () => invoke("boot:done")`; `handle("boot:done")` resolves a promise main awaited since window creation. `createDesktopWindow({ pendingOpenPath })` stores it; after `boot:done`, main sends `"open-recent:" + pendingOpenPath` (reusing Task 4's branch; the recovery dialog, if any, has already been resolved by then because `booting` gates commands).
- `start()` computes the path: first `process.argv`/`process.argv[2]` entry ending in `.framecode.json` that `fs.stat`s as a file (dev vs. packaged argv offsets differ Electron-45+Windows; resolve defensively), else `null`.

- [ ] **Step 1:** Implement argv parsing + `boot:done` + deferred command send; invalid/missing argv path is silently ignored (matching Windows "file missing at launch" behavior: app starts clean, no error dialog).
- [ ] **Step 2:** Smoke checks: launch with fixture path → project loaded after boot; launch with a nonexistent `.framecode.json` → clean editor boot; recovery-present + argv path → recovery dialog resolves before the path opens (ordering assertion).
- [ ] **Step 3:** `npm run test:desktop` PASS; **Commit** `feat: open a project passed on the command line at startup`.

### Task 6: Documentation and CI gates

**Files:**
- Modify: `VALIDATION.md` (local-verification bullet list + desktop-integration coverage sentence), `README.md` (menu/recent features), `docs/ROADMAP.md` (mark the main-menu foundation item as implemented in this milestone)

- [ ] **Step 1:** Update the three docs — one short paragraph each; no new claims beyond what Tasks 1–5 shipped.
- [ ] **Step 2:** Run the full gate: `npm run check && npm test && npm run build && npm run test:desktop` locally.
- [ ] **Step 3: Commit** `docs: document main menu and recent projects for phase 2`.

## 6. Risks, dependencies, and regression concerns

| Risk | Mitigation in plan |
|---|---|
| `Menu.setApplicationMenu` is app-global while commands are per-window → commands land in a destroyed/wrong window during the multi-window smoke recreation | Task 3 rebinds on `browser-window-focus`; the harness's existing recreation checks are the tripwire |
| Menu accelerators colliding with the renderer's own keydown handling (both call `command()` — currently benign double-fire for Ctrl+S/Z/N/O) | Task 3 adds no new accelerators; existing-by-design duplication documented, not "fixed" |
| Recents mutation from a background save happening while the menu submenu is open | Menu writes go through the queued store (RecoveryFile pattern); submenu rebuild happens between user interactions, not mid-keystroke |
| `openProjectAt` bypassing asset re-authorization would break image rendering after a recents open | Task 2 reuses `__authorizedAssets.clear()` + `scanForAssets(source)` + `scanForAssets(lastValid)` — literally the `project:open` body |
| Recovery-ordering regressions (Phase 1's most carefully tested invariant) | Task 4 routes through the untouched `fileCommand` chain; Task 5 pins the recovery-before-open ordering with a dedicated smoke assertion |
| `userData` pollution from smoke runs leaking between tests | Recents store constructed from the harness-injected `dataDirectory`, like `RecoveryFile` today |
| Packaged vs. dev `argv` offset differences on Windows | Task 5 filters defensively (any argv element ending `.framecode.json` that stats as a file) instead of trusting index 1 or 2 |

Dependencies: Task 2 needs Task 1; Task 3 needs Task 2; Task 4 needs Tasks 2–3 (menu strings); Task 5 needs Task 4; Task 6 last. Tasks 1→2→3→4 are separately reviewable and each leaves the app fully working (Task 1 is additive-only; Task 2 wires unused channels; Task 3 ships the visible menu improvement; Task 4 activates recent opens; Task 5 is an independent startup feature stacking on 4).

## 7. Recommended order

Implement strictly as Tasks 1–6 above (each = one PR-sized commit or small stacked PR):

1. **Task 1** — pure store, zero risk, unblocks everything.
2. **Task 2** — channels + recording (menu still unchanged).
3. **Task 3** — visible menu work; review with focus on window rebinding.
4. **Task 4** — activate the flow end-to-end.
5. **Task 5** — startup/open-with-file, isolated behind boot gating.
6. **Task 6** — docs + full local gate before tagging the milestone as done.

Each task's verification is `npm run check`, `npm test`, and (from Task 2 on) `npm run test:desktop`; the Windows CI gates in `VALIDATION.md` remain the final authority.
