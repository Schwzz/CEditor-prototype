//! Crash-recovery persistence for the Tauri backend.
//!
//! Ported from the `RecoveryFile` part of `desktop/project-files.mjs` with
//! the same JSON format (`framecode-recovery`, version 1, compact encoding,
//! `updatedAt` milliseconds), validation, and missing-file behavior:
//!
//! - `write` validates the project before persisting; invalid drafts are
//!   rejected without touching the file.
//! - `clear` removes the file and tolerates an already-missing file.
//! - `read` returns `None` when no recovery file exists, rejects foreign
//!   formats, and returns the validated canonical project.
//!
//! Ordering: the Electron implementation serializes writes and clears with
//! a promise queue, so an enqueued save can never resurrect a recovery
//! file that a later clear removed. In the Tauri backend every recovery
//! operation goes through the shared persistence mutex (see
//! `state::Persistence`), giving the same ordering guarantee: operations
//! are applied in dispatch order and a write that completes before a clear
//! cannot survive it.

use crate::project_files::{
    bounded_read, validate_project, PersistenceError, ProjectData, Result, MAX_PROJECT_BYTES,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const RECOVERY_FORMAT: &str = "framecode-recovery";
const RECOVERY_VERSION: u8 = 1;

#[derive(Serialize)]
struct RecoveryFile<'a> {
    format: &'static str,
    version: u8,
    project: &'a Value,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn project_json(project: &ProjectData) -> Value {
    json!({
        "format": "framecode-project",
        "version": 1,
        "source": project.source,
        "lastValid": project.last_valid,
    })
}

pub struct RecoveryStore {
    path: PathBuf,
}

impl RecoveryStore {
    pub fn new(directory: &Path) -> RecoveryStore {
        RecoveryStore {
            path: directory.join("recovery.json"),
        }
    }

    /// Validates the project and atomically persists the recovery record.
    /// Compilation/semantic validation of `lastValid` stays in the
    /// JavaScript bridge, exactly as in the Electron main process; this
    /// performs the structural part.
    pub fn write(&mut self, project: &Value) -> Result<()> {
        let data = validate_project(project)?;
        if let Some(parent) = self.path.parent() {
            // Mirrors the Electron `mkdir(directory, { recursive: true })`.
            std::fs::create_dir_all(parent).map_err(|io| PersistenceError(io.to_string()))?;
        }
        let record = RecoveryFile {
            format: RECOVERY_FORMAT,
            version: RECOVERY_VERSION,
            project: &project_json(&data),
            updated_at: now_millis(),
        };
        let text = serde_json::to_string(&record).expect("recovery serialization");
        debug_assert!(text.len() <= MAX_PROJECT_BYTES + 1024);
        crate::project_files::atomic_write(&self.path, &text)
    }

    /// Removes the recovery file; an already-missing file is not an error.
    pub fn clear(&mut self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(io) if io.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(io) => Err(PersistenceError(io.to_string())),
        }
    }

    /// `None` when no recovery copy exists; errors for unreadable, corrupt,
    /// foreign, or structurally invalid files, matching the Electron read.
    pub fn read(&self) -> Result<Option<Value>> {
        if self.is_missing() {
            return Ok(None);
        }
        let text = bounded_read(&self.path)?;
        let data: Value = serde_json::from_str(&text)
            .map_err(|_| PersistenceError("This is not a valid JSON project.".into()))?;
        if data.get("format").and_then(Value::as_str) != Some(RECOVERY_FORMAT)
            || data.get("version").and_then(Value::as_u64) != Some(1)
        {
            return Err(PersistenceError("Unsupported recovery file.".into()));
        }
        let project = data
            .get("project")
            .ok_or_else(|| PersistenceError("Unsupported recovery file.".into()))?;
        Ok(Some(project_json(&validate_project(project)?)))
    }

    fn is_missing(&self) -> bool {
        matches!(
            std::fs::metadata(&self.path),
            Err(io) if io.kind() == std::io::ErrorKind::NotFound
        )
    }
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
        let dir = std::env::temp_dir().join(format!("framecode-recovery-{name}-{nanos}"));
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

    #[test]
    fn write_read_round_trip_persists_the_electron_format() {
        let dir = unique_dir("roundtrip");
        let mut recovery = RecoveryStore::new(&dir);
        recovery.write(&project()).unwrap();
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("recovery.json")).unwrap()).unwrap();
        assert_eq!(stored["format"], "framecode-recovery");
        assert_eq!(stored["version"], 1);
        assert!(stored["updatedAt"].is_i64());
        assert_eq!(stored["project"], project());
        // Compact encoding, as JSON.stringify without indentation writes.
        let text = fs::read_to_string(dir.join("recovery.json")).unwrap();
        assert!(!text.contains("\n  "));
        assert_eq!(recovery.read().unwrap().as_ref(), Some(&project()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clearing_removes_the_file_and_tolerates_a_missing_one() {
        let dir = unique_dir("clear");
        let mut recovery = RecoveryStore::new(&dir);
        assert!(recovery.clear().is_ok(), "clearing without a file is fine");
        recovery.write(&project()).unwrap();
        assert!(dir.join("recovery.json").exists());
        recovery.clear().unwrap();
        assert!(!dir.join("recovery.json").exists());
        assert_eq!(recovery.read().unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ordered_writes_cannot_resurrect_a_cleared_recovery_file() {
        // The Electron implementation queues write and clear on one promise
        // chain; here the shared persistence mutex serializes the same two
        // operations in dispatch order. A write that completes before the
        // clear is then wiped by it, never the other way around.
        let dir = unique_dir("stale");
        let mut recovery = RecoveryStore::new(&dir);
        recovery.write(&project()).unwrap(); // first dispatched
        recovery.clear().unwrap(); // second dispatched
        assert_eq!(recovery.read().unwrap(), None);
        // A fresh write afterwards legitimately recreates the file.
        recovery.write(&project()).unwrap();
        assert!(recovery.read().unwrap().is_some());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_foreign_and_invalid_recovery_files_are_rejected() {
        let dir = unique_dir("invalid");
        let path = dir.join("recovery.json");
        fs::write(&path, "{not json").unwrap();
        let error = RecoveryStore::new(&dir).read().err().unwrap();
        assert_eq!(error.to_string(), "This is not a valid JSON project.");

        fs::write(
            &path,
            json!({"format": "something-else", "version": 9, "project": {}}).to_string(),
        )
        .unwrap();
        let error = RecoveryStore::new(&dir).read().err().unwrap();
        assert_eq!(error.to_string(), "Unsupported recovery file.");

        fs::write(
            &path,
            json!({
                "format": "framecode-recovery",
                "version": 1,
                "project": {"format": "framecode-project", "version": 2},
                "updatedAt": 1,
            })
            .to_string(),
        )
        .unwrap();
        assert!(RecoveryStore::new(&dir).read().is_err());

        // Invalid projects are rejected at write time too.
        let mut recovery = RecoveryStore::new(&dir);
        let mut bad = project();
        bad["source"] = json!(null);
        assert!(recovery.write(&bad).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
