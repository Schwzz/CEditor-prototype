import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, writeFile as touch, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecentProjects, MAX_RECENTS, normalizeRecentPath } from "../desktop/recents.mjs";

const dir = async () => mkdtemp(join(tmpdir(), "framecode-recents-"));

test("recents round trip: added projects persist across instances (restart)", async () => {
  const directory = await dir();
  try {
    const first = new RecentProjects(directory);
    await touch(join(directory, "A.framecode.json"), "{}\n");
    await touch(join(directory, "B.framecode.json"), "{}\n");
    await first.add(join(directory, "A.framecode.json"), "A.framecode.json");
    await first.add(join(directory, "B.framecode.json"), "B.framecode.json");
    // A brand-new instance over the same data directory is a restart.
    const second = new RecentProjects(directory);
    const list = await second.list();
    assert.deepEqual(
      list.map((entry) => entry.name),
      ["B.framecode.json", "A.framecode.json"],
    );
    assert.equal(list[0].missing, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recents dedupe by path matches platform path semantics, most recent first", async () => {
  const directory = await dir();
  try {
    const recents = new RecentProjects(directory);
    const lower = join(directory, "Project.framecode.json");
    await recents.add(lower, "Project.framecode.json");
    await recents.add(join(directory, "Other.framecode.json"), "Other.framecode.json");
    if (process.platform === "win32") {
      // Windows paths are case-insensitive and accept mixed separators;
      // re-adding the same project in another casing must refresh the
      // existing entry, not add a duplicate.
      const upper = join(directory, "PROJECT.framecode.json");
      await recents.add(upper, "Project.framecode.json");
      const list = await recents.list();
      assert.equal(list.length, 2);
      assert.equal(list[0].path, upper);
      assert.equal(
        list.some((entry) => entry.path === lower),
        false,
        "no duplicate entry for the same project",
      );
    } else {
      // POSIX paths are case-sensitive: a different casing is genuinely a
      // different file and must be tracked as its own entry, while an
      // exact re-add still dedupes to the top.
      const mixed = join(directory, "project.framecode.json");
      await recents.add(mixed, "Project.framecode.json");
      await recents.add(lower, "Project.framecode.json");
      const list = await recents.list();
      assert.equal(list.length, 3);
      assert.deepEqual(
        list.map((entry) => entry.path),
        [lower, mixed, join(directory, "Other.framecode.json")],
        "exact re-add dedupes; distinct casings stay distinct",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recents list is capped and keeps the newest entries", async () => {
  const directory = await dir();
  try {
    const recents = new RecentProjects(directory);
    for (let index = 0; index < MAX_RECENTS + 4; index++)
      await recents.add(
        join(directory, `P${index}.framecode.json`),
        `P${index}.framecode.json`,
      );
    const list = await recents.list();
    assert.equal(list.length, MAX_RECENTS);
    assert.equal(list[0].name, `P${MAX_RECENTS + 3}.framecode.json`);
    assert.equal(list.at(-1).name, "P4.framecode.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing a recents entry never deletes the project file", async () => {
  const directory = await dir();
  try {
    const projectPath = join(directory, "Kept.framecode.json");
    await touch(projectPath, "{}\n");
    const recents = new RecentProjects(directory);
    await recents.add(projectPath, "Kept.framecode.json");
    const remaining = await recents.remove(projectPath);
    assert.deepEqual(remaining, []);
    assert.deepEqual(await recents.list(), []);
    // The actual project survives; only the entry is gone.
    await stat(projectPath);
    assert.equal((await readFile(projectPath, "utf8")), "{}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing, moved, or inaccessible projects are annotated, not dropped", async () => {
  const directory = await dir();
  try {
    const present = join(directory, "Present.framecode.json");
    await touch(present, "{}\n");
    const vanished = join(directory, "Vanished.framecode.json");
    await touch(vanished, "{}\n");
    const recents = new RecentProjects(directory);
    await recents.add(present, "Present.framecode.json");
    await recents.add(vanished, "Vanished.framecode.json");
    await rm(vanished);
    const list = await recents.list();
    assert.deepEqual(
      list.map((entry) => [entry.name, entry.missing]),
      [
        ["Vanished.framecode.json", true],
        ["Present.framecode.json", false],
      ],
      "missing entries stay listed so Home can offer a recovery path",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt or foreign recents file is treated as empty, not fatal", async () => {
  const directory = await dir();
  try {
    await writeFile(join(directory, "recents.json"), "{not json");
    const recents = new RecentProjects(directory);
    assert.deepEqual(await recents.list(), []);
    // The next add rebuilds a valid file from scratch.
    await recents.add(join(directory, "A.framecode.json"), "A.framecode.json");
    const list = await new RecentProjects(directory).list();
    assert.equal(list.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid recents entries and paths are rejected or filtered", async () => {
  const directory = await dir();
  try {
    await writeFile(
      join(directory, "recents.json"),
      JSON.stringify({
        format: "framecode-recents",
        version: 1,
        projects: [
          { path: "relative/path.framecode.json", name: "relative" },
          { path: 42, name: "numeric" },
          null,
          { path: join(directory, "Good.framecode.json"), name: "Good" },
        ],
      }),
    );
    const recents = new RecentProjects(directory);
    const list = await recents.list();
    assert.deepEqual(
      list.map((entry) => entry.name),
      ["Good"],
    );
    await assert.rejects(async () => recents.add("not-absolute", "x"));
    await assert.rejects(async () =>
      recents.add(join(directory, "X.json"), "  "),
    );
    await assert.rejects(async () => recents.remove(""));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeRecentPath is null-safe and case-folds on Windows", () => {
  assert.equal(normalizeRecentPath(""), null);
  assert.equal(normalizeRecentPath(null), null);
  assert.equal(normalizeRecentPath("   "), null);
  if (process.platform === "win32") {
    assert.equal(
      normalizeRecentPath("C:\\A\\B.json"),
      normalizeRecentPath("c:/a/b.json"),
    );
  }
});
