//! Asset authorization and serving for the Tauri backend (Stage 4).
//!
//! Ported from the Electron main process (`desktop/main.cjs`:
//! `installProtocol`, `authorizeAsset`, `scanForAssets`, `recovery:relink`)
//! with the same security model:
//!
//! - Assets are served on the app's own origin (the overridden `tauri`
//!   protocol handler in `lib.rs`), so `<canvas>` pixel reads never taint â€”
//!   the same property Electron gets from `framecode://app/assets/`.
//! - Authorization is minted only inside Rust, at trusted moments (project
//!   open/recent scanning, image import, recovery relink). The renderer
//!   receives only a capability token for building asset URLs; there is no
//!   renderer-driven authorization command.
//! - Authorization is tracked per webview (the Electron per-window
//!   `__authorizedAssets` sets) and asset requests must carry the
//!   requesting webview's capability token (the Electron `windowTokenMap`).
//! - Serving rejects non-GET/HEAD methods (405), blank/relative paths
//!   (400), invalid tokens (403), unauthorized paths (403, with the same
//!   symlink-escape re-check Electron performs on a miss), missing files
//!   (404), and other read errors (403).
//!
//! Composition scanning uses `composition::clip_sources`, a faithful Rust
//! port of the engine's `compile()` (`src/core/engine.mjs`): only the
//! resolved `source` of valid image/video/audio clips of a compiling
//! composition become candidates, and anything the engine rejects
//! contributes nothing. The same extension/size/absolute-path gates
//! Electron applies to every candidate still bound the result; paths whose
//! extension is not an authorized asset type can never be authorized.
//!
//! Media (Stage 6) additionally serves byte ranges: authorization runs
//! first through the unchanged guard chain, and only an authorized file is
//! sliced. See `lib.rs::tauri_protocol`.

use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The Electron `MAX_ASSET_BYTES` (50 MiB), enforced at authorization.
pub const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;

/// The Electron extension allowlist, with the MIME type each image
/// extension is served as.
pub const ALLOWED_EXTENSIONS: [(&str, &str); 5] = [
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
];

/// Video extensions and the MIME type each is served as (Stage 6).
pub const VIDEO_ASSETS: [(&str, &str); 4] = [
    ("mp4", "video/mp4"),
    ("mov", "video/quicktime"),
    ("m4v", "video/x-m4v"),
    ("webm", "video/webm"),
];

/// Audio extensions and the MIME type each is served as (Stage 6).
pub const AUDIO_ASSETS: [(&str, &str); 6] = [
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("flac", "audio/flac"),
    ("ogg", "audio/ogg"),
];

/// The asset class a path belongs to, which selects both the MIME type and
/// the authorization size ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Image,
    Video,
    Audio,
}

/// Maps an extension (lowercased here, so callers can pass raw paths) to
/// its asset kind and MIME type.
pub fn extension_asset(extension: &str) -> Option<(AssetKind, &'static str)> {
    let extension = extension.to_lowercase();
    ALLOWED_EXTENSIONS
        .iter()
        .find(|(allowed, _)| *allowed == extension)
        .map(|(_, mime)| (AssetKind::Image, *mime))
        .or_else(|| {
            VIDEO_ASSETS
                .iter()
                .find(|(allowed, _)| *allowed == extension)
                .map(|(_, mime)| (AssetKind::Video, *mime))
        })
        .or_else(|| {
            AUDIO_ASSETS
                .iter()
                .find(|(allowed, _)| *allowed == extension)
                .map(|(_, mime)| (AssetKind::Audio, *mime))
        })
}

/// Images keep the Electron 50 MiB ceiling; streamed media gets the
/// Stage 6 4 GiB ceiling.
pub fn media_limit(kind: AssetKind) -> u64 {
    match kind {
        AssetKind::Image => MAX_ASSET_BYTES,
        AssetKind::Video | AssetKind::Audio => crate::media::MAX_MEDIA_BYTES,
    }
}

/// One satisfiable byte range (or the whole file when no Range was sent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileSlice {
    pub start: u64,
    pub length: u64,
    pub total: u64,
    pub partial: bool,
}

/// Resolves a `Range` header against the file length. Returns `Err(416)`
/// for malformed, inverted, multi-part, and unsatisfiable ranges; the
/// caller maps that to `416 Range Not Satisfiable`. A range request always
/// answers `206` (including a closed range covering the whole file), which
/// is what keeps WebView2's media element seeking.
pub fn resolve_file_slice(total: u64, range: Option<&str>) -> Result<FileSlice, u16> {
    let Some(header) = range else {
        return Ok(FileSlice {
            start: 0,
            length: total,
            total,
            partial: false,
        });
    };
    if total == 0 {
        return Err(416);
    }
    let spec = header.trim().strip_prefix("bytes=").ok_or(416u16)?;
    if spec.contains(',') {
        return Err(416);
    }
    let (first, last) = spec.split_once('-').ok_or(416u16)?;
    if first.is_empty() {
        let suffix: u64 = last.trim().parse().map_err(|_| 416u16)?;
        if suffix == 0 {
            return Err(416);
        }
        let length = suffix.min(total);
        return Ok(FileSlice {
            start: total - length,
            length,
            total,
            partial: true,
        });
    }
    let start: u64 = first.trim().parse().map_err(|_| 416u16)?;
    if start >= total {
        return Err(416);
    }
    if last.trim().is_empty() {
        return Ok(FileSlice {
            start,
            length: total - start,
            total,
            partial: true,
        });
    }
    let end: u64 = last.trim().parse().map_err(|_| 416u16)?;
    if end < start {
        return Err(416);
    }
    let end = end.min(total - 1);
    Ok(FileSlice {
        start,
        length: end - start + 1,
        total,
        partial: true,
    })
}

/// The renderer files the app origin serves (the Electron `files` map in
/// `installProtocol`).
pub const APP_FILES: [(&str, &str, &str); 3] = [
    ("/index.html", "index.html", "text/html; charset=utf-8"),
    ("/app.js", "app.js", "text/javascript; charset=utf-8"),
    ("/app.css", "app.css", "text/css; charset=utf-8"),
];

fn fold(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}

/// Mirrors the Electron `normalizeAssetPath`: resolve (relative paths
/// resolve against the process working directory, as `path.resolve` does)
/// and case-fold on Windows. Returns `None` for blank paths.
pub fn normalize_asset_path(file_path: &str) -> Option<String> {
    if file_path.trim().is_empty() {
        return None;
    }
    let candidate = Path::new(file_path);
    let resolved: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(candidate)
    };
    Some(fold(&resolved))
}

/// `std::fs::canonicalize` returns `\\?\C:\â€¦` extended-length paths on
/// Windows; strip that prefix so the result compares like the Electron
/// `fs.realpath` output.
pub fn real_path(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let text = canonical.to_string_lossy().into_owned();
    let stripped = if cfg!(windows) {
        text.strip_prefix(r"\\?\").map(String::from).unwrap_or(text)
    } else {
        text
    };
    Some(fold(Path::new(&stripped)))
}

/// The extension of a path without its dot, lowercased, or `None`.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
}

/// Per-webview authorized asset sets, the Electron per-window
/// `__authorizedAssets` under the Tauri webview-label key.
#[derive(Default)]
pub struct AssetAuthorizer {
    sets: Mutex<HashMap<String, HashSet<String>>>,
    /// Canonical identities (the `real_path` form) of the regular files
    /// each webview authorized. The resolve+fold keys above keep whatever
    /// spelling the grant came through, while the realpath re-check
    /// canonicalizes: Windows spellings like 8.3 short names (the CI
    /// runner's `RUNNER~1` temp directory) or junctions survive in the
    /// key but vanish in the canonical form, so the same authorized file
    /// also needs an identity-based lookup. Symlink grants record no
    /// alias: authorizing a link must not vouch for its target, matching
    /// the Electron re-check where only the set membership of the
    /// resolved target decides.
    canonical: Mutex<HashMap<String, HashSet<String>>>,
}

impl AssetAuthorizer {
    pub fn new() -> AssetAuthorizer {
        AssetAuthorizer::default()
    }

    fn with_set<R>(
        &self,
        label: &str,
        operation: impl FnOnce(&mut HashSet<String>) -> R,
    ) -> Option<R> {
        let mut sets = self
            .sets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Some(operation(sets.entry(label.to_string()).or_default()))
    }

    fn with_canonical<R>(
        &self,
        label: &str,
        operation: impl FnOnce(&mut HashSet<String>) -> R,
    ) -> Option<R> {
        let mut canonical = self
            .canonical
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Some(operation(canonical.entry(label.to_string()).or_default()))
    }

    /// Authorizes one file for a webview if it exists, is a regular file
    /// within the size limit, and has an allowed extension (the Electron
    /// `authorizeAsset` checks). Returns the normalized path on success.
    pub fn authorize(&self, label: &str, file_path: &str) -> Option<String> {
        let normalized = normalize_asset_path(file_path)?;
        let path = Path::new(file_path);
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let extension = extension_of(path)?;
        let (kind, _) = extension_asset(&extension)?;
        if metadata.len() > media_limit(kind) {
            return None;
        }
        let _ = self.with_set(label, |set| set.insert(normalized.clone()));
        // Record the canonical identity for the realpath re-check, but
        // only for regular files: a symlink grant's canonical form is its
        // target, and recording that would let the link's authorization
        // serve the target path directly â€” the Electron re-check refuses
        // exactly that (the set must contain the resolved spelling
        // itself).
        let is_symlink = std::fs::symlink_metadata(path)
            .map(|meta| meta.is_symlink())
            .unwrap_or(false);
        if !is_symlink {
            if let Some(canonical) = real_path(path) {
                self.with_canonical(label, |set| {
                    set.insert(canonical);
                });
            }
        }
        Some(normalized)
    }

    pub fn is_authorized(&self, label: &str, normalized: &str) -> bool {
        self.with_set(label, |set| set.contains(normalized))
            .unwrap_or(false)
    }

    /// Whether the canonical real path is the canonical identity of a
    /// regular file this webview authorized â€” the identity-based lookup
    /// the realpath re-check needs when the grant's spelling canonicalizes
    /// differently (see the `canonical` field). A miss here falls back to
    /// the plain set lookup, so Electron's string-compare semantics are
    /// preserved first.
    pub fn is_real_authorized(&self, label: &str, real: &str) -> bool {
        self.with_canonical(label, |set| set.contains(real))
            .unwrap_or(false)
    }

    /// Whether the path (normalized like authorization) is in the set.
    pub fn is_path_authorized(&self, label: &str, file_path: &str) -> bool {
        normalize_asset_path(file_path)
            .map(|normalized| self.is_authorized(label, &normalized))
            .unwrap_or(false)
    }

    /// Drops every authorization of one webview (the Electron
    /// `window.__authorizedAssets.clear()` on project adoption).
    pub fn clear(&self, label: &str) {
        let _ = self.with_set(label, HashSet::clear);
        let _ = self.with_canonical(label, HashSet::clear);
    }
}

/// Capability tokens binding asset URLs to their owning webview, the
/// Electron `windowTokenMap` (token â†’ webview label).
#[derive(Default)]
pub struct CapabilityTokens {
    tokens: Mutex<HashMap<String, String>>,
}

impl CapabilityTokens {
    pub fn new() -> CapabilityTokens {
        CapabilityTokens::default()
    }

    /// Mints (or returns) the token owning a webview label. The map is
    /// keyed by token with the owning label as the value, matching the
    /// Electron `windowTokenMap`.
    pub fn token_for(&self, label: &str) -> String {
        let mut tokens = self
            .tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((existing, _)) = tokens.iter().find(|(_, owner)| *owner == label) {
            return existing.clone();
        }
        // Two UUID v4 hex forms give 64 URL-safe characters of entropy, the
        // same shape as Electron's 24 random bytes.
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        tokens.insert(token.clone(), label.to_string());
        token
    }

    /// Whether the token belongs to the requesting webview.
    pub fn verify(&self, token: Option<&str>, label: &str) -> bool {
        let Some(token) = token else {
            return false;
        };
        let tokens = self
            .tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tokens
            .get(token)
            .map(|owner| owner == label)
            .unwrap_or(false)
    }
}

/// The outcome of a validated asset request. `Serve` carries the original
/// (unfolded) path so the caller reads exactly what was requested.
#[derive(Debug, Clone, PartialEq)]
pub enum AssetDecision {
    Serve {
        path: String,
        content_type: &'static str,
    },
    Reject(u16),
}

/// Validates an asset request through the Electron protocol handler's
/// guard chain, in the same order: method (405), absolute path (400),
/// capability token (403), per-webview authorization with the symlink
/// escape re-check (403). File reads happen at the call site so ENOENT
/// maps to 404 and other errors to 403, like Electron's `net.fetch`.
pub fn decide_asset_request(
    method: &str,
    path_param: Option<&str>,
    token: Option<&str>,
    label: &str,
    authorizer: &AssetAuthorizer,
    tokens: &CapabilityTokens,
) -> AssetDecision {
    // Electron checks the method before anything else.
    if method != "GET" && method != "HEAD" {
        return AssetDecision::Reject(405);
    }
    let Some(raw) = path_param.filter(|raw| !raw.trim().is_empty()) else {
        return AssetDecision::Reject(400);
    };
    // Electron rejects non-absolute raw paths with 400 before anything else.
    if !crate::recents::js_is_absolute(raw) {
        return AssetDecision::Reject(400);
    }
    if !tokens.verify(token, label) {
        return AssetDecision::Reject(403);
    }
    let Some(normalized) = normalize_asset_path(raw) else {
        return AssetDecision::Reject(400);
    };
    let authorized = authorizer.is_authorized(label, &normalized)
        // Electron's symlink re-check: a miss re-resolves symlinks and
        // grants only when the real path differs from the requested path
        // and is in the same webview's authorized set (so a link pointing
        // at an authorized file is servable, while any other miss â€”
        // including a non-symlink path whose realpath is itself â€” is 403).
        // The identity lookup second: when the grant's spelling
        // canonicalizes differently (Windows 8.3 short names, junctions),
        // the resolved target IS the authorized file even though the
        // string keys no longer match.
        || real_path(Path::new(raw))
            .map(|real| {
                real != normalized
                    && (authorizer.is_authorized(label, &real)
                        || authorizer.is_real_authorized(label, &real))
            })
            .unwrap_or(false);
    if !authorized {
        return AssetDecision::Reject(403);
    }
    let extension = extension_of(Path::new(raw)).unwrap_or_default();
    let content_type = extension_asset(&extension)
        .map(|(_, mime)| mime)
        .unwrap_or("application/octet-stream");
    AssetDecision::Serve {
        path: raw.to_string(),
        content_type,
    }
}

/// The app-origin file requested by the window load, or `None` for 404.
pub fn decide_app_file(path: &str) -> Option<(&'static str, &'static str)> {
    APP_FILES
        .iter()
        .find(|(route, _, _)| *route == path)
        .map(|(_, key, mime)| (*key, *mime))
}

/// The root path serves the app document, like the Electron files map's
/// implicit document entry.
pub fn decide_app_file_or_root(path: &str) -> Option<(&'static str, &'static str)> {
    if path.is_empty() || path == "/" {
        return Some((APP_FILES[0].1, APP_FILES[0].2));
    }
    decide_app_file(path)
}

/// Percent-decodes one query parameter value, tolerating malformed input
/// by keeping the raw text (never panicking on untrusted input).
pub fn decode_query_value(raw: &str) -> String {
    percent_decode_str(raw).decode_utf8_lossy().into_owned()
}

/// Splits a query string into (key, decoded value) pairs. Treats the whole
/// string as untrusted input: malformed pairs are skipped, values may be
/// empty, and '+' is not treated as a space (HTML forms use that rule, not
/// `encodeURIComponent`, which the renderer builds asset URLs with).
pub fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (key.to_string(), decode_query_value(value)),
            None => (pair.to_string(), String::new()),
        })
        .collect()
}

/// The relink response the Electron `recovery:relink` handler returns.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct RelinkResult {
    pub authorized: Vec<String>,
}

/// The Electron `recovery:relink` orchestration, extracted behind the
/// `Dialogs` trait so the dialog flow is testable without a real webview.
///
/// The recovery document was written by this backend itself â€” the renderer
/// never supplies it. Candidate paths come only from the compiled valid
/// asset clips (image, video, audio) of the recovery `source`/`lastValid`
/// compositions (the engine-faithful `composition::clip_sources` scan,
/// fail-closed: anything the engine rejects contributes no candidates). Paths already
/// authorized for this webview never reopen the consent dialog. When the
/// user accepts the dialog that lists the exact remaining candidates,
/// each one is authorized through the normal gates and the response
/// carries the original candidate strings that passed.
pub fn relink_recovery_assets(
    label: &str,
    recovery: Option<&serde_json::Value>,
    authorizer: &AssetAuthorizer,
    dialogs: &impl crate::file_operations::Dialogs,
) -> RelinkResult {
    let Some(project) = recovery else {
        return RelinkResult {
            authorized: Vec::new(),
        };
    };
    // Compile each composition once; a failure contributes no candidates.
    let mut seen: HashSet<String> = HashSet::new();
    for key in ["source", "lastValid"] {
        if let Some(source) = project.get(key).and_then(serde_json::Value::as_str) {
            match crate::composition::clip_sources(source) {
                Ok(clips) => seen.extend(clips.into_iter().map(|clip| clip.path)),
                Err(_) => continue,
            }
        }
    }
    let candidates: Vec<String> = seen
        .into_iter()
        .filter(|candidate| !authorizer.is_path_authorized(label, candidate))
        .collect();
    if candidates.is_empty() {
        return RelinkResult {
            authorized: Vec::new(),
        };
    }
    if !dialogs.confirm_relink(&candidates) {
        return RelinkResult {
            authorized: Vec::new(),
        };
    }
    let mut authorized = Vec::new();
    for candidate in candidates {
        if authorizer.authorize(label, &candidate).is_some() {
            authorized.push(candidate);
        }
    }
    RelinkResult { authorized }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_operations::Dialogs;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A scripted `Dialogs` implementation: records consent prompts and
    /// returns the configured answer (the `FixtureDialogs` in
    /// `file_operations` is private to its own tests).
    struct FixtureDialogs {
        answer: bool,
        prompts: std::sync::Mutex<Vec<Vec<String>>>,
    }

    impl FixtureDialogs {
        fn new(answer: bool) -> FixtureDialogs {
            FixtureDialogs {
                answer,
                prompts: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn prompts(&self) -> Vec<Vec<String>> {
            self.prompts.lock().unwrap().clone()
        }
    }

    impl Dialogs for FixtureDialogs {
        fn pick_open(&self) -> Option<String> {
            None
        }
        fn pick_save(&self, _current: Option<&str>) -> Option<String> {
            None
        }
        fn pick_image(&self) -> Option<String> {
            None
        }
        fn confirm_relink(&self, candidates: &[String]) -> bool {
            self.prompts.lock().unwrap().push(candidates.to_vec());
            self.answer
        }
    }

    /// Builds a recovery document with a valid image clip per path, using
    /// the JSON escapes the renderer writes (backslashes escaped).
    fn recovery_source(paths: &[&str]) -> String {
        let mut source = String::from("composition(\"Recovery\").duration(10)\n");
        for (index, path) in paths.iter().enumerate() {
            source.push_str(&format!(
                "image(\"c{index}\").at({index}).for(1).source({})\n",
                serde_json::to_string(path).unwrap()
            ));
        }
        source
    }

    fn recovery_value(source: &str) -> serde_json::Value {
        serde_json::json!({ "source": source })
    }

    fn unique_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-assets-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 1Ã—1 red PNG (89 50 4E 47 â€¦), same shape as the Electron desktop
    /// smoke fixture: valid image bytes that decode as an image.
    fn png_bytes() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D,
            0xB0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    fn fixture_image(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, png_bytes()).unwrap();
        path.to_string_lossy().replace('/', "\\")
    }

    fn state() -> (AssetAuthorizer, CapabilityTokens) {
        (AssetAuthorizer::new(), CapabilityTokens::new())
    }

    #[test]
    fn normalization_resolves_and_case_folds_on_windows() {
        if cfg!(windows) {
            assert_eq!(
                normalize_asset_path("C:\\A\\Img.png"),
                normalize_asset_path("c:/a/img.png")
            );
            assert_eq!(
                normalize_asset_path("C:\\A\\Img.png"),
                Some("c:\\a\\img.png".to_string())
            );
        }
        assert_eq!(normalize_asset_path(""), None);
        assert_eq!(normalize_asset_path("   "), None);
        // Relative paths resolve against the working directory, like the
        // Electron `path.resolve` in authorizeAsset.
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            normalize_asset_path("x.png"),
            Some(fold(&cwd.join("x.png")))
        );
    }

    #[test]
    fn authorize_enforces_file_type_size_and_extension() {
        let dir = unique_dir("authorize");
        let image = fixture_image(&dir, "Img.PNG");
        let (authorizer, _) = state();
        assert!(
            authorizer.authorize("main", &image).is_some(),
            "uppercase image extensions are allowed"
        );
        assert!(authorizer.is_path_authorized("main", &image));

        let text = dir.join("Text.txt");
        fs::write(&text, "not an image").unwrap();
        assert!(authorizer
            .authorize("main", &text.to_string_lossy().as_ref())
            .is_none());

        let oversized = dir.join("Big.png");
        fs::write(&oversized, vec![0u8; (MAX_ASSET_BYTES + 1) as usize]).unwrap();
        assert!(
            authorizer
                .authorize("main", &oversized.to_string_lossy().as_ref())
                .is_none(),
            "a byte over the limit is rejected"
        );
        // Exactly at the limit passes.
        let at_limit = dir.join("AtLimit.png");
        fs::write(&at_limit, vec![0u8; MAX_ASSET_BYTES as usize]).unwrap();
        assert!(authorizer
            .authorize("main", &at_limit.to_string_lossy().as_ref())
            .is_some());

        let missing = dir.join("Gone.png");
        assert!(authorizer
            .authorize("main", &missing.to_string_lossy().as_ref())
            .is_none());
        let directory = dir.join("Folder.png");
        fs::create_dir_all(&directory).unwrap();
        assert!(
            authorizer
                .authorize("main", &directory.to_string_lossy().as_ref())
                .is_none(),
            "directories are not files"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn authorization_is_isolated_per_webview_label() {
        let dir = unique_dir("isolation");
        let image = fixture_image(&dir, "Isolated.png");
        let (authorizer, tokens) = state();
        assert!(authorizer.authorize("main", &image).is_some());
        // Another webview must not see main's authorized set...
        assert!(!authorizer.is_path_authorized("other", &image));
        // ...and cannot pass main's token check either.
        let token = tokens.token_for("main");
        assert!(tokens.verify(Some(&token), "main"));
        assert!(!tokens.verify(Some(&token), "other"));
        assert!(!tokens.verify(None, "main"));
        assert!(!tokens.verify(Some("forged"), "main"));
        // Clearing one label leaves the other untouched.
        let (authorizer, tokens) = state();
        assert!(authorizer.authorize("main", &image).is_some());
        assert!(authorizer.authorize("other", &image).is_some());
        authorizer.clear("main");
        assert!(!authorizer.is_path_authorized("main", &image));
        assert!(authorizer.is_path_authorized("other", &image));
        let _ = tokens;
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_asset_request_matrix_matches_the_electron_handler() {
        let dir = unique_dir("matrix");
        let image = fixture_image(&dir, "Matrix.png");
        let (authorizer, tokens) = state();
        authorizer.authorize("main", &image).unwrap();

        let serve = |method: &str, path: Option<&str>, token: Option<&str>| {
            decide_asset_request(method, path, token, "main", &authorizer, &tokens)
        };
        let ok = |path: &str, token: &str| serve("GET", Some(path), Some(token));

        // Authorized + correct token serves the requested path and type.
        match ok(&image, &tokens.token_for("main")) {
            AssetDecision::Serve { path, content_type } => {
                assert_eq!(path, image);
                assert_eq!(content_type, "image/png");
            }
            other => panic!("expected Serve, got {other:?}"),
        }
        // HEAD is allowed like Electron.
        assert!(matches!(
            serve("HEAD", Some(&image), Some(&tokens.token_for("main"))),
            AssetDecision::Serve { .. }
        ));
        // Method gate comes first.
        assert_eq!(
            serve("POST", Some(&image), Some(&tokens.token_for("main"))),
            AssetDecision::Reject(405)
        );
        // Missing/blank/relative paths are 400.
        assert_eq!(
            serve("GET", None, Some(&tokens.token_for("main"))),
            AssetDecision::Reject(400)
        );
        assert_eq!(
            ok("   ", &tokens.token_for("main")),
            AssetDecision::Reject(400)
        );
        assert_eq!(
            ok("relative.png", &tokens.token_for("main")),
            AssetDecision::Reject(400)
        );
        // Token gate.
        assert_eq!(serve("GET", Some(&image), None), AssetDecision::Reject(403));
        assert_eq!(ok(&image, "forged"), AssetDecision::Reject(403));
        // Unauthorized (but well-formed) paths are 403.
        let stranger = fixture_image(&dir, "Stranger.png");
        assert_eq!(
            ok(&stranger, &tokens.token_for("main")),
            AssetDecision::Reject(403)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn symlink_serving_matches_the_electron_recheck() {
        // Electron grants the re-check only when the real path differs
        // from the requested path and is authorized: a link to an
        // authorized file is servable, everything else stays 403.
        let dir = unique_dir("symlink");
        let image = fixture_image(&dir, "Target.png");
        let link = dir.join("Link.png");
        std::os::windows::fs::symlink_file(&image, &link).unwrap();
        let (authorizer, tokens) = state();
        let token = tokens.token_for("main");
        // Authorizing the target makes the link servable through its own
        // URL (the real path differs from the link path and is authorized).
        assert!(authorizer.authorize("main", &image).is_some());
        assert!(matches!(
            decide_asset_request(
                "GET",
                Some(&link.to_string_lossy()),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Serve { .. }
        ));
        // Authorizing only the link does NOT make the target path itself
        // servable: its realpath equals its own normalized path, so the
        // Electron re-check never fires for it.
        let (authorizer, tokens) = state();
        let token = tokens.token_for("main");
        assert!(authorizer
            .authorize("main", &link.to_string_lossy().as_ref())
            .is_some());
        assert_eq!(
            decide_asset_request(
                "GET",
                Some(&image),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Reject(403)
        );
        // The authorized link itself serves.
        assert!(matches!(
            decide_asset_request(
                "GET",
                Some(&link.to_string_lossy()),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Serve { .. }
        ));
        // And a link to a never-authorized file stays rejected.
        let stranger = fixture_image(&dir, "Stranger.png");
        let stranger_link = dir.join("StrangerLink.png");
        std::os::windows::fs::symlink_file(&stranger, &stranger_link).unwrap();
        assert_eq!(
            decide_asset_request(
                "GET",
                Some(&stranger_link.to_string_lossy()),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Reject(403),
            "an unauthorized symlink must not inherit its target's authorization"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn symlink_recheck_survives_a_spelling_canonicalize_rewrites() {
        // Windows CI's %TEMP% contains an 8.3 short name (`RUNNER~1`): the
        // resolve+fold authorization key keeps that spelling, while the
        // re-check's realpath canonicalizes it to the long form, so a
        // link to an authorized file missed the lookup and got 403. A
        // doubled separator reproduces the same divergence deterministically
        // in process â€” the resolve+fold key keeps it, canonicalize
        // collapses it.
        let dir = unique_dir("symlink-spelling");
        let image = fixture_image(&dir, "Target.png");
        let rewritten = format!("{}\\\\{}", dir.display(), "Target.png");
        let link = dir.join("Link.png");
        std::os::windows::fs::symlink_file(Path::new(&image), &link).unwrap();
        let (authorizer, tokens) = state();
        let token = tokens.token_for("main");
        assert!(authorizer.authorize("main", &rewritten).is_some());
        // The re-check grants through the canonical identity of the same
        // authorized regular file.
        assert!(matches!(
            decide_asset_request(
                "GET",
                Some(&link.to_string_lossy()),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Serve { .. }
        ));
        // The rewritten spelling itself still serves through the plain
        // key, the direct hit Electron's path.resolve produces.
        assert!(matches!(
            decide_asset_request(
                "GET",
                Some(&rewritten),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Serve { .. }
        ));
        // A symlink grant records no canonical alias: authorizing the
        // link (even through the rewritten spelling) still does not make
        // the target path servable.
        let rewritten_link = format!("{}\\\\{}", dir.display(), "Link.png");
        let (authorizer, tokens) = state();
        let token = tokens.token_for("main");
        assert!(authorizer.authorize("main", &rewritten_link).is_some());
        assert_eq!(
            decide_asset_request(
                "GET",
                Some(&image),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Reject(403),
            "a symlink grant must not vouch for its target's canonical path"
        );
        // And a link to a never-authorized file stays rejected.
        let stranger = fixture_image(&dir, "Stranger.png");
        let stranger_link = dir.join("StrangerLink.png");
        std::os::windows::fs::symlink_file(Path::new(&stranger), &stranger_link).unwrap();
        assert_eq!(
            decide_asset_request(
                "GET",
                Some(&stranger_link.to_string_lossy()),
                Some(&token),
                "main",
                &authorizer,
                &tokens
            ),
            AssetDecision::Reject(403)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn app_file_routes_map_to_embedded_keys_and_mimes() {
        let (key, mime) = decide_app_file_or_root("/").unwrap();
        assert_eq!((key, mime), ("index.html", "text/html; charset=utf-8"));
        assert_eq!(
            decide_app_file_or_root("/index.html").unwrap(),
            ("index.html", "text/html; charset=utf-8")
        );
        assert_eq!(
            decide_app_file_or_root("/app.js").unwrap(),
            ("app.js", "text/javascript; charset=utf-8")
        );
        assert_eq!(
            decide_app_file_or_root("/app.css").unwrap(),
            ("app.css", "text/css; charset=utf-8")
        );
        assert!(decide_app_file_or_root("/missing.js").is_none());
    }

    #[test]
    fn query_parsing_is_lossless_and_never_panics() {
        assert_eq!(
            parse_query("path=C%3A%5Cdir%5Ca%20b.png&token=abc"),
            vec![
                ("path".to_string(), "C:\\dir\\a b.png".to_string()),
                ("token".to_string(), "abc".to_string()),
            ]
        );
        assert_eq!(
            parse_query("path"),
            vec![("path".to_string(), String::new())]
        );
        assert_eq!(
            parse_query("path=%zz"),
            vec![("path".to_string(), "%zz".to_string())]
        );
        assert!(parse_query("").is_empty());
    }

    #[test]
    fn tokens_are_stable_per_label_and_64_hex_characters() {
        let tokens = CapabilityTokens::new();
        let first = tokens.token_for("main");
        assert_eq!(tokens.token_for("main"), first, "stable per label");
        assert_ne!(tokens.token_for("other"), first, "distinct per label");
        assert_eq!(first.len(), 64, "two UUID v4 hex forms");
    }

    #[test]
    fn relink_prompts_with_remaining_candidates_and_authorizes_on_consent() {
        let dir = unique_dir("relink-consent");
        let a = fixture_image(&dir, "A.png");
        let b = fixture_image(&dir, "B.png");
        let (authorizer, _) = state();
        // `a` is already authorized; only `b` remains a candidate.
        authorizer.authorize("main", &a).unwrap();
        let dialogs = FixtureDialogs::new(true);
        let project = recovery_value(&recovery_source(&[&a, &b]));
        let result = relink_recovery_assets("main", Some(&project), &authorizer, &dialogs);
        assert_eq!(result.authorized, vec![b.clone()]);
        assert_eq!(dialogs.prompts(), vec![vec![b.clone()]]);
        assert!(authorizer.is_path_authorized("main", &b));
    }

    #[test]
    fn relink_declining_the_dialog_authorizes_nothing() {
        let dir = unique_dir("relink-decline");
        let image = fixture_image(&dir, "Img.png");
        let (authorizer, _) = state();
        let dialogs = FixtureDialogs::new(false);
        let project = recovery_value(&recovery_source(&[&image]));
        let result = relink_recovery_assets("main", Some(&project), &authorizer, &dialogs);
        assert_eq!(result.authorized, Vec::<String>::new());
        assert_eq!(dialogs.prompts().len(), 1, "the dialog was still shown");
        assert!(!authorizer.is_path_authorized("main", &image));
    }

    #[test]
    fn relink_fails_closed_and_skips_the_dialog_without_candidates() {
        let (authorizer, _) = state();
        let dialogs = FixtureDialogs::new(true);
        // No recovery document.
        assert_eq!(
            relink_recovery_assets("main", None, &authorizer, &dialogs).authorized,
            Vec::<String>::new()
        );
        // A composition the engine rejects contributes no candidates.
        let broken = serde_json::json!({ "source": "image(\"broken\").at(0).for(5)" });
        assert_eq!(
            relink_recovery_assets("main", Some(&broken), &authorizer, &dialogs).authorized,
            Vec::<String>::new()
        );
        // A valid composition with no image clips.
        let no_images = serde_json::json!({
            "source": "composition(\"Clean\").duration(5)\nscene(\"bg\").at(0).for(5).look(\"orbit\")"
        });
        assert_eq!(
            relink_recovery_assets("main", Some(&no_images), &authorizer, &dialogs).authorized,
            Vec::<String>::new()
        );
        assert!(dialogs.prompts().is_empty());
    }

    #[test]
    fn relink_candidates_still_pass_the_authorization_gates() {
        let dir = unique_dir("relink-gates");
        let (authorizer, _) = state();
        let dialogs = FixtureDialogs::new(true);
        // A missing file and a non-image extension both fail `authorize`
        // even though the user consented.
        let missing = dir.join("Missing.png").to_string_lossy().replace('/', "\\");
        let note = dir.join("Note.txt");
        fs::write(&note, b"not an image").unwrap();
        let text = note.to_string_lossy().replace('/', "\\");
        let project = recovery_value(&recovery_source(&[&missing, &text]));
        let result = relink_recovery_assets("main", Some(&project), &authorizer, &dialogs);
        assert_eq!(result.authorized, Vec::<String>::new());
        let prompts = dialogs.prompts();
        assert_eq!(prompts.len(), 1);
        let mut listed = prompts[0].clone();
        listed.sort();
        let mut expected = vec![missing.clone(), text.clone()];
        expected.sort();
        assert_eq!(listed, expected);
        assert!(!authorizer.is_path_authorized("main", &missing));
        assert!(!authorizer.is_path_authorized("main", &text));
    }

    #[test]
    fn relink_scans_lastvalid_too() {
        let dir = unique_dir("relink-lastvalid");
        let image = fixture_image(&dir, "Img.png");
        let (authorizer, _) = state();
        let dialogs = FixtureDialogs::new(true);
        let project = serde_json::json!({
            "source": "composition(\"Broken\").duration(5)\nimage(\"x\").at(0).for(5).wobble(1)",
            "lastValid": recovery_source(&[&image])
        });
        let result = relink_recovery_assets("main", Some(&project), &authorizer, &dialogs);
        assert_eq!(result.authorized, vec![image.clone()]);
        assert!(authorizer.is_path_authorized("main", &image));
    }

    #[test]
    fn asset_kinds_map_extensions_to_mime_and_authorization_limits() {
        assert_eq!(
            extension_asset("png"),
            Some((AssetKind::Image, "image/png"))
        );
        assert_eq!(
            extension_asset("MP4"),
            Some((AssetKind::Video, "video/mp4"))
        );
        assert_eq!(
            extension_asset("webm"),
            Some((AssetKind::Video, "video/webm"))
        );
        assert_eq!(
            extension_asset("mp3"),
            Some((AssetKind::Audio, "audio/mpeg"))
        );
        assert_eq!(extension_asset("txt"), None);
        assert_eq!(media_limit(AssetKind::Image), MAX_ASSET_BYTES);
        assert_eq!(media_limit(AssetKind::Video), crate::media::MAX_MEDIA_BYTES);
        assert_eq!(media_limit(AssetKind::Audio), crate::media::MAX_MEDIA_BYTES);
    }

    #[test]
    fn media_files_authorize_under_the_media_ceiling() {
        let dir = unique_dir("media-authorize");
        let clip = dir.join("Clip.MP4");
        fs::write(&clip, b"fake container").unwrap();
        let (authorizer, tokens) = state();
        let path = clip.to_string_lossy().replace('/', "\\");
        assert!(authorizer.authorize("main", &path).is_some());
        let decision = decide_asset_request(
            "GET",
            Some(&path),
            Some(&tokens.token_for("main")),
            "main",
            &authorizer,
            &tokens,
        );
        match decision {
            AssetDecision::Serve { content_type, .. } => {
                assert_eq!(content_type, "video/mp4");
            }
            other => panic!("expected Serve, got {other:?}"),
        }
        // The token gate still runs before any range handling.
        assert_eq!(
            decide_asset_request("GET", Some(&path), None, "main", &authorizer, &tokens),
            AssetDecision::Reject(403)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn range_slices_cover_closed_open_suffix_and_unsatisfiable_forms() {
        let slice = |range: Option<&str>| resolve_file_slice(1000, range);
        assert_eq!(
            slice(None),
            Ok(FileSlice { start: 0, length: 1000, total: 1000, partial: false })
        );
        assert_eq!(
            slice(Some("bytes=0-1023")),
            Ok(FileSlice { start: 0, length: 1000, total: 1000, partial: true })
        );
        assert_eq!(
            slice(Some("bytes=900-")),
            Ok(FileSlice { start: 900, length: 100, total: 1000, partial: true })
        );
        assert_eq!(
            slice(Some("bytes=-100")),
            Ok(FileSlice { start: 900, length: 100, total: 1000, partial: true })
        );
        assert_eq!(
            slice(Some("bytes=0-0")),
            Ok(FileSlice { start: 0, length: 1, total: 1000, partial: true })
        );
        assert_eq!(
            slice(Some("bytes=0-999999999999")),
            Ok(FileSlice { start: 0, length: 1000, total: 1000, partial: true })
        );
        for bad in [
            "bytes=200-100",
            "bytes=1000-",
            "bytes=-0",
            "bytes=abc",
            "bytes=0-1, 5-6",
            "items=0-1",
        ] {
            assert_eq!(slice(Some(bad)), Err(416), "{bad}");
        }
        assert_eq!(
            resolve_file_slice(0, None),
            Ok(FileSlice { start: 0, length: 0, total: 0, partial: false })
        );
        assert_eq!(resolve_file_slice(0, Some("bytes=0-")), Err(416));
    }

    #[test]
    fn relink_covers_video_and_audio_clips() {
        let dir = unique_dir("relink-media");
        let image = fixture_image(&dir, "Still.png");
        let video = dir.join("Clip.mp4");
        fs::write(&video, b"fake container").unwrap();
        let video = video.to_string_lossy().replace('/', "\\");
        let audio = dir.join("Score.mp3");
        fs::write(&audio, b"fake audio").unwrap();
        let audio = audio.to_string_lossy().replace('/', "\\");
        let not_media = dir.join("Notes.txt");
        fs::write(&not_media, b"text").unwrap();
        let not_media = not_media.to_string_lossy().replace('/', "\\");
        let (authorizer, _) = state();
        let dialogs = FixtureDialogs::new(true);
        let source = format!(
            "composition(\"Media\").duration(10)\n\
             image(\"still\").at(0).for(2).source({})\n\
             video(\"v\").at(2).for(5).source({})\n\
             audio(\"a\").at(2).for(5).source({})\n\
             video(\"bad\").at(7).for(3).source({})",
            serde_json::to_string(&image).unwrap(),
            serde_json::to_string(&video).unwrap(),
            serde_json::to_string(&audio).unwrap(),
            serde_json::to_string(&not_media).unwrap(),
        );
        let project = recovery_value(&source);
        let result = relink_recovery_assets("main", Some(&project), &authorizer, &dialogs);
        let mut authorized = result.authorized.clone();
        authorized.sort();
        let mut expected = vec![image.clone(), video.clone(), audio.clone()];
        expected.sort();
        assert_eq!(
            authorized, expected,
            "image, video and audio clips all relink; the .txt source fails the extension gate"
        );
        assert!(authorizer.is_path_authorized("main", &video));
        assert!(authorizer.is_path_authorized("main", &audio));
        assert!(!authorizer.is_path_authorized("main", &not_media));
    }
}
