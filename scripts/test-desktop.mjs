import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  executable = require("electron");
const flags =
  process.platform === "linux" && !process.env.DISPLAY
    ? ["--no-sandbox", "--ozone-platform=headless", "--disable-gpu"]
    : [];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
let completed = false;
const child = spawn(executable, [...flags, "tests/desktop-smoke.cjs"], {
  stdio: ["inherit", "pipe", "inherit"],
  env: environment,
  windowsHide: true,
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (String(chunk).includes("DESKTOP COMPLETE:")) completed = true;
});
const timer = setTimeout(() => {
  console.error("Desktop smoke test timed out.");
  child.kill();
  process.exitCode = 1;
}, 120000);
child.once("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearTimeout(timer);
  process.exitCode = code === 0 && completed ? 0 : 1;
  if (code === 0 && !completed)
    console.error("Desktop exited before completing its checks.");
});
