//! Asset authorization and serving for the Tauri backend (Stage 4).
//!
//! Ported from the Electron main process (`desktop/main.cjs`:
//! `installProtocol`, `authorizeAsset`, `scanForAssets`, `recovery:relink`)
//! with the same security model:
//!
//! - Assets are served on the app's own origin (the overridden `tauri`
//!   protocol handler in `lib.rs`), so `<canvas>` pixel reads never taint —
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
//! One documented delta from Electron: project scanning cannot compile the
//! composition (the engine stays in JavaScript), so candidate paths come
//! from a conservative scan of the `source("…")` string literals in
//! `source` and `lastValid` instead of the compiled image clips. The same
//! extension/size/absolute-path gates Electron applies to every candidate
//! still bound the result; non-image extensions can never be authorized.

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

/// `std::fs::canonicalize` returns `\\?\C:\…` extended-length paths on
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
        if metadata.len() > MAX_ASSET_BYTES {
            return None;
        }
        let extension = extension_of(path)?;
        if !ALLOWED_EXTENSIONS
            .iter()
            .any(|(allowed, _)| *allowed == extension)
        {
            return None;
        }
        self.with_set(label, |set| set.insert(normalized.clone()))?;
        Some(normalized)
    }

    pub fn is_authorized(&self, label: &str, normalized: &str) -> bool {
        self.with_set(label, |set| set.contains(normalized))
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
    }
}

/// Capability tokens binding asset URLs to their owning webview, the
/// Electron `windowTokenMap` (token → webview label).
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

/// Decodes a `source("…")`-literal candidate list from a composition
/// source. The engine compiles sources in JavaScript; the backend scan is
/// the conservative approximation documented in the module header.
pub fn scan_source_literals(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut literals = Vec::new();
    let mut cursor = 0;
    while let Some(index) = text[cursor..].find("source(") {
        let after = cursor + index + "source(".len();
        cursor = after;
        // Skip whitespace up to the opening quote.
        let rest = &bytes[after.min(bytes.len())..];
        let mut offset = 0;
        while offset < rest.len() && (rest[offset] as char).is_whitespace() {
            offset += 1;
        }
        let Some(&quote) = rest.get(offset) else {
            break;
        };
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        let mut value = String::new();
        let mut scan = offset + 1;
        let mut closed = false;
        while scan < rest.len() {
            let byte = rest[scan];
            if byte == b'\\' {
                // A JS escape: consume the escape sequence and unescape the
                // common forms; unknown escapes keep the raw character.
                scan += 1;
                let Some(&escaped) = rest.get(scan) else {
                    break;
                };
                scan += 1;
                match escaped {
                    b'n' => value.push('\n'),
                    b'r' => value.push('\r'),
                    b't' => value.push('\t'),
                    b'b' => value.push('\u{8}'),
                    b'f' => value.push('\u{c}'),
                    b'v' => value.push('\u{b}'),
                    b'0' => value.push('\0'),
                    b'x' => {
                        let hex = rest.get(scan..scan + 2).and_then(|hex| {
                            u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
                        });
                        match hex {
                            Some(code) => {
                                value.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                                scan += 2;
                            }
                            None => value.push('\\'),
                        }
                    }
                    b'u' => {
                        if rest.get(scan).copied() == Some(b'{') {
                            let end = rest[scan..]
                                .iter()
                                .position(|&b| b == b'}')
                                .map(|end| scan + end);
                            let code = end.and_then(|end| {
                                u32::from_str_radix(
                                    std::str::from_utf8(&rest[scan + 1..end]).ok()?,
                                    16,
                                )
                                .ok()
                            });
                            match (code, end) {
                                (Some(code), Some(end)) => {
                                    value.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                                    scan = end + 1;
                                }
                                _ => value.push('\\'),
                            }
                        } else {
                            let hex = rest.get(scan..scan + 4).and_then(|hex| {
                                u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
                            });
                            match hex {
                                Some(code) => {
                                    value.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                                    scan += 4;
                                }
                                None => value.push('\\'),
                            }
                        }
                    }
                    other => value.push(other as char),
                }
                continue;
            }
            if byte == quote {
                closed = true;
                scan += 1;
                break;
            }
            // Multi-byte UTF-8: copy the whole character.
            let remainder = std::str::from_utf8(&rest[scan..]).unwrap_or("");
            if let Some(character) = remainder.chars().next() {
                value.push(character);
                scan += character.len_utf8();
            } else {
                scan += 1;
            }
        }
        cursor += scan;
        if closed {
            literals.push(value);
        }
    }
    literals
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
        // at an authorized file is servable, while any other miss —
        // including a non-symlink path whose realpath is itself — is 403).
        || real_path(Path::new(raw))
            .map(|real| real != normalized && authorizer.is_authorized(label, &real))
            .unwrap_or(false);
    if !authorized {
        return AssetDecision::Reject(403);
    }
    let extension = extension_of(Path::new(raw)).unwrap_or_default();
    let content_type = ALLOWED_EXTENSIONS
        .iter()
        .find(|(allowed, _)| *allowed == extension)
        .map(|(_, mime)| *mime)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-assets-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 1×1 red PNG (89 50 4E 47 …), same shape as the Electron desktop
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

    #[test]
    fn source_literals_are_extracted_with_common_js_escapes() {
        let source = r#"composition("Demo")
image("Hero").at(0).for(5).source("C:\\Users\\Me\\pics\\Hero.png")
image("Spaces").at(5).for(2).source('C:\\my dir\\a b.png')
image("Escaped").at(7).for(1).source("C:\\tab\\name\"quoted.png")
image("Unicode").at(8).for(1).source("C:\\Users\\\u{00e9}\\caf\u{00e9}.png")
image("Unfinished").at(9).for(1).source("C:\\broken.png
"#;
        let literals = scan_source_literals(source);
        assert_eq!(
            literals,
            vec![
                r"C:\Users\Me\pics\Hero.png".to_string(),
                r"C:\my dir\a b.png".to_string(),
                "C:\\tab\\name\"quoted.png".to_string(),
                "C:\\Users\\é\\café.png".to_string(),
            ],
            "the unterminated literal contributes nothing"
        );
        // Nothing to scan.
        assert!(scan_source_literals("").is_empty());
        assert!(scan_source_literals("composition(\"x\").duration(5)").is_empty());
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
}
