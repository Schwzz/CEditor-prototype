//! Framecode's Tauri backend.
//!
//! Stage 4 of the Tauri migration: asset handling (image import, secure
//! asset authorization and serving, recovery relinking) joined the Stage 2
//! persistence backend and the Stage 3 file operations, all ported from the
//! Electron main process with identical on-disk formats, validation, and
//! security model. Native menus, window controls, and the close handshake
//! belong to later stages and are deliberately absent.

mod assets;
mod composition;
mod file_operations;
mod project_files;
mod recents;
mod recovery;
mod settings;

use assets::{AssetAuthorizer, CapabilityTokens, RelinkResult};
use file_operations::{
    Dialogs, FileOperations, LoadedProject, NewProject, SavedProject, TauriDialogs,
};
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

/// Per-webview asset authorization and capability tokens (Stage 4): the
/// Electron `window.__authorizedAssets` sets and `windowTokenMap`, keyed
/// by Tauri webview label. Authorization is minted only inside Rust
/// commands, at trusted moments; the renderer only ever receives its
/// capability token so it can build asset URLs.
pub struct AssetState {
    authorizer: AssetAuthorizer,
    tokens: CapabilityTokens,
}

impl Default for AssetState {
    fn default() -> AssetState {
        AssetState {
            authorizer: AssetAuthorizer::new(),
            tokens: CapabilityTokens::new(),
        }
    }
}

/// The Electron `scanForAssets` + `__authorizedAssets.clear()` pair: a
/// successful project adoption drops the webview's authorized set and
/// re-authorizes the image paths referenced by `source` and `lastValid`.
/// The scan is the engine-faithful compile in `composition.rs`: only the
/// resolved `source` paths of valid image clips are candidates, and a
/// composition that does not compile contributes nothing (fail-closed).
/// The same extension/size/absolute-path gates bound every authorization,
/// so non-image paths can never be authorized.
fn scan_project_assets(assets: &AssetState, label: &str, project: &Value) {
    let mut seen = std::collections::HashSet::new();
    for key in ["source", "lastValid"] {
        let Some(source) = project.get(key).and_then(Value::as_str) else {
            continue;
        };
        let Ok(sources) = composition::image_clip_sources(source) else {
            continue;
        };
        for path in sources {
            if seen.insert(path.clone()) {
                assets.authorizer.authorize(label, &path);
            }
        }
    }
}

/// The overridden `tauri` URI scheme protocol (Stage 4). Tauri only
/// registers its own handler when the app has not registered one for the
/// scheme (`manager/webview.rs`), so this handler takes over the app
/// origin: it serves the three renderer files through the embedded asset
/// resolver and `/assets/` requests through the Electron guard chain.
/// Serving assets on the app origin keeps drawn images same-origin so
/// `<canvas>` pixel reads never taint — the same property Electron gets
/// from `framecode://app/assets/`.
fn tauri_protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    fn response(
        status: u16,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> tauri::http::Response<Vec<u8>> {
        let mut builder = tauri::http::Response::builder().status(status);
        if let Some(content_type) = content_type {
            builder = builder.header("Content-Type", content_type);
        }
        builder.body(body).expect("valid protocol response")
    }

    let state = ctx.app_handle().state::<AssetState>();
    let method = request.method().as_str().to_uppercase();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or_default().to_string();

    if path == "/assets" || path.starts_with("/assets/") {
        // URL.searchParams.get returns the first occurrence of a key.
        let mut path_param = None;
        let mut token_param = None;
        for (key, value) in assets::parse_query(&query) {
            match key.as_str() {
                "path" if path_param.is_none() => path_param = Some(value),
                "token" if token_param.is_none() => token_param = Some(value),
                _ => {}
            }
        }
        // The full Electron guard chain (method, absolute path, token,
        // per-webview authorization with the symlink re-check) runs inside
        // decide_asset_request in the same order.
        return match assets::decide_asset_request(
            &method,
            path_param.as_deref(),
            token_param.as_deref(),
            ctx.webview_label(),
            &state.authorizer,
            &state.tokens,
        ) {
            assets::AssetDecision::Reject(status) => {
                let body: &[u8] = if status == 400 {
                    b"Missing or invalid asset path"
                } else {
                    b""
                };
                response(status, None, body.to_vec())
            }
            assets::AssetDecision::Serve { path, content_type } => match std::fs::read(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    response(404, None, Vec::new())
                }
                Err(_) => response(403, None, Vec::new()),
                Ok(bytes) => response(
                    200,
                    Some(content_type),
                    if method == "HEAD" { Vec::new() } else { bytes },
                ),
            },
        };
    }

    // App files: GET/HEAD only, exactly like the Electron files map's
    // combined guard (a POST to an app file is 404 there, not 405).
    if method != "GET" && method != "HEAD" {
        return response(404, None, b"Not found".to_vec());
    }
    match assets::decide_app_file_or_root(&path) {
        None => response(404, None, b"Not found".to_vec()),
        Some((key, content_type)) => match ctx.app_handle().asset_resolver().get(key.to_string()) {
            None => response(404, None, b"Not found".to_vec()),
            Some(asset) => response(
                200,
                Some(content_type),
                if method == "HEAD" {
                    Vec::new()
                } else {
                    asset.bytes
                },
            ),
        },
    }
}

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

/// The Electron `project:open` handler: the Open dialog picks a `.json`
/// project, it is read and recorded in recents, and the session adopts it
/// as the current document path. Canceling the dialog returns `None`.
/// A successful open drops the webview's authorized asset set and
/// re-authorizes the scanned image paths (the Electron clear +
/// `scanForAssets` pair).
#[tauri::command]
fn project_open_dialog(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<Persistence>,
    files: tauri::State<FileOperations>,
    assets: tauri::State<AssetState>,
) -> CommandResult<Option<LoadedProject>> {
    let dialogs = TauriDialogs::new(app);
    files
        .run_exclusive(|| {
            with_stores(&state, |stores| {
                file_operations::open_project_dialog(&files, &mut stores.recents, &dialogs)
                    .map(|loaded| {
                        loaded.map(|loaded| {
                            assets.authorizer.clear(window.label());
                            scan_project_assets(&assets, window.label(), &loaded.project);
                            loaded
                        })
                    })
                    .map_err(|e| e.to_string())
            })
        })
        .map_err(|e| e.to_string())
}

/// The Electron `project:open-recent` handler: the same trusted pipeline as
/// the Open dialog, with the path supplied by the persisted recents list.
/// A successful open re-authorizes assets exactly like the Open dialog.
#[tauri::command]
fn project_open_recent(
    window: tauri::Window,
    state: tauri::State<Persistence>,
    files: tauri::State<FileOperations>,
    assets: tauri::State<AssetState>,
    path: String,
) -> CommandResult<LoadedProject> {
    files
        .run_exclusive(|| {
            with_stores(&state, |stores| {
                file_operations::open_recent_file(&files, &mut stores.recents, &path)
                    .map(|loaded| {
                        assets.authorizer.clear(window.label());
                        scan_project_assets(&assets, window.label(), &loaded.project);
                        loaded
                    })
                    .map_err(|e| e.to_string())
            })
        })
        .map_err(|e| e.to_string())
}

/// The Electron `project:save` handler: Save writes to the session's
/// current path without a dialog; Save As (or a pathless session) asks
/// through the Save dialog, whose destination gains the ".framecode.json"
/// suffix when it lacks one. A canceled dialog returns `None` and the
/// session keeps its previous path.
#[tauri::command]
fn project_save(
    app: tauri::AppHandle,
    state: tauri::State<Persistence>,
    files: tauri::State<FileOperations>,
    project: Value,
    save_as: bool,
) -> CommandResult<Option<SavedProject>> {
    let dialogs = TauriDialogs::new(app);
    files
        .run_exclusive(|| {
            with_stores(&state, |stores| {
                file_operations::save_project(
                    &files,
                    &mut stores.recents,
                    &project,
                    save_as,
                    &dialogs,
                )
                .map_err(|e| e.to_string())
            })
        })
        .map_err(|e| e.to_string())
}

/// The Electron `project:new` handler: the session forgets its current
/// document path and reports the Untitled document name. The authorized
/// asset set is dropped with the session, as in Electron.
#[tauri::command]
fn project_new(
    window: tauri::Window,
    files: tauri::State<FileOperations>,
    assets: tauri::State<AssetState>,
) -> NewProject {
    assets.authorizer.clear(window.label());
    file_operations::new_project(&files)
}

/// The Electron preload's `assetToken` (Stage 4): the webview's capability
/// token for building asset URLs. This command only reads the token — it
/// never grants authorization, which stays a Rust-side trusted action.
#[tauri::command]
fn asset_token(window: tauri::Window, assets: tauri::State<AssetState>) -> String {
    assets.tokens.token_for(window.label())
}

/// The Electron `image:import` handler: the Import image dialog picks a
/// file, authorization is minted here in Rust (never by the renderer), and
/// the picked path is returned for the renderer's `image(...)` clip.
/// Canceling the dialog returns `None`; a rejected file fails with the
/// Electron error message.
#[tauri::command]
fn image_import_dialog(
    app: tauri::AppHandle,
    window: tauri::Window,
    files: tauri::State<FileOperations>,
    assets: tauri::State<AssetState>,
) -> CommandResult<Option<String>> {
    let dialogs = TauriDialogs::new(app);
    files
        .run_exclusive(|| {
            let Some(path) = dialogs.pick_image() else {
                return Ok(None);
            };
            if assets.authorizer.authorize(window.label(), &path).is_none() {
                return Err(
                    "Could not import image: unsupported format, missing file, or exceeds size limit."
                        .to_string(),
                );
            }
            Ok(Some(path))
        })
        .map_err(|e| e.to_string())
}

/// The Electron `recovery:relink` handler. The recovery file this backend
/// wrote itself is re-read here — the renderer never supplies the document
/// — and the candidate list comes from the engine-faithful compile scan in
/// `assets.rs`. Authorization is minted only after the user accepts the
/// consent dialog that lists the exact paths; the response carries the
/// original candidate strings so the renderer can evict their failed
/// cache entries.
#[tauri::command]
fn relink_recovery_assets(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<Persistence>,
    files: tauri::State<FileOperations>,
    assets: tauri::State<AssetState>,
) -> CommandResult<RelinkResult> {
    let dialogs = TauriDialogs::new(app);
    files
        .run_exclusive(|| -> Result<RelinkResult, String> {
            let project = with_stores(&state, |stores| {
                stores.recovery.read().map_err(|e| e.to_string())
            })?;
            Ok(assets::relink_recovery_assets(
                window.label(),
                project.as_ref(),
                &assets.authorizer,
                &dialogs,
            ))
        })
        .map_err(|e| e.to_string())
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
            project_open_dialog,
            project_open_recent,
            project_save,
            project_new,
            asset_token,
            image_import_dialog,
            relink_recovery_assets,
        ])
        .plugin(tauri_plugin_dialog::init())
        // Stage 4: the overridden `tauri` protocol serves the app files and
        // /assets/ on the app origin; see tauri_protocol. Tauri only
        // registers its own handler when the app has not registered one
        // for this scheme.
        .register_uri_scheme_protocol("tauri", tauri_protocol)
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
            app.manage(FileOperations::new());
            app.manage(AssetState::default());
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
