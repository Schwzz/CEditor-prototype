//! Stage 5 of the Tauri migration: the native window lifecycle that was
//! left to "later stages" through Stage 4 — window chrome state, native
//! menus, the unsaved-change prompt, and the close handshake — ported from
//! the retired Electron main process (desktop/main.cjs) with the same behavior:
//!
//! - The renderer owns its stage (Home vs editor) and code-panel state and
//!   reports both (`app_stage`, `app_code`); the title bar and native menus
//!   mirror both exactly like the Electron `applyTitle`/`installMenu` pair.
//! - The dirty flag and document name arrive from the renderer
//!   (`project_dirty`) and drive the same "● name — Framecode" title.
//! - `project_confirm_unsaved` shows the same Save / Don't Save / Cancel
//!   message box (Esc maps to Cancel, like the Electron `cancelId`) and
//!   answers `save` | `discard` | `cancel`.
//! - `window_finish_close` refuses while unsaved changes remain ("Newer
//!   unsaved changes remain.") and closes only when the renderer attests a
//!   clean document, exactly like the Electron `window:finish-close`.
//! - The close handshake intercepts a user close on a dirty document,
//!   prevents it, and sends the renderer the `close` command (the same
//!   `desktop:command` payload Electron sends); a 500 ms re-arm lets a
//!   later close attempt re-prompt when the renderer never answered. A
//!   clean or already-attested window closes without intervention.
//! - Menu commands that the renderer must handle (new, open, save, …,
//!   template:<name>) are emitted as `desktop:command` events; the native
//!   chrome commands Electron resolved itself (zoom roles, fullscreen,
//!   Exit) run here natively.
//!
//! One window ("main") is configured in `tauri.conf.json`, so the state
//! lives in one managed struct; the mutex serializes every read-modify-
//! write the same way the Electron window fields were confined to one
//! window object.

use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;

/// The window label configured in `tauri.conf.json`.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// The `desktop:command` event name the renderer's `onCommand` listens to,
/// the same channel Electron's preload bridged.
pub const COMMAND_EVENT: &str = "desktop:command";

/// The Electron `project:dirty` handler rejects names longer than 50000
/// UTF-16 code units (`name.length > 50000`).
const MAX_DOC_NAME_UNITS: usize = 50000;

/// The Electron `zoomIn`/`zoomOut` roles step the zoom factor by 1.2x.
const ZOOM_STEP: f64 = 1.2;

/// The Electron close-handshake re-arm delay: while the prompt is out, a
/// second close attempt is ignored, and this long after a prompt was sent
/// the window accepts another close click again.
const CLOSE_REARM_MS: u64 = 500;

/// The stage the renderer reports, mirrored from the Electron
/// `app:stage` handler's two allowed values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Home,
    Editor,
}

impl Stage {
    fn parse(value: &str) -> Option<Stage> {
        match value {
            "home" => Some(Stage::Home),
            "editor" => Some(Stage::Editor),
            _ => None,
        }
    }
}

/// All renderer-attested window state, the Electron window's `__*` fields.
#[derive(Debug)]
pub struct WindowState {
    dirty: bool,
    doc_name: String,
    stage: Stage,
    code_panel: bool,
    allow_close: bool,
    closing: bool,
    zoom: f64,
    templates: Vec<String>,
}

impl Default for WindowState {
    fn default() -> WindowState {
        WindowState {
            dirty: false,
            doc_name: String::new(),
            stage: Stage::Home,
            code_panel: false,
            allow_close: false,
            closing: false,
            zoom: 1.0,
            templates: Vec::new(),
        }
    }
}

/// The window title the Electron `applyTitle` helper produced for the
/// current state: "Framecode" on Home, and in the editor the dirty marker
/// plus the document name ("● name — Framecode").
fn title_text(state: &WindowState) -> String {
    if state.stage == Stage::Home {
        return "Framecode".to_string();
    }
    let name: String = state.doc_name.chars().take(100).collect();
    format!(
        "{}{}",
        if state.dirty { "\u{25cf} " } else { "" },
        if name.is_empty() {
            "Framecode".to_string()
        } else {
            format!("{name} \u{2014} Framecode")
        }
    )
}

/// The close handshake decision for the current state: a clean or already
/// attested window closes; a dirty window is blocked and the renderer is
/// prompted, unless a prompt is already out (the re-arm lets a later click
/// re-prompt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    Allow,
    /// Block the close and (re)send the `close` command to the renderer.
    Prompt,
    /// Block the close; a prompt is already out, do not re-send yet.
    Block,
}

fn close_decision(state: &WindowState) -> CloseDecision {
    if state.allow_close || !state.dirty {
        CloseDecision::Allow
    } else if state.closing {
        CloseDecision::Block
    } else {
        CloseDecision::Prompt
    }
}

/// The three answers the unsaved-change prompt can produce, the same
/// strings the Electron `project:confirm-unsaved` handler returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnsavedChoice {
    #[serde(rename = "save")]
    Save,
    #[serde(rename = "discard")]
    Discard,
    #[serde(rename = "cancel")]
    Cancel,
}

/// Maps the native message-dialog button onto the prompt answer. The
/// buttons are ordered Save / Don't Save / Cancel, and Esc (dialog
/// dismissal) counts as Cancel, exactly like the Electron dialog's
/// `cancelId: 2`.
pub fn unsaved_choice(result: tauri_plugin_dialog::MessageDialogResult) -> UnsavedChoice {
    use tauri_plugin_dialog::MessageDialogResult as R;
    match result {
        R::Ok | R::Yes => UnsavedChoice::Save,
        R::Custom(s) => match s.as_str() {
            "Save" => UnsavedChoice::Save,
            "Don't Save" => UnsavedChoice::Discard,
            _ => UnsavedChoice::Cancel,
        },
        _ => UnsavedChoice::Cancel,
    }
}

/// The zoom directions the View menu offers, the Electron roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zoom {
    Reset,
    In,
    Out,
}

/// Per-window lifecycle state plus the currently installed menu handle
/// (kept alive so its event wiring never drops).
pub struct WindowLifecycle {
    state: Mutex<WindowState>,
    menu: Mutex<Option<Menu<tauri::Wry>>>,
}

impl Default for WindowLifecycle {
    fn default() -> WindowLifecycle {
        WindowLifecycle {
            state: Mutex::new(WindowState::default()),
            menu: Mutex::new(None),
        }
    }
}

type LifecycleResult<T> = Result<T, String>;

impl WindowLifecycle {
    fn lock(&self) -> std::sync::MutexGuard<'_, WindowState> {
        // The guarded fields are plain values; a poisoned lock carries no
        // corrupt state, so recover the inner value and continue.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Updates the dirty flag and document name (the Electron
    /// `project:dirty` handler) and returns the window title to apply.
    pub fn set_dirty(&self, dirty: bool, name: String) -> LifecycleResult<String> {
        if name.encode_utf16().count() > MAX_DOC_NAME_UNITS {
            return Err("Invalid document state.".to_string());
        }
        let mut state = self.lock();
        state.dirty = dirty;
        state.doc_name = name;
        Ok(title_text(&state))
    }

    /// Updates the stage (the Electron `app:stage` handler) and returns
    /// the window title to apply.
    pub fn set_stage(&self, stage: &str) -> LifecycleResult<String> {
        let mut state = self.lock();
        state.stage = Stage::parse(stage).ok_or_else(|| "Invalid stage.".to_string())?;
        Ok(title_text(&state))
    }

    /// Updates the code-panel state (the Electron `app:code` handler).
    pub fn set_code_panel(&self, open: bool) {
        self.lock().code_panel = open;
    }

    /// Records the template names the renderer reports for the native
    /// Templates menu (the Electron menu imported them from the engine;
    /// in Tauri the engine stays JavaScript, so the renderer delivers the
    /// names over this command).
    pub fn set_templates(&self, templates: Vec<String>) {
        self.lock().templates = templates;
    }

    /// Steps the zoom like the Electron View roles and returns the new
    /// absolute factor for `WebviewWindow::set_zoom`.
    pub fn zoom(&self, direction: Zoom) -> f64 {
        let mut state = self.lock();
        state.zoom = match direction {
            Zoom::Reset => 1.0,
            Zoom::In => state.zoom * ZOOM_STEP,
            Zoom::Out => state.zoom / ZOOM_STEP,
        };
        state.zoom
    }

    /// The close handshake (see `close_decision`): returns whether the
    /// close may proceed, and otherwise whether the `close` command
    /// should be (re)sent now, arming the 500 ms re-arm.
    pub fn request_close(&self) -> CloseDecision {
        let mut state = self.lock();
        match close_decision(&state) {
            CloseDecision::Allow => CloseDecision::Allow,
            CloseDecision::Block => CloseDecision::Block,
            CloseDecision::Prompt => {
                state.closing = true;
                CloseDecision::Prompt
            }
        }
    }

    /// Clears the close re-arm after the prompt timed out, exactly like
    /// the Electron `setTimeout(() => { window.__closing = false; }, 500)`.
    pub fn disarm_close(&self) {
        self.lock().closing = false;
    }

    /// The renderer attests a clean document (`window:finish-close`): the
    /// close is allowed; unsaved changes fail with the Electron error.
    pub fn finish_close(&self) -> LifecycleResult<()> {
        let mut state = self.lock();
        if state.dirty {
            return Err("Newer unsaved changes remain.".to_string());
        }
        state.allow_close = true;
        Ok(())
    }
}

/// A renderer-command menu entry: label, command id, accelerator.
struct CommandItem<'a> {
    label: &'a str,
    id: &'a str,
    accelerator: Option<&'a str>,
}

/// Builds one renderer-command menu item.
fn command_item(
    app: &tauri::AppHandle,
    item: &CommandItem<'_>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let builder = MenuItemBuilder::with_id(item.id, item.label).enabled(true);
    let builder = match item.accelerator {
        Some(accelerator) => builder.accelerator(accelerator),
        None => builder,
    };
    builder.build(app)
}

/// Builds the stage-aware menu and installs it on the main window,
/// mirroring the Electron `installMenu` templates. Returns the built menu
/// so the caller keeps the handle alive.
fn build_menu(
    app: &tauri::AppHandle,
    stage: Stage,
    code_panel: bool,
    templates: &[String],
) -> tauri::Result<Menu<tauri::Wry>> {
    // File menu: stage-dependent commands, then Settings and Exit.
    let new = command_item(
        app,
        &CommandItem {
            label: "New project",
            id: "new",
            accelerator: Some("CmdOrCtrl+N"),
        },
    )?;
    let open = command_item(
        app,
        &CommandItem {
            label: "Open\u{2026}",
            id: "open",
            accelerator: Some("CmdOrCtrl+O"),
        },
    )?;
    let settings = command_item(
        app,
        &CommandItem {
            label: "Settings\u{2026}",
            id: "settings",
            accelerator: Some("CmdOrCtrl+,"),
        },
    )?;
    // The Exit entry closes the window through the close handshake (the
    // Electron Exit item was `click: () => window.close()`), so it is a
    // native menu event, not a renderer command.
    let exit = command_item(
        app,
        &CommandItem {
            label: "Exit",
            id: "exit",
            accelerator: None,
        },
    )?;
    let file = match stage {
        Stage::Home => SubmenuBuilder::new(app, "File")
            .item(&new)
            .item(&open)
            .separator()
            .item(&settings)
            .separator()
            .item(&exit)
            .build()?,
        Stage::Editor => {
            let save = command_item(
                app,
                &CommandItem {
                    label: "Save",
                    id: "save",
                    accelerator: Some("CmdOrCtrl+S"),
                },
            )?;
            let save_as = command_item(
                app,
                &CommandItem {
                    label: "Save As\u{2026}",
                    id: "saveAs",
                    accelerator: Some("CmdOrCtrl+Shift+S"),
                },
            )?;
            let import = command_item(
                app,
                &CommandItem {
                    // Temporary home for image import until the
                    // media/composition workflow lands; reachable from the
                    // File menu only.
                    label: "Import image\u{2026}",
                    id: "importImage",
                    accelerator: Some("CmdOrCtrl+I"),
                },
            )?;
            let source = command_item(
                app,
                &CommandItem {
                    label: "Composition source\u{2026}",
                    id: "source",
                    accelerator: None,
                },
            )?;
            SubmenuBuilder::new(app, "File")
                .item(&new)
                .item(&open)
                .separator()
                .item(&save)
                .item(&save_as)
                .item(&import)
                .separator()
                .item(&source)
                .separator()
                .item(&settings)
                .separator()
                .item(&exit)
                .build()?
        }
    };

    let mut menu = MenuBuilder::new(app).item(&file);
    if stage == Stage::Editor {
        let edit_items = [
            CommandItem {
                label: "Undo",
                id: "undo",
                accelerator: Some("CmdOrCtrl+Z"),
            },
            CommandItem {
                label: "Redo",
                id: "redo",
                accelerator: Some("CmdOrCtrl+Shift+Z"),
            },
            CommandItem {
                label: "Cut",
                id: "cut",
                accelerator: Some("CmdOrCtrl+X"),
            },
            CommandItem {
                label: "Copy",
                id: "copy",
                accelerator: Some("CmdOrCtrl+C"),
            },
            CommandItem {
                label: "Paste",
                id: "paste",
                accelerator: Some("CmdOrCtrl+V"),
            },
            CommandItem {
                label: "Duplicate clip",
                id: "duplicate",
                accelerator: Some("CmdOrCtrl+D"),
            },
        ];
        let edit_items: Vec<MenuItem<tauri::Wry>> = edit_items
            .iter()
            .map(|item| command_item(app, item))
            .collect::<tauri::Result<_>>()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .item(&edit_items[0])
            .item(&edit_items[1])
            .separator()
            .item(&edit_items[2])
            .item(&edit_items[3])
            .item(&edit_items[4])
            .item(&edit_items[5])
            .build()?;
        let code_panel_item = CheckMenuItem::with_id(
            app,
            "codePanel",
            "Code panel",
            true,
            code_panel,
            Some("CmdOrCtrl+E"),
        )?;
        let view = SubmenuBuilder::new(app, "View")
            .item(&code_panel_item)
            .separator()
            .text("zoomReset", "Reset Zoom")
            .text("zoomIn", "Zoom In")
            .text("zoomOut", "Zoom Out")
            .separator()
            .text("fullscreen", "Toggle Full Screen")
            .build()?;
        // The engine stays JavaScript, so the renderer delivers the
        // template names (the Electron menu imported them itself).
        let template_items: Vec<MenuItem<tauri::Wry>> = templates
            .iter()
            .map(|name| {
                MenuItem::with_id(app, format!("template:{name}"), name, true, None::<&str>)
            })
            .collect::<tauri::Result<_>>()?;
        let mut templates_builder = SubmenuBuilder::new(app, "Templates");
        for item in &template_items {
            templates_builder = templates_builder.item(item);
        }
        let templates_menu = templates_builder
            .separator()
            .text("templates", "Browse templates\u{2026}")
            .build()?;
        let help = SubmenuBuilder::new(app, "Help")
            .item(&MenuItem::with_id(
                app,
                "guide",
                "Code guide",
                true,
                Some("F1"),
            )?)
            .build()?;
        menu = menu
            .item(&edit)
            .item(&view)
            .item(&templates_menu)
            .item(&help);
    }
    menu.build()
}

/// Rebuilds and installs the stage-aware native menu from the current
/// window state, the Electron `installMenu(window, stage)` pair.
pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    let (stage, code_panel, templates) = {
        let state = lifecycle.lock();
        (state.stage, state.code_panel, state.templates.clone())
    };
    let menu = build_menu(app, stage, code_panel, &templates)?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.set_menu(menu.clone())?;
    }
    *lifecycle
        .menu
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(menu);
    Ok(())
}

/// Handles one native menu event: chrome commands run here, everything
/// else is forwarded to the renderer's command handler as the same
/// `desktop:command` payload Electron's menus sent.
pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    match id {
        "exit" => {
            // A user close: the close handshake in on_window_event decides.
            let _ = window.close();
        }
        "zoomReset" | "zoomIn" | "zoomOut" => {
            let direction = match id {
                "zoomIn" => Zoom::In,
                "zoomOut" => Zoom::Out,
                _ => Zoom::Reset,
            };
            let zoom = app.state::<WindowLifecycle>().zoom(direction);
            let _ = window.set_zoom(zoom);
        }
        "fullscreen" => {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!fullscreen);
        }
        _ => {
            // A renderer command: deliver the same payload Electron sent.
            let _ = app.emit_to(MAIN_WINDOW_LABEL, COMMAND_EVENT, id.to_string());
        }
    }
}

/// Installs the close handshake on the main window (the Electron
/// `window.on("close")` handler): a clean or attested close proceeds; a
/// dirty close is prevented and the renderer receives the `close`
/// command, with a 500 ms re-arm so a later click can re-prompt.
pub fn install_close_handshake(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            match app_handle.state::<WindowLifecycle>().request_close() {
                CloseDecision::Allow => {}
                CloseDecision::Prompt => {
                    api.prevent_close();
                    let app = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(CLOSE_REARM_MS));
                        app.state::<WindowLifecycle>().disarm_close();
                    });
                    let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, COMMAND_EVENT, "close");
                }
                CloseDecision::Block => {
                    api.prevent_close();
                }
            }
        }
    });
}

/// The commands the Tauri shell exposes for the window lifecycle, mirroring
/// the surface of the retired Electron preload (desktop/preload.cjs).
#[tauri::command]
pub fn project_dirty(app: tauri::AppHandle, dirty: bool, name: String) -> LifecycleResult<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    let title = lifecycle.set_dirty(dirty, name)?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_title(&title);
    }
    Ok(())
}

#[tauri::command]
pub fn app_stage(app: tauri::AppHandle, stage: String) -> LifecycleResult<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    let title = lifecycle.set_stage(&stage)?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_title(&title);
        install_menu(&app).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_code(app: tauri::AppHandle, open: bool) -> LifecycleResult<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    lifecycle.set_code_panel(open);
    // Only the editor stage's menu carries the checkbox.
    if lifecycle.lock().stage != Stage::Editor {
        return Ok(());
    }
    install_menu(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_templates(app: tauri::AppHandle, names: Vec<String>) -> LifecycleResult<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    lifecycle.set_templates(names);
    // Only the editor stage's menu carries the Templates section.
    if lifecycle.lock().stage != Stage::Editor {
        return Ok(());
    }
    install_menu(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_confirm_unsaved(app: tauri::AppHandle) -> LifecycleResult<UnsavedChoice> {
    // Blocking dialog on the command thread, never the main thread.
    Ok(confirm_unsaved(&app))
}

/// The unsaved-change message box (the Electron `project:confirm-unsaved`
/// handler): blocking on the command thread, never the main thread.
pub fn confirm_unsaved(app: &tauri::AppHandle) -> UnsavedChoice {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let result = app
        .dialog()
        .message("Save your changes before continuing?")
        .title("Unsaved changes")
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Save".to_string(),
            "Don't Save".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show_with_result();
    unsaved_choice(result)
}

#[tauri::command]
pub fn window_finish_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> LifecycleResult<()> {
    let lifecycle = app.state::<WindowLifecycle>();
    lifecycle.finish_close()?;
    let _ = window.close();
    Ok(())
}
