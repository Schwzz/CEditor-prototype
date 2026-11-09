use serde::Serialize;

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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_info])
        .run(tauri::generate_context!())
        .expect("Framecode could not start in its Tauri shell");
}
