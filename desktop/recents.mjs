import { readFile, stat } from "node:fs/promises";
import path, { join } from "node:path";
import { atomicWrite } from "./project-files.mjs";

// Recent-projects list persisted in the app's data directory. The main
// process owns it: entries are recorded only after a project has actually
// been opened or written to disk, so failed operations never leave a
// misleading entry behind.
export const MAX_RECENTS = 10;

export function normalizeRecentPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  try {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

function validEntry(entry) {
  return (
    entry &&
    typeof entry.path === "string" &&
    path.isAbsolute(entry.path) &&
    entry.path.length < 4096 &&
    typeof entry.name === "string" &&
    entry.name.length <= 255 &&
    entry.name.trim() !== ""
  );
}

export class RecentProjects {
  #queue = Promise.resolve();
  constructor(directory, { now = Date.now, cap = MAX_RECENTS } = {}) {
    this.directory = directory;
    this.file = join(directory, "recents.json");
    this.now = now;
    this.cap = cap === undefined || cap === null ? MAX_RECENTS : cap;
    if (
      typeof this.cap !== "number" ||
      !Number.isInteger(this.cap) ||
      this.cap < 1
    )
      throw new Error("Invalid recents cap.");
  }
  #enqueue(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }
  async #readRaw() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A corrupt recents file must never block the app: start over.
      return [];
    }
    if (data?.format !== "framecode-recents" || data.version !== 1)
      return [];
    if (!Array.isArray(data.projects)) return [];
    return data.projects.filter(validEntry).slice(0, this.cap ?? MAX_RECENTS);
  }
  #write(entries) {
    return atomicWrite(
      this.file,
      JSON.stringify(
        { format: "framecode-recents", version: 1, projects: entries },
        null,
        2,
      ) + "\n",
    );
  }
  // Entries most recent first, each annotated with whether its project file
  // still exists so Home can mark missing, moved, or inaccessible projects.
  list() {
    return this.#enqueue(async () => {
      const entries = await this.#readRaw();
      return Promise.all(
        entries.map(async (entry) => {
          let missing = false;
          try {
            if (!(await stat(entry.path)).isFile()) missing = true;
          } catch {
            missing = true;
          }
          return { ...entry, missing };
        }),
      );
    });
  }
  add(filePath, name) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath))
      throw new Error("Invalid recent project.");
    const normalized = normalizeRecentPath(filePath);
    if (!normalized || typeof name !== "string" || !name.trim())
      throw new Error("Invalid recent project.");
    return this.#enqueue(async () => {
      const entries = (await this.#readRaw()).filter(
        (entry) => normalizeRecentPath(entry.path) !== normalized,
      );
      entries.unshift({ path: filePath, name, openedAt: this.now() });
      const kept = entries.slice(0, this.cap);
      await this.#write(kept);
      return kept;
    });
  }
  // Applies a new recents cap from Settings immediately: the stored list is
  // re-read under the new cap and rewritten back when that drops entries.
  setCap(cap) {
    if (
      typeof cap !== "number" ||
      !Number.isInteger(cap) ||
      cap < 1
    )
      throw new Error("Invalid recents cap.");
    this.cap = cap;
    return this.#enqueue(async () => {
      const kept = (await this.#readRaw()).slice(0, this.cap);
      await this.#write(kept);
      return kept;
    });
  }
  // Removes only the recents entry; the project file itself is untouched.
  remove(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath))
      throw new Error("Invalid recent project.");
    const normalized = normalizeRecentPath(filePath);
    if (!normalized) throw new Error("Invalid recent project.");
    return this.#enqueue(async () => {
      const kept = (await this.#readRaw()).filter(
        (entry) => normalizeRecentPath(entry.path) !== normalized,
      );
      await this.#write(kept);
      return kept;
    });
  }
}
