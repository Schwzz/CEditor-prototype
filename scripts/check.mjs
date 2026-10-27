import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(mjs|cjs)$/.test(path)) {
      execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
      count++;
    }
  }
}
for (const directory of ["src", "desktop", "scripts", "tests"])
  await check(directory);
console.log(`Syntax checked ${count} JavaScript modules.`);
