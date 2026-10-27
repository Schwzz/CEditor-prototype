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
