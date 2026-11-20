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

/** A source line that declares a media clip (line-anchored, like the DSL). */
const MEDIA_LINE = /^(video|audio)\(/;

/**
 * Whether a composition text declares a media clip. Mirrors the engine's
 * line parser: only the first token of a trimmed, non-comment line counts,
 * so commented-out media and method-like text inside strings do not.
 */
function declaresMedia(source) {
  return source
    .split("\n")
    .some((raw) => {
      const line = raw.trim();
      return line.length > 0 && !line.startsWith("//") && MEDIA_LINE.test(line);
    });
}

export const MEDIA_WRITE_GUARD_MESSAGE =
  "This project uses media, but its last valid composition does not. Saving is blocked: an older Framecode version could open it and silently drop the media. Fix the composition error, then save again.";

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function canonicalizeProject(value, { guardMedia }) {
  if (
    typeof value?.version === "number" &&
    Number.isFinite(value.version) &&
    value.version > 1
  )
    throw new Error(
      "This project was created by a newer version of Framecode. Update Framecode to open it.",
    );
  if (
    value?.format !== "framecode-project" ||
    value.version !== 1 ||
    typeof value.source !== "string" ||
    typeof value.lastValid !== "string" ||
    value.source.length > 50000
  )
    throw new Error("Unsupported or invalid Framecode project.");
  // The compatibility invariant (§3.0): a saved media project must carry
  // media in lastValid too, so an older build fails at open instead of
  // adopting it and later rewriting the file without the media.
  if (guardMedia && declaresMedia(value.source) && !declaresMedia(value.lastValid))
    throw new Error(MEDIA_WRITE_GUARD_MESSAGE);
  compile(value.lastValid);
  return JSON.stringify(
    {
      format: value.format,
      version: 1,
      source: value.source,
      lastValid: value.lastValid,
    },
    null,
    2,
  ) + "\n";
}

export function encodeProject(value) {
  const text = canonicalizeProject(value, { guardMedia: true });
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
  // Opening is allowed even when a media draft's fallback is media-free:
  // the user can see the error, repair it, and save (which enforces the
  // write guard above).
  return JSON.parse(canonicalizeProject(value, { guardMedia: false }));
}
