import { open, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_PROJECT_BYTES,
  encodeProject,
  decodeProject,
} from "../src/core/project-format.mjs";

// The pure validation lives in src/core/project-format.mjs so the Tauri
// bridge can reuse it verbatim in the renderer; this module keeps only the
// filesystem-aware parts of the Electron implementation. Both exports stay
// re-exported so the Electron tests and imports are unchanged.
export { MAX_PROJECT_BYTES, encodeProject, decodeProject } from "../src/core/project-format.mjs";
async function boundedRead(path) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_PROJECT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PROJECT_BYTES)
      throw new Error("Project is too large (maximum 1 MiB).");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await file.close();
  }
}
export async function atomicWrite(path, text) {
  const temporary = path + "." + randomUUID() + ".tmp";
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function readProject(path) {
  return decodeProject(await boundedRead(path));
}
export async function writeProject(path, project) {
  await atomicWrite(path, encodeProject(project));
}

export class RecoveryFile {
  #queue = Promise.resolve();
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "recovery.json");
  }
  #enqueue(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }
  write(project) {
    const valid = decodeProject(encodeProject(project));
    return this.#enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      await atomicWrite(
        this.path,
        JSON.stringify({
          format: "framecode-recovery",
          version: 1,
          project: valid,
          updatedAt: Date.now(),
        }),
      );
    });
  }
  clear() {
    return this.#enqueue(async () => {
      try {
        await unlink(this.path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
  }
  async read() {
    await this.#queue;
    let text;
    try {
      text = await boundedRead(this.path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const data = JSON.parse(text);
    if (data?.format !== "framecode-recovery" || data.version !== 1)
      throw new Error("Unsupported recovery file.");
    return decodeProject(encodeProject(data.project));
  }
}
