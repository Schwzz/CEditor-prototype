//! User preferences persisted in the Tauri app's data directory.
//!
//! Ported from `desktop/settings.mjs` with the same schema, defaults,
//! validation, reset behavior, and file format (`framecode-settings`,
//! version 1, pretty-printed with a trailing newline). A missing, corrupt,
//! or foreign file never blocks the app: the affected keys fall back to
//! their defaults and nothing is written until a preference is changed.
//!
//! The schema below must stay in sync with `desktop/settings.mjs` — it is
//! the single source of truth for both shells until the Electron path is
//! retired.

use crate::project_files::{atomic_write, PersistenceError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const SETTINGS_FORMAT: &str = "framecode-settings";
pub const SETTINGS_VERSION: u8 = 1;

/// The validated preference set, in schema order (which is also the order
/// the Electron implementation serializes it in).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "timelineSnap")]
    pub timeline_snap: bool,
    #[serde(rename = "recoveryCopies")]
    pub recovery_copies: bool,
    #[serde(rename = "maxRecents")]
    pub max_recents: i64,
}

impl Settings {
    pub fn defaults() -> Settings {
        Settings {
            timeline_snap: true,
            recovery_copies: true,
            max_recents: 10,
        }
    }

    /// Normalizes raw persisted data: unknown keys are dropped and
    /// individually invalid entries fall back to their own defaults.
    pub fn normalize(raw: &Value) -> Settings {
        let object = raw.as_object();
        let bool_at = |key: &str, default: bool| -> bool {
            object
                .and_then(|o| o.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let max_recents = object
            .and_then(|o| o.get("maxRecents"))
            // Number.isInteger semantics: integral floats are accepted.
            .and_then(Value::as_f64)
            .filter(|n| n.fract() == 0.0 && (1.0..=20.0).contains(n))
            .map(|n| n as i64)
            .unwrap_or(10);
        Settings {
            timeline_snap: bool_at("timelineSnap", true),
            recovery_copies: bool_at("recoveryCopies", true),
            max_recents,
        }
    }

    fn set_field(&mut self, key: &str, value: &Value) -> std::result::Result<(), PersistenceError> {
        match key {
            "timelineSnap" => {
                self.timeline_snap = valid_bool(key, value)?;
            }
            "recoveryCopies" => {
                self.recovery_copies = valid_bool(key, value)?;
            }
            "maxRecents" => {
                self.max_recents = valid_integer(key, value, 1, 20)?;
            }
            _ => return error(format!("Unknown setting: {key}")),
        }
        Ok(())
    }
}

fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(PersistenceError(message.into()))
}

fn valid_bool(key: &str, value: &Value) -> Result<bool> {
    value
        .as_bool()
        .ok_or_else(|| PersistenceError(format!("Invalid value for setting {key}.")))
}

fn valid_integer(key: &str, value: &Value, min: i64, max: i64) -> Result<i64> {
    // Mirrors the JavaScript check: `Number.isInteger(value)` also accepts
    // an integral float representation such as `1.0`, and rejects strings,
    // nulls, and fractional values alike.
    let number = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64)
        .ok_or_else(|| PersistenceError(format!("Invalid value for setting {key}.")))?;
    Ok(number as i64)
}

#[derive(Serialize)]
struct SettingsFile<'a> {
    format: &'static str,
    version: u8,
    settings: &'a Settings,
}

/// The settings store for one data directory. Operations are serialized by
/// the shared persistence mutex owned by the Tauri state (the Electron
/// implementation serializes with a promise queue instead).
pub struct AppSettings {
    file: PathBuf,
    current: Settings,
}

impl AppSettings {
    pub fn new(directory: &Path) -> AppSettings {
        AppSettings {
            file: directory.join("settings.json"),
            current: Settings::defaults(),
        }
    }

    /// Read-only load: a fresh install or unreadable data is reported with
    /// defaults and nothing is written until the user changes a preference.
    pub fn load(&mut self) -> Result<Settings> {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(text) => text,
            Err(io) if io.kind() == std::io::ErrorKind::NotFound => return Ok(self.all()),
            Err(io) => return Err(PersistenceError(io.to_string())),
        };
        self.current = match serde_json::from_str::<Value>(&text) {
            // A corrupt settings file must never block the app: defaults.
            Err(_) => Settings::defaults(),
            Ok(value) => {
                let ok = value.get("format").and_then(Value::as_str) == Some(SETTINGS_FORMAT)
                    && value.get("version").and_then(Value::as_u64) == Some(1);
                if ok {
                    Settings::normalize(value.get("settings").unwrap_or(&Value::Null))
                } else {
                    Settings::defaults()
                }
            }
        };
        Ok(self.all())
    }

    /// Read-only access to one known preference; kept for API parity with
    /// the Electron store (its tests exercise it).
    #[allow(dead_code)]
    pub fn get(&self, key: &str) -> Result<Value> {
        match key {
            "timelineSnap" => Ok(Value::Bool(self.current.timeline_snap)),
            "recoveryCopies" => Ok(Value::Bool(self.current.recovery_copies)),
            "maxRecents" => Ok(Value::from(self.current.max_recents)),
            _ => error(format!("Unknown setting: {key}")),
        }
    }

    pub fn all(&self) -> Settings {
        self.current.clone()
    }

    /// Validates, applies, and atomically persists one preference.
    pub fn set(&mut self, key: &str, value: &Value) -> Result<Settings> {
        let mut next = self.current.clone();
        next.set_field(key, value)?;
        self.write(&next)?;
        self.current = next;
        Ok(self.all())
    }

    /// Restores defaults on disk.
    pub fn reset(&mut self) -> Result<Settings> {
        let defaults = Settings::defaults();
        self.write(&defaults)?;
        self.current = defaults;
        Ok(self.all())
    }

    fn write(&self, settings: &Settings) -> Result<()> {
        atomic_write(
            &self.file,
            &(serde_json::to_string_pretty(&SettingsFile {
                format: SETTINGS_FORMAT,
                version: SETTINGS_VERSION,
                settings,
            })
            .expect("settings serialization")
                + "\n"),
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
        let dir = std::env::temp_dir().join(format!("framecode-settings-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn defaults() -> Settings {
        Settings::defaults()
    }

    #[test]
    fn missing_settings_file_resolves_to_defaults_without_writing() {
        let dir = unique_dir("missing");
        let mut settings = AppSettings::new(&dir);
        assert_eq!(settings.load().unwrap(), defaults());
        assert!(
            !dir.join("settings.json").exists(),
            "no preferences file is created until the user changes something"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settings_round_trip_across_instances() {
        let dir = unique_dir("roundtrip");
        {
            let mut first = AppSettings::new(&dir);
            first.load().unwrap();
            let after = first.set("timelineSnap", &json!(false)).unwrap();
            assert!(!after.timeline_snap);
        }
        let mut second = AppSettings::new(&dir);
        let loaded = second.load().unwrap();
        assert!(!loaded.timeline_snap);
        assert!(loaded.recovery_copies);
        assert_eq!(loaded.max_recents, 10);
        let file: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            file,
            json!({
                "format": "framecode-settings",
                "version": 1,
                "settings": {
                    "timelineSnap": false,
                    "recoveryCopies": true,
                    "maxRecents": 10,
                },
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_values_are_rejected_and_never_persist() {
        let dir = unique_dir("invalid");
        let mut settings = AppSettings::new(&dir);
        settings.load().unwrap();
        for (key, value) in [
            ("timelineSnap", json!("yes")),
            ("timelineSnap", json!(1)),
            ("timelineSnap", json!(null)),
            ("recoveryCopies", json!(0)),
            ("maxRecents", json!(0)),
            ("maxRecents", json!(2.5)),
            ("maxRecents", json!(21)),
            ("maxRecents", json!("3")),
        ] {
            assert!(
                settings.set(key, &value).is_err(),
                "{key} = {value} must be rejected"
            );
        }
        assert!(settings.set("unknownKey", &json!(true)).is_err());
        assert_eq!(
            AppSettings::new(&dir).load().unwrap(),
            defaults(),
            "nothing was persisted"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_or_foreign_settings_files_are_treated_as_defaults() {
        let dir = unique_dir("corrupt");
        fs::write(dir.join("settings.json"), "{not json").unwrap();
        let mut corrupt = AppSettings::new(&dir);
        assert_eq!(corrupt.load().unwrap(), defaults());
        corrupt.set("maxRecents", &json!(3)).unwrap();
        let repaired = AppSettings::new(&dir).load().unwrap();
        assert_eq!(repaired.max_recents, 3);

        fs::write(
            dir.join("settings.json"),
            json!({"format": "something-else", "version": 9, "settings": {}}).to_string(),
        )
        .unwrap();
        assert_eq!(AppSettings::new(&dir).load().unwrap(), defaults());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_entries_fall_back_to_their_own_defaults() {
        let dir = unique_dir("entries");
        fs::write(
            dir.join("settings.json"),
            json!({
                "format": "framecode-settings",
                "version": 1,
                "settings": {
                    "timelineSnap": false,
                    "recoveryCopies": "off",
                    "maxRecents": 999,
                    "injectedKey": "ignored",
                },
            })
            .to_string(),
        )
        .unwrap();
        let loaded = AppSettings::new(&dir).load().unwrap();
        assert!(!loaded.timeline_snap, "valid entry is kept");
        assert!(loaded.recovery_copies, "bad entry falls back");
        assert_eq!(loaded.max_recents, 10, "out-of-range entry falls back");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reset_restores_defaults_on_disk() {
        let dir = unique_dir("reset");
        let mut settings = AppSettings::new(&dir);
        settings.load().unwrap();
        settings.set("timelineSnap", &json!(false)).unwrap();
        settings.set("maxRecents", &json!(20)).unwrap();
        assert_eq!(settings.reset().unwrap(), defaults());
        assert_eq!(AppSettings::new(&dir).load().unwrap(), defaults());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn get_reports_known_keys_and_rejects_unknown_ones() {
        let mut settings = AppSettings::new(&unique_dir("get"));
        settings.load().unwrap();
        assert_eq!(settings.get("timelineSnap").unwrap(), json!(true));
        assert_eq!(settings.get("maxRecents").unwrap(), json!(10));
        assert!(settings.get("nope").is_err());
    }
}
