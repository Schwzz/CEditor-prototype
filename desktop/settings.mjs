import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./project-files.mjs";

// User preferences persisted in the app's data directory. Like the recents
// store, the main process owns it: preferences apply immediately and are
// written atomically after validation. A missing, corrupt, or foreign file
// never blocks the app — the affected keys fall back to their defaults.

export const SETTINGS_FORMAT = "framecode-settings";
export const SETTINGS_VERSION = 1;

// Schema of genuinely supported preferences. New editor preferences go here:
// known keys, types, bounds, and the wording shown in the Settings dialog.
export const SETTINGS_SCHEMA = [
  {
    key: "timelineSnap",
    type: "boolean",
    default: true,
    label: "Timeline snapping",
    detail: "Snap timeline edits to frames, clip edges and the playhead.",
  },
  {
    key: "recoveryCopies",
    type: "boolean",
    default: true,
    label: "Automatic recovery copies",
    detail:
      "Keep a local recovery copy of unsaved changes while you work. Turning this off pauses automatic recovery saving.",
  },
  {
    key: "maxRecents",
    type: "integer",
    bounds: { min: 1, max: 20 },
    default: 10,
    label: "Recent projects to keep",
    detail: "How many projects the Home recents list remembers (1–20).",
  },
];

const schemaByKey = new Map(SETTINGS_SCHEMA.map((entry) => [entry.key, entry]));

export function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = {};
  for (const entry of SETTINGS_SCHEMA) {
    const value = source[entry.key];
    settings[entry.key] =
      valid(entry, value) === true ? value : entry.default;
  }
  return settings;
}

function valid(entry, value) {
  if (entry.type === "boolean") return typeof value === "boolean";
  if (entry.type === "integer")
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= entry.bounds.min &&
      value <= entry.bounds.max
    );
  return false;
}

export class AppSettings {
  #queue = Promise.resolve();
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "settings.json");
    this.current = normalizeSettings(null);
  }
  #enqueue(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }
  // Read-only: a fresh install or unreadable data is reported with defaults
  // and nothing is written until the user actually changes a preference.
  async load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return this.all();
      throw error;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A corrupt settings file must never block the app: use defaults.
      return this.all();
    }
    if (data?.format !== SETTINGS_FORMAT || data.version !== SETTINGS_VERSION)
      return this.all();
    this.current = normalizeSettings(data.settings);
    return this.all();
  }
  get(key) {
    if (!schemaByKey.has(key)) throw new Error("Unknown setting: " + key);
    return this.current[key];
  }
  all() {
    return { ...this.current };
  }
  set(key, value) {
    const schema = schemaByKey.get(key);
    if (!schema) throw new Error("Unknown setting: " + key);
    if (valid(schema, value) !== true)
      throw new Error("Invalid value for setting " + key + ".");
    return this.#enqueue(async () => {
      this.current = { ...this.current, [key]: value };
      await atomicWrite(
        this.file,
        JSON.stringify(
          {
            format: SETTINGS_FORMAT,
            version: SETTINGS_VERSION,
            settings: this.current,
          },
          null,
          2,
        ) + "\n",
      );
      return this.all();
    });
  }
  reset() {
    return this.setDefaults();
  }
  setDefaults() {
    return this.#enqueue(async () => {
      this.current = normalizeSettings(null);
      await atomicWrite(
        this.file,
        JSON.stringify(
          {
            format: SETTINGS_FORMAT,
            version: SETTINGS_VERSION,
            settings: this.current,
          },
          null,
          2,
        ) + "\n",
      );
      return this.all();
    });
  }
}
