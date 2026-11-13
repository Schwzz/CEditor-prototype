// Pure Framecode project-format validation shared by both desktop shells.
//
// Extracted from desktop/project-files.mjs so the Tauri bridge (which runs
// in the renderer, where Buffer and node:fs are unavailable) can perform the
// exact same validation the Electron main process performs — including the
// compilation of `lastValid` by the JavaScript core engine, which must not
// be ported to Rust. The Rust backend re-validates everything structural
// (see src-tauri/src/project_files.rs).
//
// Canonical form: exactly the fields format ("framecode-project"), version
// (1), source and lastValid, pretty-printed with 2-space indentation and a
// trailing newline, capped at 1 MiB on both read and write.

import { compile } from "./engine.mjs";

export const MAX_PROJECT_BYTES = 1024 * 1024;

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function encodeProject(value) {
  if (
    value?.format !== "framecode-project" ||
    value.version !== 1 ||
    typeof value.source !== "string" ||
    typeof value.lastValid !== "string" ||
    value.source.length > 50000
  )
    throw new Error("Unsupported or invalid Framecode project.");
  compile(value.lastValid);
  const text =
    JSON.stringify(
      {
        format: value.format,
        version: 1,
        source: value.source,
        lastValid: value.lastValid,
      },
      null,
      2,
    ) + "\n";
  if (byteLength(text) > MAX_PROJECT_BYTES)
    throw new Error("Project is too large (maximum 1 MiB).");
  return text;
}

export function decodeProject(text) {
  if (typeof text !== "string" || byteLength(text) > MAX_PROJECT_BYTES)
    throw new Error("Project is too large (maximum 1 MiB).");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This is not a valid JSON project.");
  }
  return JSON.parse(encodeProject(value));
}
