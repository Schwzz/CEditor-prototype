//! Stage 5 window-lifecycle behavior, exercised through the crate's public
//! API and compared against the Electron main process it replaces
//! (`desktop/main.cjs`).
//!
//! Lives in `tests/` (not `#[cfg(test)]`) so the harness binary is a real
//! test target: the build script links the comctl32-v6 manifest resource
//! into test binaries (`cargo:rustc-link-arg-tests`, see build.rs), and the
//! native menus need that manifest for their `SetWindowSubclass` imports.

use framecode_lib::window_lifecycle::{
    unsaved_choice, CloseDecision, UnsavedChoice, WindowLifecycle, Zoom,
};

#[test]
fn the_title_matches_the_electron_apply_title_rules() {
    let lifecycle = WindowLifecycle::default();
    // Home always shows the bare application name.
    assert_eq!(lifecycle.set_stage("home").unwrap(), "Framecode");
    assert_eq!(
        lifecycle.set_dirty(true, "Demo".to_string()).unwrap(),
        "Framecode"
    );
    // A clean named document has no dirty marker.
    assert_eq!(
        lifecycle.set_stage("editor").unwrap(),
        "\u{25cf} Demo \u{2014} Framecode"
    );
    assert_eq!(
        lifecycle
            .set_dirty(false, "Demo.framecode.json".to_string())
            .unwrap(),
        "Demo.framecode.json \u{2014} Framecode"
    );
    // A dirty document is prefixed with the filled circle.
    assert_eq!(
        lifecycle.set_dirty(true, "Demo".to_string()).unwrap(),
        "\u{25cf} Demo \u{2014} Framecode"
    );
    // An unnamed editor document keeps the bare name.
    assert_eq!(
        lifecycle.set_dirty(true, String::new()).unwrap(),
        "\u{25cf} Framecode"
    );
    // The name is truncated to 100 characters, like Electron's slice.
    let title = lifecycle.set_dirty(false, "x".repeat(150)).unwrap();
    assert_eq!(
        title.chars().count(),
        100 + " \u{2014} Framecode".chars().count()
    );
    assert!(title.starts_with("xxx"));
}

#[test]
fn dirty_and_stage_updates_follow_the_electron_validation() {
    let lifecycle = WindowLifecycle::default();
    // The Electron handler rejects oversized names.
    let oversized = "x".repeat(50001);
    assert_eq!(
        lifecycle.set_dirty(false, oversized).unwrap_err(),
        "Invalid document state."
    );
    // Exactly 50000 UTF-16 units is accepted.
    lifecycle.set_dirty(false, "x".repeat(50000)).unwrap();
    assert_eq!(
        lifecycle.set_stage("editor").unwrap(),
        format!("{} \u{2014} Framecode", "x".repeat(100)),
        "the long name is truncated in the title"
    );
    assert_eq!(lifecycle.set_stage("wrong").unwrap_err(), "Invalid stage.");
}

#[test]
fn the_close_decision_matches_the_electron_close_handler() {
    // A clean window closes without intervention.
    let lifecycle = WindowLifecycle::default();
    assert_eq!(lifecycle.request_close(), CloseDecision::Allow);
    // A dirty window prompts, and an in-flight prompt blocks repeats.
    lifecycle.set_dirty(true, "Demo".to_string()).unwrap();
    assert_eq!(lifecycle.request_close(), CloseDecision::Prompt);
    assert_eq!(lifecycle.request_close(), CloseDecision::Block);
    // The re-arm lets a later close attempt re-prompt.
    lifecycle.disarm_close();
    assert_eq!(lifecycle.request_close(), CloseDecision::Prompt);
}

#[test]
fn an_attested_close_proceeds_even_when_dirty_flips_back() {
    let lifecycle = WindowLifecycle::default();
    lifecycle.set_dirty(false, "Demo".to_string()).unwrap();
    lifecycle.finish_close().unwrap();
    // The renderer may flip dirty again before the close lands; the
    // attestation (the Electron `allowClose` flag) still allows it.
    lifecycle.set_dirty(true, "Demo".to_string()).unwrap();
    assert_eq!(lifecycle.request_close(), CloseDecision::Allow);
}

#[test]
fn finish_close_refuses_dirty_documents_and_allows_clean_ones() {
    let lifecycle = WindowLifecycle::default();
    lifecycle.set_dirty(true, "Demo".to_string()).unwrap();
    assert_eq!(
        lifecycle.finish_close().unwrap_err(),
        "Newer unsaved changes remain."
    );
    // The refused finish never attests the close.
    assert_eq!(
        lifecycle.request_close(),
        CloseDecision::Prompt,
        "a dirty document still prompts"
    );
    lifecycle.set_dirty(false, "Demo".to_string()).unwrap();
    lifecycle.finish_close().unwrap();
    assert_eq!(lifecycle.request_close(), CloseDecision::Allow);
}

#[test]
fn unsaved_choices_map_the_native_dialog_buttons_like_electron() {
    use tauri_plugin_dialog::MessageDialogResult as R;
    assert_eq!(
        unsaved_choice(R::Custom("Save".into())),
        UnsavedChoice::Save
    );
    assert_eq!(
        unsaved_choice(R::Custom("Don't Save".into())),
        UnsavedChoice::Discard
    );
    // Esc and any unexpected button answer Cancel (the Electron
    // dialog's cancelId).
    assert_eq!(unsaved_choice(R::Cancel), UnsavedChoice::Cancel);
    assert_eq!(
        unsaved_choice(R::Custom("Whatever".into())),
        UnsavedChoice::Cancel
    );
}

#[test]
fn zoom_steps_match_the_electron_view_roles() {
    let lifecycle = WindowLifecycle::default();
    assert_eq!(lifecycle.zoom(Zoom::In), 1.2);
    assert_eq!(lifecycle.zoom(Zoom::In), 1.44);
    assert_eq!(lifecycle.zoom(Zoom::Out), 1.2);
    assert_eq!(lifecycle.zoom(Zoom::Reset), 1.0);
}
