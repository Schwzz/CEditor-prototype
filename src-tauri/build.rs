fn main() {
    tauri_build::build();
    link_resource_into_test_harness();
}

/// tauri-build embeds the Windows resource (icon, version info, and the
/// Common Controls v6 manifest the native menus need for their
/// SetWindowSubclass imports) into binaries only — `embed-resource` uses
/// `rustc-link-arg-bins`, which skips test targets. Without the manifest a
/// test harness binds comctl32 v5, and loading it dies with
/// STATUS_ENTRYPOINT_NOT_FOUND. Link the same compiled resource into test
/// binaries too; the application binary is untouched.
fn link_resource_into_test_harness() {
    if !cfg!(all(target_os = "windows", target_env = "msvc")) {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let resource = std::path::Path::new(&out_dir).join("resource.lib");
    if resource.exists() {
        println!("cargo:rustc-link-arg-tests={}", resource.display());
    }
}
