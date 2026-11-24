import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeProject,
  decodeProject,
  readProject,
  writeProject,
  RecoveryFile,
  MAX_PROJECT_BYTES,
} from "../desktop/project-files.mjs";
import { DEFAULT_SOURCE } from "../src/core/engine.mjs";
const project = () => ({
  format: "framecode-project",
  version: 1,
  source: DEFAULT_SOURCE,
  lastValid: DEFAULT_SOURCE,
});

test("project files round trip Unicode and invalid drafts with a valid fallback", () => {
  const value = project();
  value.source += '\ninvalid("夜 🚀")';
  assert.deepEqual(decodeProject(encodeProject(value)), value);
});
test("unsupported, oversized and invalid project data is rejected", () => {
  for (const data of [
    "{}",
    "null",
    JSON.stringify({ ...project(), version: 2 }),
    JSON.stringify({ ...project(), lastValid: "alert(1)" }),
    " ".repeat(MAX_PROJECT_BYTES + 1),
  ])
    assert.throws(() => decodeProject(data));
});
test("atomic saving replaces files without leaving temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framecode-"));
  try {
    const path = join(dir, "Example.framecode.json");
    await writeProject(path, project());
    const next = project();
    next.source = next.source.replace("MAKE IT MOVE.", "SAVED");
    next.lastValid = next.source;
    await writeProject(path, next);
    assert.deepEqual(await readProject(path), next);
    assert.deepEqual(await readdir(dir), ["Example.framecode.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed writes and corrupt files leave the original project alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framecode-"));
  try {
    const path = join(dir, "Safe.framecode.json");
    await writeProject(path, project());
    await assert.rejects(() =>
      writeProject(path, { ...project(), lastValid: "broken(" }),
    );
    assert.deepEqual(await readProject(path), project());
    await writeFile(join(dir, "bad.json"), "not JSON");
    await assert.rejects(() => readProject(join(dir, "bad.json")));
    await assert.rejects(() =>
      writeProject(join(dir, "missing", "a.json"), project()),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("recovery writes are ordered and clearing cannot resurrect a stale save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "framecode-"));
  try {
    const recovery = new RecoveryFile(dir);
    const a = recovery.write(project()),
      b = recovery.clear();
    await Promise.all([a, b]);
    assert.equal(await recovery.read(), null);
    await recovery.write(project());
    assert.deepEqual(await recovery.read(), project());
    assert.ok(
      (await readFile(join(dir, "recovery.json"), "utf8")).includes(
        "framecode-recovery",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new layer and transform methods persist in version1 projects", () => {
  const source =
    'composition("New").duration(5)\ntext("stable").at(0).for(5).value("HI").label("Renamed").hidden(1).locked(1).scale(1.5).rotation(90).opacity(0.5)';
  const value = { ...project(), source, lastValid: source };
  assert.deepEqual(decodeProject(encodeProject(value)), value);
});
test("image clips persist in version1 projects", () => {
  const source =
    'composition("Images").duration(10)\nimage("Photo").at(0).for(10).source("C:/path/to/image.jpg").fit("cover")';
  const value = { ...project(), source, lastValid: source };
  assert.deepEqual(decodeProject(encodeProject(value)), value);
});

const MEDIA_SOURCE =
  'composition("Media").duration(10)\nvideo("B-roll").at(0).for(5).source("C:/clips/a.mp4").sourceDuration(30)';
test("saving media with a media-free lastValid is refused with the compatibility message", () => {
  const unsafe = { ...project(), source: MEDIA_SOURCE + "\nbroken(", lastValid: DEFAULT_SOURCE };
  assert.throws(
    () => encodeProject(unsafe),
    /This project uses media, but its last valid composition does not\. Saving is blocked: an older Framecode version could open it and silently drop the media\. Fix the composition error, then save again\./,
  );
  // Opening such a file is still allowed: the decode path canonicalizes
  // without the write guard, so the user can repair and save.
  assert.deepEqual(decodeProject(JSON.stringify(unsafe)), unsafe);
  // Media in both source and lastValid is a valid save.
  const safe = { ...project(), source: MEDIA_SOURCE, lastValid: MEDIA_SOURCE };
  assert.deepEqual(decodeProject(encodeProject(safe)), safe);
});
test("audio and commented media lines follow the same write invariant", () => {
  const audio = { ...project(), source: MEDIA_SOURCE.replace("video", "audio"), lastValid: DEFAULT_SOURCE };
  assert.throws(() => encodeProject(audio), /Saving is blocked/);
  const commented = {
    ...project(),
    source: "// video(\"Ghost\").at(0).for(5).source(\"C:/ghost.mp4\")\n" + DEFAULT_SOURCE,
    lastValid: DEFAULT_SOURCE,
  };
  assert.deepEqual(decodeProject(encodeProject(commented)), commented);
});
test("a newer project version reports the update message, not the generic one", () => {
  assert.throws(
    () => decodeProject(JSON.stringify({ ...project(), version: 2 })),
    /This project was created by a newer version of Framecode\. Update Framecode to open it\./,
  );
});
test("C4 provenance names the 0.4 requirement in the import flow and preview meta", async () => {
  const { MEDIA_PROVENANCE_MESSAGE } = await import("../src/core/project-format.mjs");
  assert.equal(MEDIA_PROVENANCE_MESSAGE, "Media · requires Framecode 0.4+");
  const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /id="mediaProvenance"/);
  const app = await readFile(new URL("../src/renderer/app.mjs", import.meta.url), "utf8");
  // The preview meta and the import toast both surface the same constant.
  assert.ok(
    (app.match(/MEDIA_PROVENANCE_MESSAGE/g) || []).length >= 3,
    "the message is imported, rendered in the preview meta, and toasted on import",
  );
});
test("the document CSP permits media from the app origin", async () => {
  // Regression guard for the Stage 6 decode smoke: with `default-src 'none'`
  // and no media-src, Chromium refuses every media element load (the element
  // reports "Media load rejected by URL safety check") even though fetch() to
  // the same authorized URL succeeds.
  const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const csp =
    html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
  assert.match(csp, /(?:^|;\s*)media-src 'self'(?:;|$)/);
});
