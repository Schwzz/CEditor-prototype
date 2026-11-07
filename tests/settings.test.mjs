import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppSettings,
  SETTINGS_SCHEMA,
  normalizeSettings,
} from "../desktop/settings.mjs";

const dir = async () => mkdtemp(join(tmpdir(), "framecode-settings-"));
const defaults = () => normalizeSettings(null);

test("missing settings file resolves to defaults without writing anything", async () => {
  const directory = await dir();
  try {
    const settings = new AppSettings(directory);
    assert.deepEqual(await settings.load(), defaults());
    // No preferences file is created until the user changes something.
    await assert.rejects(async () => readFile(join(directory, "settings.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings round trip: changes persist across instances (restart)", async () => {
  const directory = await dir();
  try {
    const first = new AppSettings(directory);
    await first.load();
    const after = await first.set("timelineSnap", false);
    assert.equal(after.timelineSnap, false);
    // A brand-new instance over the same data directory is a restart.
    const second = new AppSettings(directory);
    const loaded = await second.load();
    assert.equal(loaded.timelineSnap, false);
    assert.equal(loaded.recoveryCopies, true);
    assert.equal(loaded.maxRecents, 10);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "settings.json"), "utf8")),
      {
        format: "framecode-settings",
        version: 1,
        settings: loaded,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid values are rejected and never persist", async () => {
  const directory = await dir();
  try {
    const settings = new AppSettings(directory);
    await settings.load();
    for (const [key, value] of [
      ["timelineSnap", "yes"],
      ["timelineSnap", 1],
      ["timelineSnap", null],
      ["recoveryCopies", 0],
      ["maxRecents", 0],
      ["maxRecents", 2.5],
      ["maxRecents", 21],
      ["maxRecents", "3"],
    ])
      await assert.rejects(async () => settings.set(key, value));
    await assert.rejects(async () => settings.set("unknownKey", true));
    // Nothing was persisted, so a fresh instance still sees the defaults.
    assert.deepEqual(await new AppSettings(directory).load(), defaults());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt or foreign settings file is treated as defaults, not fatal", async () => {
  const directory = await dir();
  try {
    await writeFile(join(directory, "settings.json"), "{not json");
    const corrupt = new AppSettings(directory);
    assert.deepEqual(await corrupt.load(), defaults());
    // The next change replaces the corrupt file with a valid one.
    await corrupt.set("maxRecents", 3);
    const repaired = await new AppSettings(directory).load();
    assert.equal(repaired.maxRecents, 3);

    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ format: "something-else", version: 9, settings: {} }),
    );
    assert.deepEqual(await new AppSettings(directory).load(), defaults());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("individual broken entries fall back to their own defaults", async () => {
  const directory = await dir();
  try {
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        format: "framecode-settings",
        version: 1,
        settings: {
          timelineSnap: false,
          recoveryCopies: "off",
          maxRecents: 999,
          injectedKey: "ignored",
        },
      }),
    );
    const settings = new AppSettings(directory);
    const loaded = await settings.load();
    assert.equal(loaded.timelineSnap, false, "valid entry is kept");
    assert.equal(loaded.recoveryCopies, true, "bad entry falls back");
    assert.equal(loaded.maxRecents, 10, "out-of-range entry falls back");
    assert.equal("injectedKey" in loaded, false, "unknown keys are dropped");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reset restores defaults on disk", async () => {
  const directory = await dir();
  try {
    const settings = new AppSettings(directory);
    await settings.load();
    await settings.set("timelineSnap", false);
    await settings.set("maxRecents", 20);
    assert.deepEqual(await settings.reset(), defaults());
    assert.deepEqual(await new AppSettings(directory).load(), defaults());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the schema exposes one documented entry per supported setting", () => {
  assert.deepEqual(
    SETTINGS_SCHEMA.map((entry) => entry.key),
    ["timelineSnap", "recoveryCopies", "maxRecents"],
  );
  assert.deepEqual(normalizeSettings({}), defaults());
  assert.deepEqual(normalizeSettings(null), defaults());
  assert.deepEqual(normalizeSettings("garbage"), defaults());
  assert.equal(normalizeSettings({ timelineSnap: true }).timelineSnap, true);
});
