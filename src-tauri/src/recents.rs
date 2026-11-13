//! Recent-projects list persisted in the Tauri app's data directory.
//!
//! Ported from `desktop/recents.mjs` with the same file format
//! (`framecode-recents`, version 1), cap semantics, deduplication,
//! missing-file annotation, and Windows case-insensitive path handling.
//! Entries are recorded only after a project has actually been opened or
//! written to disk, so failed operations never leave a misleading entry
//! behind; removing an entry never deletes the project file itself.

use crate::project_files::{atomic_write, PersistenceError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// The default cap matches the Electron implementation; `new` and `add` are
// consumed by the store's tests today and by the Stage 3+ open/save wiring
// (an opened or saved project earns its recents entry), so they are part of
// the migrated API even where the Stage 2 commands do not call them yet.
#[allow(dead_code)]
pub const MAX_RECENTS: usize = 10;
const RECENTS_FORMAT: &str = "framecode-recents";
const RECENTS_VERSION: u8 = 1;

/// One recents entry, serialized in the Electron key order. `openedAt` is
/// optional because the Electron validator does not require it on stored
/// entries; it is always written by `add`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "openedAt", skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<i64>,
}

/// A listed entry annotated with whether its project file still exists, so
/// Home can mark missing, moved, or inaccessible projects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentListEntry {
    #[serde(flatten)]
    pub entry: RecentEntry,
    pub missing: bool,
}

fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(PersistenceError(message.into()))
}

/// Mirrors the JavaScript `path.isAbsolute` on Windows, where a leading
/// separator alone counts as absolute (Rust's `Path::is_absolute` does not).
fn js_is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        path.starts_with('/') || path.starts_with('\\') || Path::new(path).is_absolute()
    } else {
        Path::new(path).is_absolute()
    }
}

/// Mirrors `normalizeRecentPath`: resolve relative to the working directory
/// and case-fold on Windows, returning `None` for blank paths. Only used as
/// a comparison key; entries keep the original path.
pub fn normalize_recent_path(file_path: &str) -> Option<String> {
    if file_path.trim().is_empty() {
        return None;
    }
    let candidate = Path::new(file_path);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(current) => current.join(candidate),
            Err(_) => return None,
        }
    };
    let text = resolved.to_string_lossy().into_owned();
    let folded = if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    };
    Some(folded)
}

fn valid_entry(entry: &Value) -> Option<RecentEntry> {
    let path = entry.get("path")?.as_str()?;
    let name = entry.get("name")?.as_str()?;
    // Mirrors the JavaScript checks: absolute path under 4096 UTF-16 code
    // units, non-blank display name of at most 255 code units.
    if !js_is_absolute(path) || path.encode_utf16().count() >= 4096 {
        return None;
    }
    if name.encode_utf16().count() > 255 || name.trim().is_empty() {
        return None;
    }
    let opened_at = entry.get("openedAt").and_then(Value::as_i64);
    Some(RecentEntry {
        path: path.to_string(),
        name: name.to_string(),
        opened_at,
    })
}

#[derive(Serialize)]
struct RecentsFile<'a> {
    format: &'static str,
    version: u8,
    projects: &'a [RecentEntry],
}

pub struct RecentProjects {
    file: PathBuf,
    cap: usize,
}

impl RecentProjects {
    #[allow(dead_code)]
    pub fn new(directory: &Path) -> RecentProjects {
        RecentProjects {
            file: directory.join("recents.json"),
            cap: MAX_RECENTS,
        }
    }

    pub fn new_with_cap(directory: &Path, cap: i64) -> Result<RecentProjects> {
        if cap < 1 {
            return error("Invalid recents cap.");
        }
        Ok(RecentProjects {
            file: directory.join("recents.json"),
            cap: cap as usize,
        })
    }

    #[allow(dead_code)]
    pub fn cap(&self) -> usize {
        self.cap
    }

    fn read_raw(&self) -> Vec<RecentEntry> {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(text) => text,
            Err(io) if io.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            // An unreadable recents file must never block the app.
            Err(_) => return Vec::new(),
        };
        let data: Value = match serde_json::from_str(&text) {
            // A corrupt recents file must never block the app: start over.
            Err(_) => return Vec::new(),
            Ok(data) => data,
        };
        if data.get("format").and_then(Value::as_str) != Some(RECENTS_FORMAT)
            || data.get("version").and_then(Value::as_u64) != Some(1)
        {
            return Vec::new();
        }
        let projects = match data.get("projects").and_then(Value::as_array) {
            Some(projects) => projects,
            None => return Vec::new(),
        };
        projects
            .iter()
            .filter_map(valid_entry)
            .take(self.cap)
            .collect()
    }

    fn write(&self, entries: &[RecentEntry]) -> Result<()> {
        atomic_write(
            &self.file,
            &(serde_json::to_string_pretty(&RecentsFile {
                format: RECENTS_FORMAT,
                version: RECENTS_VERSION,
                projects: entries,
            })
            .expect("recents serialization")
                + "\n"),
        )
    }

    /// Entries most recent first, each annotated with whether its project
    /// file still exists. Missing entries stay listed so Home can offer a
    /// recovery path.
    pub fn list(&self) -> Result<Vec<RecentListEntry>> {
        Ok(self
            .read_raw()
            .into_iter()
            .map(|entry| {
                let missing = std::fs::metadata(&entry.path)
                    .map(|meta| !meta.is_file())
                    .unwrap_or(true);
                RecentListEntry { entry, missing }
            })
            .collect())
    }

    /// Adds (or refreshes) one entry, deduplicated by normalized path and
    /// capped to the newest `cap` entries. The Stage 2 commands do not call
    /// it yet (opening/saving projects needs dialogs, Stage 3+), but the
    /// store owns the behavior and its tests exercise it.
    #[allow(dead_code)]
    pub fn add(&mut self, file_path: &str, name: &str) -> Result<Vec<RecentEntry>> {
        let normalized = normalize_recent_path(file_path)
            .ok_or_else(|| PersistenceError("Invalid recent project.".into()))?;
        if !js_is_absolute(file_path) || name.trim().is_empty() {
            return error("Invalid recent project.");
        }
        let entries: Vec<RecentEntry> = self
            .read_raw()
            .into_iter()
            .filter(|entry| normalize_recent_path(&entry.path).as_deref() != Some(&normalized))
            .collect();
        let mut kept = entries;
        kept.insert(
            0,
            RecentEntry {
                path: file_path.to_string(),
                name: name.to_string(),
                opened_at: Some(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                ),
            },
        );
        kept.truncate(self.cap);
        self.write(&kept)?;
        Ok(kept)
    }

    /// Applies a new recents cap from Settings immediately: the stored list
    /// is re-read under the new cap and rewritten when that drops entries.
    pub fn set_cap(&mut self, cap: i64) -> Result<Vec<RecentEntry>> {
        if cap < 1 {
            return error("Invalid recents cap.");
        }
        self.cap = cap as usize;
        let kept: Vec<RecentEntry> = self.read_raw().into_iter().take(self.cap).collect();
        self.write(&kept)?;
        Ok(kept)
    }

    /// Removes only the recents entry; the project file itself is untouched.
    pub fn remove(&mut self, file_path: &str) -> Result<Vec<RecentEntry>> {
        if !js_is_absolute(file_path) {
            return error("Invalid recent project.");
        }
        let normalized = normalize_recent_path(file_path)
            .ok_or_else(|| PersistenceError("Invalid recent project.".into()))?;
        let kept: Vec<RecentEntry> = self
            .read_raw()
            .into_iter()
            .filter(|entry| normalize_recent_path(&entry.path).as_deref() != Some(&normalized))
            .collect();
        self.write(&kept)?;
        Ok(kept)
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
        let dir = std::env::temp_dir().join(format!("framecode-recents-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Creates empty project files so the missing-file annotation reports
    /// present entries, mirroring the Electron test setup.
    fn touch(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "{}\n").unwrap();
        path
    }

    fn absolute(path: &Path) -> String {
        // Rust test paths are already absolute; make the casing/slash shape
        // deterministic for the dedupe assertions below.
        path.to_string_lossy().replace('/', "\\")
    }

    #[test]
    fn recents_round_trip_across_instances_newest_first() {
        let dir = unique_dir("roundtrip");
        let a = touch(&dir, "A.framecode.json");
        let b = touch(&dir, "B.framecode.json");
        let mut first = RecentProjects::new(&dir);
        first.add(&absolute(&a), "A.framecode.json").unwrap();
        first.add(&absolute(&b), "B.framecode.json").unwrap();
        let list = RecentProjects::new(&dir).list().unwrap();
        assert_eq!(
            list.iter()
                .map(|e| e.entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["B.framecode.json", "A.framecode.json"]
        );
        assert!(!list[0].missing);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn dedupe_matches_windows_case_insensitive_path_semantics() {
        let dir = unique_dir("dedupe");
        let lower = touch(&dir, "Project.framecode.json");
        let other = touch(&dir, "Other.framecode.json");
        let mut recents = RecentProjects::new(&dir);
        recents
            .add(&absolute(&lower), "Project.framecode.json")
            .unwrap();
        recents
            .add(&absolute(&other), "Other.framecode.json")
            .unwrap();
        // Re-adding the same project in another casing must refresh the
        // existing entry, not add a duplicate.
        let upper = dir.join("PROJECT.framecode.json");
        recents
            .add(&absolute(&upper), "Project.framecode.json")
            .unwrap();
        let list = recents.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].entry.path, absolute(&upper));
        assert!(
            !list.iter().any(|e| e.entry.path == absolute(&lower)),
            "no duplicate entry for the same project"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_is_capped_and_keeps_the_newest_entries() {
        let dir = unique_dir("cap");
        let mut recents = RecentProjects::new(&dir);
        for index in 0..MAX_RECENTS + 4 {
            let path = touch(&dir, &format!("P{index}.framecode.json"));
            recents
                .add(&absolute(&path), &format!("P{index}.framecode.json"))
                .unwrap();
        }
        let list = recents.list().unwrap();
        assert_eq!(list.len(), MAX_RECENTS);
        assert_eq!(
            list[0].entry.name,
            format!("P{}.framecode.json", MAX_RECENTS + 3)
        );
        assert_eq!(list.last().unwrap().entry.name, "P4.framecode.json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removing_an_entry_never_deletes_the_project_file() {
        let dir = unique_dir("remove");
        let project_path = touch(&dir, "Kept.framecode.json");
        let mut recents = RecentProjects::new(&dir);
        recents
            .add(&absolute(&project_path), "Kept.framecode.json")
            .unwrap();
        let remaining = recents.remove(&absolute(&project_path)).unwrap();
        assert!(remaining.is_empty());
        assert!(recents.list().unwrap().is_empty());
        // The actual project survives; only the entry is gone.
        assert_eq!(fs::read_to_string(&project_path).unwrap(), "{}\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_moved_or_inaccessible_projects_are_annotated_not_dropped() {
        let dir = unique_dir("missing");
        let present = touch(&dir, "Present.framecode.json");
        let vanished = touch(&dir, "Vanished.framecode.json");
        let mut recents = RecentProjects::new(&dir);
        recents
            .add(&absolute(&present), "Present.framecode.json")
            .unwrap();
        recents
            .add(&absolute(&vanished), "Vanished.framecode.json")
            .unwrap();
        fs::remove_file(&vanished).unwrap();
        let list = recents.list().unwrap();
        assert_eq!(
            list.iter()
                .map(|e| (e.entry.name.as_str(), e.missing))
                .collect::<Vec<_>>(),
            vec![
                ("Vanished.framecode.json", true),
                ("Present.framecode.json", false)
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_or_foreign_recents_files_are_treated_as_empty() {
        let dir = unique_dir("corrupt");
        fs::write(dir.join("recents.json"), "{not json").unwrap();
        let mut recents = RecentProjects::new(&dir);
        assert!(recents.list().unwrap().is_empty());
        let a = touch(&dir, "A.framecode.json");
        recents.add(&absolute(&a), "A.framecode.json").unwrap();
        assert_eq!(RecentProjects::new(&dir).list().unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_entries_are_filtered_and_invalid_calls_rejected() {
        let dir = unique_dir("invalid");
        fs::write(
            dir.join("recents.json"),
            json!({
                "format": "framecode-recents",
                "version": 1,
                "projects": [
                    {"path": "relative/path.framecode.json", "name": "relative"},
                    {"path": 42, "name": "numeric"},
                    null,
                    {"path": absolute(&touch(&dir, "Good.framecode.json")), "name": "Good"},
                    {"path": absolute(&dir.join("Blank.framecode.json")), "name": "   "},
                    {"path": absolute(&dir.join("Old.framecode.json")), "name": "NoStamp"},
                ],
            })
            .to_string(),
        )
        .unwrap();
        // The Electron validator ignores openedAt, so an entry without it is
        // still valid and listed.
        let list = RecentProjects::new(&dir).list().unwrap();
        assert_eq!(
            list.iter()
                .map(|e| e.entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Good", "NoStamp"]
        );
        let mut recents = RecentProjects::new(&dir);
        assert!(recents.add("not-absolute", "x").is_err());
        assert!(recents.add(&absolute(&dir.join("X.json")), "  ").is_err());
        assert!(recents.remove("").is_err());
        // Mirrors Electron recents.remove: a relative path is rejected with
        // "Invalid recent project." instead of being silently resolved
        // against the working directory, and nothing is removed.
        let error = recents
            .remove("relative/path.framecode.json")
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "Invalid recent project.");
        assert_eq!(
            recents
                .list()
                .unwrap()
                .iter()
                .map(|e| e.entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Good", "NoStamp"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalize_recent_path_is_null_safe_and_case_folds_on_windows() {
        assert!(normalize_recent_path("").is_none());
        assert!(normalize_recent_path("   ").is_none());
        if cfg!(windows) {
            assert_eq!(
                normalize_recent_path("C:\\A\\B.json"),
                normalize_recent_path("c:/a/b.json")
            );
        }
    }

    #[test]
    fn custom_cap_trims_and_limits_the_list() {
        let dir = unique_dir("custom-cap");
        let mut recents = RecentProjects::new_with_cap(&dir, 3).unwrap();
        for index in 0..5 {
            let path = touch(&dir, &format!("P{index}.framecode.json"));
            recents
                .add(&absolute(&path), &format!("P{index}.framecode.json"))
                .unwrap();
        }
        let list = recents.list().unwrap();
        assert_eq!(
            list.iter()
                .map(|e| e.entry.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "P4.framecode.json",
                "P3.framecode.json",
                "P2.framecode.json"
            ]
        );
        // Lowering the cap applies to the stored list immediately...
        recents.set_cap(2).unwrap();
        let list = RecentProjects::new(&dir).list().unwrap();
        assert_eq!(
            list.iter()
                .map(|e| e.entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["P4.framecode.json", "P3.framecode.json"]
        );
        // ...and invalid caps are rejected without touching state.
        assert!(recents.set_cap(0).is_err());
        assert!(RecentProjects::new_with_cap(&dir, 0).is_err());
        // Raising the cap starts enforcing it with the next add.
        recents.set_cap(4).unwrap();
        let fresh = touch(&dir, "N.framecode.json");
        recents.add(&absolute(&fresh), "N.framecode.json").unwrap();
        let list = recents.list().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].entry.name, "N.framecode.json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_recents_file_keeps_the_electron_format() {
        let dir = unique_dir("format");
        let a = touch(&dir, "A.framecode.json");
        let mut recents = RecentProjects::new(&dir);
        recents.add(&absolute(&a), "A.framecode.json").unwrap();
        let text = fs::read_to_string(dir.join("recents.json")).unwrap();
        let file: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(file["format"], "framecode-recents");
        assert_eq!(file["version"], 1);
        assert_eq!(file["projects"][0]["name"], "A.framecode.json");
        assert!(file["projects"][0]["openedAt"].is_i64());
        // Pretty-printed in the Electron key order: path, name, openedAt.
        let entry_start = text.find("\"path\"").unwrap();
        let name_start = text.find("\"name\"").unwrap();
        let stamp_start = text.find("\"openedAt\"").unwrap();
        assert!(entry_start < name_start && name_start < stamp_start);
        assert!(text.ends_with('\n'));
        fs::remove_dir_all(&dir).unwrap();
    }
}
