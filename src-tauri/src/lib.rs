//! Framecode's Tauri backend.
//!
//! Stage 2 of the Tauri migration: persistence (project files, settings,
//! recents, recovery) lives here, ported from the Electron main process
//! with identical on-disk formats and validation. Native dialogs, menus,
//! clipboard wiring, window controls, and the close handshake belong to
//! later stages and are deliberately absent.

mod project_files;
mod recents;
mod recovery;
mod settings;

use recents::RecentProjects;
use recovery::RecoveryStore;
use serde::Serialize;
use serde_json::Value;
use settings::{AppSettings, Settings};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Serialize)]
pub struct DesktopInfo {
    pub name: String,
    pub version: String,
}

/// Stage 1 proof-of-life command: the frontend invokes this once at boot to
/// demonstrate the render-to-Rust path. The identity comes from the Tauri
/// config (productName/version), mirroring Electron's package.json source of
/// truth in desktop/main.cjs.
#[tauri::command]
fn desktop_info(app: tauri::AppHandle) -> DesktopInfo {
    // Visible in `tauri dev` output (debug console attached): each line marks
    // one successful frontend -> Rust invocation of this command.
    println!("DESKTOP_COMMAND desktop_info invoked");
    let info = app.package_info();
    DesktopInfo {
        name: info.name.clone(),
        version: info.version.to_string(),
    }
}

/// All persistence for one data directory. The mutex serializes every
/// operation exactly like the Electron promise queues do, which is what
/// guarantees that a recovery write dispatched before a clear can never
/// resurrect cleared data.
struct Stores {
    settings: AppSettings,
    recents: RecentProjects,
    recovery: RecoveryStore,
}

pub struct Persistence {
    inner: Mutex<Stores>,
}

impl Persistence {
    fn new(directory: PathBuf) -> Result<Persistence, String> {
        // A fresh install has no app-data directory yet; every store below
        // expects its directory to exist (settings load reads it, recents
        // and recovery write into it), so create it up front.
        std::fs::create_dir_all(&directory)
            .map_err(|e| format!("Framecode could not create its data directory: {e}"))?;
        let mut app_settings = AppSettings::new(&directory);
        // A corrupt/missing settings file resolves to defaults here, so a
        // fresh window always boots with a valid, complete preference set.
        let loaded = app_settings
            .load()
            .map_err(|e| format!("settings load failed: {e}"))?;
        let recents = RecentProjects::new_with_cap(&directory, loaded.max_recents)
            .map_err(|e| format!("recents init failed: {e}"))?;
        Ok(Persistence {
            inner: Mutex::new(Stores {
                settings: app_settings,
                recents,
                recovery: RecoveryStore::new(&directory),
            }),
        })
    }
}

type CommandResult<T> = Result<T, String>;

fn with_stores<T>(
    state: &Persistence,
    operation: impl FnOnce(&mut Stores) -> CommandResult<T>,
) -> CommandResult<T> {
    let mut stores = state
        .inner
        .lock()
        .map_err(|_| "The persistence store is unavailable.".to_string())?;
    operation(&mut stores)
}

#[tauri::command]
fn settings_get(state: tauri::State<Persistence>) -> CommandResult<Settings> {
    with_stores(&state, |stores| Ok(stores.settings.all()))
}

/// Preferences are validated and persisted by the settings store; a new
/// recents cap applies to the live list the moment it is saved, exactly as
/// the Electron settings:set handler does.
#[tauri::command]
fn settings_set(
    state: tauri::State<Persistence>,
    key: String,
    value: Value,
) -> CommandResult<Settings> {
    with_stores(&state, |stores| apply_setting(stores, &key, &value))
}

/// Validates, persists, and — for maxRecents — applies the new cap to the
/// live recents list, exactly as the Electron settings:set handler does.
fn apply_setting(stores: &mut Stores, key: &str, value: &Value) -> CommandResult<Settings> {
    let all = stores.settings.set(key, value).map_err(|e| e.to_string())?;
    if key == "maxRecents" {
        stores
            .recents
            .set_cap(all.max_recents)
            .map_err(|e| e.to_string())?;
    }
    Ok(all)
}

#[tauri::command]
fn settings_reset(state: tauri::State<Persistence>) -> CommandResult<Settings> {
    with_stores(&state, |stores| {
        let all = stores.settings.reset().map_err(|e| e.to_string())?;
        // A recents-cap failure must not fail the reset itself.
        let _ = stores.recents.set_cap(all.max_recents);
        Ok(all)
    })
}

#[tauri::command]
fn recents_list(state: tauri::State<Persistence>) -> CommandResult<Vec<recents::RecentListEntry>> {
    with_stores(&state, |stores| {
        stores.recents.list().map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn recents_remove(
    state: tauri::State<Persistence>,
    path: String,
) -> CommandResult<Vec<recents::RecentEntry>> {
    with_stores(&state, |stores| {
        // Mirrors the Electron recents:remove guard on the path length.
        if path.encode_utf16().count() > 4096 {
            return Err("Invalid recent project.".into());
        }
        stores.recents.remove(&path).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn recovery_read(state: tauri::State<Persistence>) -> CommandResult<Option<Value>> {
    with_stores(&state, |stores| {
        stores.recovery.read().map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn recovery_write(state: tauri::State<Persistence>, project: Value) -> CommandResult<()> {
    with_stores(&state, |stores| {
        stores.recovery.write(&project).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn recovery_clear(state: tauri::State<Persistence>) -> CommandResult<()> {
    with_stores(&state, |stores| {
        stores.recovery.clear().map_err(|e| e.to_string())
    })
}

/// Reads and structurally validates a Framecode project file. The 1 MiB
/// limit and format checks mirror `desktop/project-files.mjs`; composition
/// compilation stays in the JavaScript engine.
#[tauri::command]
fn project_read(path: String) -> CommandResult<Value> {
    project_files::read_project(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Structurally validates and atomically writes a Framecode project file,
/// leaving no temporary files behind on success or failure.
#[tauri::command]
fn project_write(path: String, project: Value) -> CommandResult<()> {
    project_files::write_project(std::path::Path::new(&path), &project).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            settings_get,
            settings_set,
            settings_reset,
            recents_list,
            recents_remove,
            recovery_read,
            recovery_write,
            recovery_clear,
            project_read,
            project_write,
        ])
        .setup(|app| {
            // The data directory mirrors Electron's app.getPath("userData")
            // role: all persistence files live under the OS app-data
            // location for the configured bundle identifier.
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Framecode could not resolve its data directory: {e}"))?;
            let persistence = Persistence::new(directory)
                .map_err(|e| format!("Framecode could not start its persistence store: {e}"))?;
            app.manage(persistence);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Framecode could not start in its Tauri shell");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-state-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A path that does not exist yet, as on a fresh install.
    fn missing_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("framecode-state-{name}-{nanos}"))
    }

    #[test]
    fn persistence_boots_with_defaults_and_applies_the_recents_cap() {
        let dir = unique_dir("boot");
        let state = Persistence::new(dir.clone()).unwrap();
        {
            let mut stores = state.inner.lock().unwrap();
            let all = apply_setting(&mut stores, "maxRecents", &json!(4)).unwrap();
            assert_eq!(all.max_recents, 4);
            assert_eq!(stores.recents.cap(), 4, "cap applies immediately");
        }
        assert!(dir.join("settings.json").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn persistence_initializes_and_writes_in_a_fresh_data_directory() {
        // Regression: a fresh install has no app-data directory, and every
        // store (settings read, recents and recovery writes) needs it.
        let dir = missing_dir("fresh");
        assert!(!dir.exists(), "the test directory must not pre-exist");
        let state = Persistence::new(dir.clone()).unwrap();
        assert!(dir.is_dir(), "initialization created the data directory");
        {
            let mut stores = state.inner.lock().unwrap();
            stores
                .settings
                .set("timelineSnap", &json!(false))
                .expect("settings write in a fresh directory");
            stores
                .recents
                .add(&dir.join("Added.framecode.json").to_string_lossy(), "Added")
                .expect("recents write in a fresh directory");
            stores
                .recovery
                .write(&json!({
                    "format": "framecode-project",
                    "version": 1,
                    "source": "composition(\"Demo\")",
                    "lastValid": "composition(\"Demo\")",
                }))
                .expect("recovery write in a fresh directory");
        }
        assert!(dir.join("settings.json").exists());
        assert!(dir.join("recents.json").exists());
        assert!(dir.join("recovery.json").exists());
        // Rebooting on the same directory reads the persisted values back.
        let reloaded = Persistence::new(dir.clone()).unwrap();
        {
            let stores = reloaded.inner.lock().unwrap();
            assert!(!stores.settings.all().timeline_snap);
            assert_eq!(stores.recents.list().unwrap()[0].entry.name, "Added");
            assert!(stores.recovery.read().unwrap().is_some());
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
