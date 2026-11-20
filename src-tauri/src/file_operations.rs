//! Stage 3 of the Tauri migration: file operations (Open, Open Recent,
//! New, Save, Save As), ported from the Electron main-process handlers in
//! `desktop/main.cjs` with identical validation, error messages, recents
//! recording, and exclusivity semantics:
//!
//! - The session owns one "current document path" (the Electron window's
//!   `__currentPath`): Save writes to it without a dialog, Save As always
//!   asks, and New clears it.
//! - Exactly one file operation runs at a time (the Electron `exclusive`
//!   helper); a second concurrent operation fails with the same message.
//! - Recents entries are recorded only after a project has actually been
//!   opened or written, and a recents write failure never fails the open
//!   or save itself.
//! - Save validates the draft before any dialog appears, and appends
//!   ".framecode.json" to dialog destinations that do not end in ".json".
//!
//! Dialogs behind the `Dialogs` trait mirror the Electron handlers'
//! injectable `dialogs = dialog` parameter, so the core operations are
//! unit-testable with fixture dialogs; `TauriDialogs` is the real
//! implementation over the tauri-plugin-dialog plugin. Stage 4 adds the
//! Import image picker and the relink consent dialog to the same trait.
//!
//! Deferred to later stages, as in the Electron handlers they wrap:
//! unsaved-change prompts, window titles, and native menus. Asset
//! authorization scanning is invoked from `lib.rs` (Stage 4).

use crate::project_files::{PersistenceError, Result};
use crate::recents::{js_is_absolute, RecentProjects};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

/// Display name of a document that has never been saved to a path, the
/// same string the Electron `project:new` handler returns.
pub const UNTITLED_NAME: &str = "Untitled.framecode.json";

/// The Electron open-recent guard rejects paths longer than 4096 UTF-16
/// code units (`recentPath.length > 4096`).
const MAX_RECENT_PATH_UNITS: usize = 4096;

/// A project loaded through a dialog or the recents list, in the same
/// shape the Electron `project:open` handler returns.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LoadedProject {
    pub name: String,
    pub path: String,
    pub project: Value,
}

/// The saved document, as the Electron `project:save` handler returns.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SavedProject {
    pub name: String,
    pub path: String,
}

/// The Electron `project:new` response.
#[derive(Serialize, Debug, Clone)]
pub struct NewProject {
    pub name: String,
}

/// The native dialogs the file operations need. Fixtures in tests stand in
/// for the real pickers exactly like the Electron integration tests inject
/// `dialogs = dialog`.
pub trait Dialogs {
    /// The Open dialog's chosen path, or `None` when the user cancels.
    fn pick_open(&self) -> Option<String>;
    /// The Save As dialog's chosen path, or `None` on cancel. `current`
    /// is the session's current path, mirroring the Electron handler's
    /// `defaultPath: window.__currentPath || "Untitled.framecode.json"`.
    fn pick_save(&self, current: Option<&str>) -> Option<String>;
    /// The Import image dialog's chosen path, or `None` on cancel. The
    /// filter matches the Electron `image:import` handler's exactly.
    fn pick_image(&self) -> Option<String>;
    /// The Stage 6 media picker: `kind` is "video" or "audio" and selects
    /// the extension filter. Fixtures default to cancel.
    fn pick_media(&self, _kind: &str) -> Option<String> {
        None
    }
    /// The relink consent dialog: `true` only when the user affirms
    /// granting the listed image paths to this window (the Electron
    /// "Relink images" button; canceling or "Skip" is a refusal).
    fn confirm_relink(&self, candidates: &[String]) -> bool;
}

/// The real dialogs, over the tauri-plugin-dialog plugin. Blocking dialogs
/// run on the command thread, never the main thread.
pub struct TauriDialogs {
    app: tauri::AppHandle,
}

impl TauriDialogs {
    pub fn new(app: tauri::AppHandle) -> TauriDialogs {
        TauriDialogs { app }
    }
}

impl Dialogs for TauriDialogs {
    fn pick_open(&self) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Open Framecode project")
            .add_filter("Framecode project", &["json"])
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn pick_save(&self, current: Option<&str>) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self
            .app
            .dialog()
            .file()
            .set_title("Save Framecode project")
            .add_filter("Framecode project", &["json"]);
        // The plugin has no full-path default, so the Electron
        // `defaultPath: window.__currentPath || "Untitled…"` splits into the
        // destination directory plus the file name the user starts with.
        match current {
            Some(path) => {
                let path = Path::new(path);
                builder = builder.set_directory(path.parent().unwrap_or(path));
                builder = builder.set_file_name(file_name_of(path));
            }
            None => builder = builder.set_file_name(UNTITLED_NAME),
        }
        builder
            .blocking_save_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn pick_image(&self) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Import image")
            .add_filter("Images", &["jpg", "jpeg", "png", "webp", "gif"])
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn pick_media(&self, kind: &str) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        let (title, filter_name, extensions): (&str, &str, &[&str]) = match kind {
            "video" => (
                "Import video",
                "Videos",
                &["mp4", "mov", "m4v", "webm"],
            ),
            "audio" => (
                "Import audio",
                "Audio",
                &["mp3", "wav", "m4a", "aac", "flac", "ogg"],
            ),
            _ => return None,
        };
        self.app
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter_name, extensions)
            .blocking_pick_file()
            .and_then(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn confirm_relink(&self, candidates: &[String]) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        // The Electron dialog's `detail` lists the exact paths the window
        // would gain access to; the message dialog folds it into the body.
        let message = format!(
            "Relink the media used by the recovered draft? Granting access \
             lets this draft display it.\n\nFiles that will be accessible \
             to this window:\n{}",
            candidates.join("\n")
        );
        self.app
            .dialog()
            .message(message)
            .title("Relink recovered media")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Relink media".into(),
                "Skip".into(),
            ))
            .blocking_show()
    }
}

/// Mirrors `path.basename` for the names recents entries and the renderer
/// display: the final path component, or "" when there is none.
pub fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The one open document path, mirroring the Electron window's
/// `__currentPath`, plus the exclusive-operation flag.
pub struct FileOperations {
    /// Exactly one file operation at a time, like the Electron `exclusive`
    /// helper: "A file operation is already in progress." otherwise.
    busy: Mutex<bool>,
    /// The document path this session has open.
    current: Mutex<Option<String>>,
}

impl Default for FileOperations {
    fn default() -> Self {
        Self::new()
    }
}

impl FileOperations {
    pub fn new() -> FileOperations {
        FileOperations {
            busy: Mutex::new(false),
            current: Mutex::new(None),
        }
    }

    /// Runs `operation` as the only file operation. The busy flag is
    /// cleared on every exit path, including a panicking operation. The
    /// error type is the operation's own, so callers keep their result
    /// shapes; the exclusivity error is built through `From<String>`.
    pub fn run_exclusive<T, E: From<String>>(
        &self,
        operation: impl FnOnce() -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E> {
        struct BusyGuard<'a>(&'a Mutex<bool>);
        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                if let Ok(mut busy) = self.0.lock() {
                    *busy = false;
                }
            }
        }
        {
            // The busy flag is a plain bool; a poisoned lock carries no
            // corrupt state, so recover the inner value and continue.
            let mut busy = self
                .busy
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *busy {
                return Err("A file operation is already in progress."
                    .to_string()
                    .into());
            }
            *busy = true;
        }
        let _guard = BusyGuard(&self.busy);
        operation()
    }

    fn current(&self) -> Option<String> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_current(&self, path: Option<String>) {
        *self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
    }
}

/// Reads a project file for Open Recent with the Electron handler's error
/// mapping. The Electron `readProject` surfaces the underlying `open`'s
/// errno: ENOENT says the project is missing, EACCES/EPERM says it cannot
/// be accessed, and everything else keeps the generic read error. Opening
/// here reproduces those codes before the bounded read generalizes them.
fn read_project_for_open_recent(path: &Path) -> Result<Value> {
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(io) if io.kind() == std::io::ErrorKind::NotFound => {
            return Err(PersistenceError(format!(
                "This project is missing: {}",
                path.display()
            )))
        }
        Err(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(PersistenceError(format!(
                "This project cannot be accessed: {}",
                path.display()
            )))
        }
        Err(_) => {}
    }
    crate::project_files::read_project(path)
}

/// Mirrors the Electron `project:open-recent` handler: the same trusted
/// pipeline as the Open dialog, with the path supplied by the persisted
/// recents list.
pub fn open_recent_file(
    session: &FileOperations,
    recents: &mut RecentProjects,
    recent_path: &str,
) -> Result<LoadedProject> {
    if recent_path.encode_utf16().count() > MAX_RECENT_PATH_UNITS || !js_is_absolute(recent_path) {
        return Err(PersistenceError("Invalid recent project.".into()));
    }
    let project = read_project_for_open_recent(Path::new(recent_path))?;
    let name = file_name_of(Path::new(recent_path));
    session.set_current(Some(recent_path.to_string()));
    // Re-adding moves the project back to the top of Recents; a recents
    // write failure must not fail the open itself.
    let _ = recents.add(recent_path, &name);
    Ok(LoadedProject {
        name,
        path: recent_path.to_string(),
        project,
    })
}

/// Mirrors the Electron `project:open` handler: dialog, read, record, and
/// return `None` untouched when the user cancels.
pub fn open_project_dialog(
    session: &FileOperations,
    recents: &mut RecentProjects,
    dialogs: &impl Dialogs,
) -> Result<Option<LoadedProject>> {
    let Some(path) = dialogs.pick_open() else {
        return Ok(None);
    };
    let project = crate::project_files::read_project(Path::new(&path))?;
    let name = file_name_of(Path::new(&path));
    session.set_current(Some(path.clone()));
    // Recorded only after the project actually loaded; a recents write
    // failure must not fail the open itself.
    let _ = recents.add(&path, &name);
    Ok(Some(LoadedProject {
        name,
        path,
        project,
    }))
}

/// Mirrors the Electron `project:save` handler. The draft validates before
/// any dialog appears; Save writes to the session's current path without a
/// dialog, Save As (and a pathless session) always asks.
pub fn save_project(
    session: &FileOperations,
    recents: &mut RecentProjects,
    project: &Value,
    save_as: bool,
    dialogs: &impl Dialogs,
) -> Result<Option<SavedProject>> {
    // Electron encodes (validates) the project before opening the dialog;
    // an invalid draft must never reach it.
    crate::project_files::validate_project(project)?;
    let mut destination = session.current();
    if save_as || destination.is_none() {
        let Some(picked) = dialogs.pick_save(destination.as_deref()) else {
            return Ok(None);
        };
        destination = Some(picked);
    }
    let mut path = destination.expect("save destination after the dialog step");
    // Electron appends ".framecode.json" to any destination that does not
    // already end in ".json" (case-insensitively).
    if !path.to_lowercase().ends_with(".json") {
        path.push_str(".framecode.json");
    }
    crate::project_files::write_project(Path::new(&path), project)?;
    session.set_current(Some(path.clone()));
    let name = file_name_of(Path::new(&path));
    // A successful save is exactly what earns a Recents entry; Save As to a
    // new path records the new location, Save refreshes the existing one.
    let _ = recents.add(&path, &name);
    Ok(Some(SavedProject { name, path }))
}

/// Mirrors the Electron `project:new` handler: the session forgets its
/// current path and reports the Untitled document name.
pub fn new_project(session: &FileOperations) -> NewProject {
    session.set_current(None);
    NewProject {
        name: UNTITLED_NAME.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-fops-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project() -> Value {
        json!({
            "format": "framecode-project",
            "version": 1,
            "source": "composition(\"Demo\").duration(5)",
            "lastValid": "composition(\"Demo\").duration(5)",
        })
    }

    fn absolute(path: &std::path::Path) -> String {
        path.to_string_lossy().replace('/', "\\")
    }

    /// Fixture dialogs standing in for the real pickers, recording which
    /// picker was used so tests can prove a dialog did or did not open.
    struct FixtureDialogs {
        open: Option<String>,
        save: Option<String>,
        image: Option<String>,
        relink: bool,
        calls: Arc<StdMutex<Vec<&'static str>>>,
        last_default: Arc<StdMutex<Option<String>>>,
        last_relink: Arc<StdMutex<Option<Vec<String>>>>,
    }

    impl FixtureDialogs {
        fn none() -> FixtureDialogs {
            FixtureDialogs {
                open: None,
                save: None,
                image: None,
                relink: false,
                calls: Arc::new(StdMutex::new(Vec::new())),
                last_default: Arc::new(StdMutex::new(None)),
                last_relink: Arc::new(StdMutex::new(None)),
            }
        }
        fn answered(open: Option<&str>, save: Option<&str>) -> FixtureDialogs {
            FixtureDialogs {
                open: open.map(String::from),
                save: save.map(String::from),
                image: None,
                relink: false,
                calls: Arc::new(StdMutex::new(Vec::new())),
                last_default: Arc::new(StdMutex::new(None)),
                last_relink: Arc::new(StdMutex::new(None)),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.to_string())
                .collect()
        }
    }

    impl Dialogs for FixtureDialogs {
        fn pick_open(&self) -> Option<String> {
            self.calls.lock().unwrap().push("open");
            self.open.clone()
        }
        fn pick_save(&self, current: Option<&str>) -> Option<String> {
            self.calls.lock().unwrap().push("save");
            self.last_default
                .lock()
                .unwrap()
                .replace(current.unwrap_or("<none>").to_string());
            self.save.clone()
        }
        fn pick_image(&self) -> Option<String> {
            self.calls.lock().unwrap().push("image");
            self.image.clone()
        }
        fn confirm_relink(&self, candidates: &[String]) -> bool {
            self.calls.lock().unwrap().push("relink");
            self.last_relink
                .lock()
                .unwrap()
                .replace(candidates.to_vec());
            self.relink
        }
    }

    fn setup(dir: &std::path::Path) -> (FileOperations, RecentProjects) {
        let recents = RecentProjects::new(dir);
        (FileOperations::new(), recents)
    }

    #[test]
    fn open_recent_loads_the_project_and_moves_it_to_the_top_of_recents() {
        let dir = unique_dir("open-recent");
        let path = dir.join("Opened.framecode.json");
        fs::write(&path, serde_json::to_string(&project()).unwrap()).unwrap();
        let other = dir.join("Other.framecode.json");
        fs::write(&other, "{}\n").unwrap();
        let (session, mut recents) = setup(&dir);
        recents
            .add(&absolute(&other), "Other.framecode.json")
            .unwrap();

        let loaded = open_recent_file(&session, &mut recents, &absolute(&path)).unwrap();
        assert_eq!(loaded.name, "Opened.framecode.json");
        assert_eq!(loaded.path, absolute(&path));
        assert_eq!(loaded.project, project());
        assert_eq!(session.current(), Some(absolute(&path)));
        let list = recents.list().unwrap();
        assert_eq!(list[0].entry.name, "Opened.framecode.json");
        assert!(!list[0].missing);
        assert_eq!(list[1].entry.name, "Other.framecode.json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_recent_rejects_relative_and_oversized_paths_like_electron() {
        let dir = unique_dir("open-recent-invalid");
        let (session, mut recents) = setup(&dir);
        for invalid in ["relative/path.framecode.json", &"x".repeat(4097)] {
            let error = open_recent_file(&session, &mut recents, invalid)
                .err()
                .unwrap();
            assert_eq!(error.to_string(), "Invalid recent project.");
        }
        assert_eq!(session.current(), None);
        assert!(recents.list().unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_recent_reports_missing_projects_like_electron() {
        let dir = unique_dir("open-recent-missing");
        let missing = dir.join("Gone.framecode.json");
        let (session, mut recents) = setup(&dir);
        let error = open_recent_file(&session, &mut recents, &absolute(&missing))
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            format!("This project is missing: {}", absolute(&missing))
        );
        // A failed open must not touch the session or the recents list.
        assert_eq!(session.current(), None);
        assert!(recents.list().unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn open_recent_reports_inaccessible_projects_like_electron() {
        // A file no principal may read produces EACCES on Windows, which
        // the Electron handler maps to "This project cannot be accessed:".
        let dir = unique_dir("open-recent-denied");
        let denied = dir.join("Locked.framecode.json");
        fs::write(&denied, serde_json::to_string(&project()).unwrap()).unwrap();
        let output = std::process::Command::new("icacls")
            .arg(&denied)
            .args(["/deny", "*S-1-1-0:(R)"])
            .output()
            .expect("icacls must exist on Windows");
        assert!(output.status.success(), "icacls deny failed");
        let (session, mut recents) = setup(&dir);
        let error = open_recent_file(&session, &mut recents, &absolute(&denied))
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            format!("This project cannot be accessed: {}", absolute(&denied))
        );
        let _ = std::process::Command::new("icacls")
            .arg(&denied)
            .args(["/remove:d", "*S-1-1-0"])
            .output();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_dialog_cancel_touches_nothing_and_success_records_everything() {
        let dir = unique_dir("open-dialog");
        let path = dir.join("Chosen.framecode.json");
        fs::write(&path, serde_json::to_string(&project()).unwrap()).unwrap();
        let (session, mut recents) = setup(&dir);

        let canceled =
            open_project_dialog(&session, &mut recents, &FixtureDialogs::none()).unwrap();
        assert_eq!(canceled, None);
        assert_eq!(session.current(), None);
        assert!(recents.list().unwrap().is_empty());

        let dialogs = FixtureDialogs::answered(Some(&absolute(&path)), None);
        let loaded = open_project_dialog(&session, &mut recents, &dialogs)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.name, "Chosen.framecode.json");
        assert_eq!(loaded.project, project());
        assert_eq!(session.current(), Some(absolute(&path)));
        assert_eq!(
            recents.list().unwrap()[0].entry.name,
            "Chosen.framecode.json"
        );
        assert_eq!(dialogs.calls(), vec!["open"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_writes_to_the_current_path_without_a_dialog() {
        let dir = unique_dir("save-current");
        let path = dir.join("Current.framecode.json");
        let (session, mut recents) = setup(&dir);
        session.set_current(Some(absolute(&path)));

        let mut next = project();
        next["source"] = json!("composition(\"Demo\").duration(6)");
        next["lastValid"] = next["source"].clone();
        let dialogs = FixtureDialogs::none();
        let saved = save_project(&session, &mut recents, &next, false, &dialogs)
            .unwrap()
            .unwrap();
        assert_eq!(saved.name, "Current.framecode.json");
        assert_eq!(saved.path, absolute(&path));
        assert_eq!(dialogs.calls(), Vec::<String>::new(), "no dialog for Save");
        assert_eq!(session.current(), Some(absolute(&path)));
        assert_eq!(crate::project_files::read_project(&path).unwrap(), next);
        assert_eq!(
            recents.list().unwrap()[0].entry.name,
            "Current.framecode.json"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_as_asks_and_cancel_saves_nothing() {
        let dir = unique_dir("save-as-cancel");
        let (session, mut recents) = setup(&dir);
        let dialogs = FixtureDialogs::answered(None, None);
        let saved = save_project(&session, &mut recents, &project(), true, &dialogs).unwrap();
        assert_eq!(saved, None);
        assert_eq!(session.current(), None);
        assert!(recents.list().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            0,
            "no project file or recents.json was written"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_as_uses_the_dialog_destination_and_enforces_the_json_suffix() {
        let dir = unique_dir("save-as");
        let picked = dir.join("Exported");
        let (session, mut recents) = setup(&dir);
        let dialogs = FixtureDialogs::answered(None, Some(&absolute(&picked)));
        let saved = save_project(&session, &mut recents, &project(), true, &dialogs)
            .unwrap()
            .unwrap();
        assert_eq!(saved.path, absolute(&picked) + ".framecode.json");
        assert_eq!(session.current(), Some(saved.path.clone()));
        assert_eq!(
            crate::project_files::read_project(std::path::Path::new(&saved.path)).unwrap(),
            project()
        );
        assert_eq!(recents.list().unwrap()[0].entry.path, saved.path);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_as_refreshes_the_existing_current_path_when_the_dialog_repeats_it() {
        // Electron: Save As to the same path refreshes the existing recents
        // entry rather than adding a duplicate.
        let dir = unique_dir("save-as-same");
        let path = dir.join("Same.framecode.json");
        let (session, mut recents) = setup(&dir);
        session.set_current(Some(absolute(&path)));
        let dialogs = FixtureDialogs::answered(None, Some(&absolute(&path)));
        let saved = save_project(&session, &mut recents, &project(), true, &dialogs)
            .unwrap()
            .unwrap();
        assert_eq!(saved.path, absolute(&path));
        assert_eq!(recents.list().unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_drafts_are_rejected_before_any_dialog_opens() {
        let dir = unique_dir("save-invalid");
        let (session, mut recents) = setup(&dir);
        let mut invalid = project();
        invalid["version"] = json!(2);
        let dialogs = FixtureDialogs::answered(None, Some("C:\\picked.json"));
        let error = save_project(&session, &mut recents, &invalid, true, &dialogs)
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            "Unsupported or invalid Framecode project."
        );
        assert_eq!(
            dialogs.calls(),
            Vec::<String>::new(),
            "no dialog for a draft that cannot be saved"
        );
        assert_eq!(session.current(), None);
        assert!(recents.list().unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_second_concurrent_file_operation_is_rejected_like_electron() {
        let files = FileOperations::new();
        // Occupy the exclusive slot: a nested run_exclusive must see the
        // busy flag and fail without deadlocking, exactly like two
        // overlapping renderer calls into the Electron exclusive helper.
        *files.busy.lock().unwrap() = true;
        let error = files
            .run_exclusive(|| Ok::<(), PersistenceError>(()))
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            "A file operation is already in progress."
        );
        // The failing check does not clear the flag of the operation that
        // owns it; run_exclusive clears it when its own operation finishes.
        *files.busy.lock().unwrap() = false;
        files
            .run_exclusive(|| Ok::<(), PersistenceError>(()))
            .unwrap();
    }

    #[test]
    fn project_new_clears_the_current_path_and_reports_the_untitled_name() {
        let dir = unique_dir("new");
        let path = dir.join("Old.framecode.json");
        let (session, _recents) = setup(&dir);
        session.set_current(Some(absolute(&path)));
        let created = new_project(&session);
        assert_eq!(created.name, UNTITLED_NAME);
        assert_eq!(session.current(), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
