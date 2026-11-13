//! Framecode project-file storage for the Tauri backend.
//!
//! Ported from `desktop/project-files.mjs` (Electron main process) with the
//! same on-disk format, size limit, and structural validation:
//!
//! - Format `framecode-project`, version 1, canonical fields
//!   `format`/`version`/`source`/`lastValid` (anything else is dropped, as in
//!   the Electron canonical encoder).
//! - 1 MiB file limit on both read and write.
//! - `source` is capped at 50000 UTF-16 code units, exactly matching the
//!   JavaScript `value.source.length` check.
//! - Writes are atomic: text is written to a unique temporary sibling file,
//!   synced, then renamed over the destination; failures never leave
//!   temporary files behind and never damage an existing project.
//!
//! Composition compilation/semantic validation stays in the JavaScript core
//! engine (`src/core/engine.mjs`), as it must not be ported to Rust. The
//! Electron encoder compiles `lastValid` as part of validation; in the Tauri
//! shell that check is performed by the JavaScript bridge (see
//! `src/renderer/tauri-bridge.mjs`) before the validated project reaches
//! these commands, which re-validate everything structural.

use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

pub const MAX_PROJECT_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_UNITS: usize = 50000;
pub const PROJECT_FORMAT: &str = "framecode-project";
const PROJECT_VERSION: u8 = 1;

/// Persistence failures carry user-displayable messages that mirror the
/// wording of the Electron implementation, which the renderer toasts.
#[derive(Debug)]
pub struct PersistenceError(pub String);

impl fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PersistenceError {}

pub type Result<T> = std::result::Result<T, PersistenceError>;

fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(PersistenceError(message.into()))
}

/// The validated canonical project content.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectData {
    pub source: String,
    pub last_valid: String,
}

#[derive(Serialize)]
struct CanonicalProject<'a> {
    format: &'static str,
    version: u8,
    source: &'a str,
    #[serde(rename = "lastValid")]
    last_valid: &'a str,
}

/// Mirrors the JavaScript `data.version !== 1` check: JSON `1` and `1.0`
/// are the same JS number, so both are accepted, while strings, booleans,
/// and other version numbers are rejected.
pub fn version_is_one(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(n)) if n.as_f64() == Some(1.0))
}

/// Structural validation mirroring the Electron encoder. Compilation of
/// `lastValid` is NOT performed here; the JavaScript engine owns that.
pub fn validate_project(value: &Value) -> Result<ProjectData> {
    let object = match value {
        Value::Object(map) => map,
        _ => return error("Unsupported or invalid Framecode project."),
    };
    if object.get("format").and_then(Value::as_str) != Some(PROJECT_FORMAT) {
        return error("Unsupported or invalid Framecode project.");
    }
    // JavaScript compares `value.version !== 1`, so the JSON number 1 (or
    // 1.0) passes while strings, booleans and other versions fail.
    if !version_is_one(object.get("version")) {
        return error("Unsupported or invalid Framecode project.");
    }
    let source = object
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| PersistenceError("Unsupported or invalid Framecode project.".into()))?;
    let last_valid = object
        .get("lastValid")
        .and_then(Value::as_str)
        .ok_or_else(|| PersistenceError("Unsupported or invalid Framecode project.".into()))?;
    // The Electron check is `value.source.length > 50000`, counting UTF-16
    // code units, so non-BMP characters count as two.
    if source.encode_utf16().count() > MAX_SOURCE_UNITS {
        return error("Unsupported or invalid Framecode project.");
    }
    Ok(ProjectData {
        source: source.to_string(),
        last_valid: last_valid.to_string(),
    })
}

/// Canonical, pretty-printed project text: exactly the four fields, 2-space
/// indent, trailing newline — byte-compatible with the Electron encoder for
/// the string-only canonical fields.
pub fn canonical_text(project: &ProjectData) -> String {
    let canonical = CanonicalProject {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        source: &project.source,
        last_valid: &project.last_valid,
    };
    // The encoder itself cannot exceed the limit with a valid source, but
    // keep the same guard as the Electron implementation.
    let text = serde_json::to_string_pretty(&canonical).expect("canonical project serialization");
    text + "\n"
}

/// Validates and returns the canonical JSON object (the analog of
/// `JSON.parse(encodeProject(value))` in the Electron decoder).
pub fn encode_project(value: &Value) -> Result<Value> {
    let data = validate_project(value)?;
    let text = canonical_text(&data);
    if text.len() > MAX_PROJECT_BYTES {
        return error("Project is too large (maximum 1 MiB).");
    }
    serde_json::from_str(&text)
        .map_err(|_| PersistenceError("Unsupported or invalid Framecode project.".into()))
}

/// Decodes project text with the 1 MiB limit applied before parsing,
/// mirroring `decodeProject` in the Electron implementation.
pub fn decode_project_text(text: &str) -> Result<Value> {
    if text.len() > MAX_PROJECT_BYTES {
        return error("Project is too large (maximum 1 MiB).");
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|_| PersistenceError("This is not a valid JSON project.".into()))?;
    encode_project(&value)
}

/// Reads at most `MAX_PROJECT_BYTES + 1` bytes and requires valid UTF-8,
/// mirroring the Electron bounded read.
pub fn bounded_read(path: &Path) -> Result<String> {
    let file =
        File::open(path).map_err(|_| PersistenceError("The file could not be opened.".into()))?;
    let mut bounded = file.take((MAX_PROJECT_BYTES + 1) as u64);
    let mut buffer = Vec::new();
    bounded
        .read_to_end(&mut buffer)
        .map_err(|_| PersistenceError("The file could not be read.".into()))?;
    if buffer.len() > MAX_PROJECT_BYTES {
        return error("Project is too large (maximum 1 MiB).");
    }
    String::from_utf8(buffer).map_err(|_| PersistenceError("The file is not valid UTF-8.".into()))
}

/// Atomic replacement write: unique temporary file, exclusive creation,
/// fsync, rename. On any failure the temporary file is removed and the
/// destination is untouched.
pub fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project"),
        uuid::Uuid::new_v4().simple()
    ));
    let write = || -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| PersistenceError("The file could not be written.".into()))?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| PersistenceError("The file could not be written.".into()))?;
        drop(file);
        std::fs::rename(&temporary, path)
            .map_err(|_| PersistenceError("The file could not be replaced.".into()))
    };
    match write() {
        Ok(()) => Ok(()),
        Err(failure) => {
            // Never leave the temporary file behind, whatever went wrong.
            let _ = std::fs::remove_file(&temporary);
            Err(failure)
        }
    }
}

pub fn read_project(path: &Path) -> Result<Value> {
    decode_project_text(&bounded_read(path)?)
}

pub fn write_project(path: &Path, project: &Value) -> Result<()> {
    atomic_write(path, &canonical_text(&validate_project(project)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-test-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn project() -> Value {
        json!({
            "format": "framecode-project",
            "version": 1,
            "source": "composition(\"Demo\").duration(5)",
            "lastValid": "composition(\"Demo\").duration(5)",
        })
    }

    #[test]
    fn valid_projects_round_trip_through_canonical_form() {
        let mut value = project();
        value["source"] = json!("composition(\"夜 🚀\").duration(5)\ninvalid(\"draft\")");
        let text = canonical_text(&validate_project(&value).unwrap());
        let decoded = decode_project_text(&text).unwrap();
        assert_eq!(decoded, value);
    }

    #[test]
    fn unsupported_oversized_and_invalid_project_data_is_rejected() {
        let rejected = [
            json!("null text"),
            json!({}),
            json!(null),
            json!([project()]),
            {
                let mut v = project();
                v["version"] = json!(2);
                v
            },
            {
                let mut v = project();
                v["lastValid"] = json!(42);
                v
            },
            {
                let mut v = project();
                v["source"] = json!("x".repeat(50001));
                v
            },
        ];
        for value in &rejected {
            assert!(encode_project(value).is_err(), "must reject: {value}");
        }
        // Exactly at the source limit is accepted.
        let mut at_limit = project();
        at_limit["source"] = json!("x".repeat(50000));
        assert!(encode_project(&at_limit).is_ok());
        // Oversized text is rejected before parsing.
        let oversized = " ".repeat(MAX_PROJECT_BYTES + 1);
        assert!(decode_project_text(&oversized).is_err());
        // Exactly 1 MiB of text parses (then fails validation as garbage).
        let full = " ".repeat(MAX_PROJECT_BYTES);
        assert!(decode_project_text(&full).is_err());
    }

    #[test]
    fn canonical_text_matches_the_electron_format() {
        let data = validate_project(&project()).unwrap();
        let text = canonical_text(&data);
        assert_eq!(
            text,
            "{\n  \"format\": \"framecode-project\",\n  \"version\": 1,\n  \
             \"source\": \"composition(\\\"Demo\\\").duration(5)\",\n  \
             \"lastValid\": \"composition(\\\"Demo\\\").duration(5)\"\n}\n"
        );
        assert!(text.len() <= MAX_PROJECT_BYTES);
    }

    #[test]
    fn atomic_saving_replaces_files_without_leaving_temporaries() {
        let dir = unique_dir("atomic");
        let path = dir.join("Example.framecode.json");
        let result = (|| -> Result<()> {
            write_project(&path, &project())?;
            let mut next = project();
            next["source"] = json!("composition(\"Demo\").duration(6)");
            next["lastValid"] = next["source"].clone();
            write_project(&path, &next)?;
            assert_eq!(read_project(&path)?, next);
            let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
            assert_eq!(leftovers.len(), 1, "no temporary files remain");
            Ok(())
        })();
        cleanup(&dir);
        result.unwrap();
    }

    #[test]
    fn failed_writes_and_corrupt_files_leave_the_original_alone() {
        let dir = unique_dir("failed-write");
        let path = dir.join("Safe.framecode.json");
        let result = (|| -> Result<()> {
            write_project(&path, &project())?;
            let mut invalid = project();
            invalid["version"] = json!(2);
            assert!(write_project(&path, &invalid).is_err());
            assert_eq!(read_project(&path)?, project());
            let bad = dir.join("bad.json");
            fs::write(&bad, "not JSON").unwrap();
            assert!(read_project(&bad).is_err());
            // Missing parent directory must fail the write cleanly.
            assert!(write_project(&dir.join("missing").join("a.json"), &project()).is_err());
            let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
            assert_eq!(leftovers.len(), 2, "only the two seed files remain");
            Ok(())
        })();
        cleanup(&dir);
        result.unwrap();
    }

    #[test]
    fn oversized_files_on_disk_are_rejected_by_the_bounded_read() {
        let dir = unique_dir("bounded");
        let path = dir.join("big.framecode.json");
        let result = (|| -> Result<()> {
            fs::write(&path, " ".repeat(MAX_PROJECT_BYTES + 1)).unwrap();
            assert!(bounded_read(&path).is_err());
            assert!(read_project(&path).is_err());
            fs::write(&path, vec![0xff, 0xfe]).unwrap();
            assert!(bounded_read(&path).is_err(), "invalid UTF-8 is rejected");
            Ok(())
        })();
        cleanup(&dir);
        result.unwrap();
    }
}
