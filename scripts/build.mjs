import { build } from "esbuild";
import { mkdir, copyFile, rm } from "node:fs/promises";
const output = new URL("../build/renderer/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/renderer/app.mjs"],
  bundle: true,
  outfile: "build/renderer/app.js",
  format: "iife",
  platform: "browser",
  target: "chrome140",
  minify: false,
  legalComments: "eof",
  logLevel: "info",
});
await copyFile(
  new URL("../src/renderer/index.html", import.meta.url),
  new URL("index.html", output),
);
