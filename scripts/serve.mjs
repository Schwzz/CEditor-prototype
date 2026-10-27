import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../dist/", import.meta.url);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/engine.mjs", ["engine.mjs", "text/javascript; charset=utf-8"]],
]);
const port = Number(process.env.PORT || 5173);

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = files.get(path);
  if (!file || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const bytes = await readFile(fileURLToPath(new URL(file[0], root)));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(500).end("Could not load the prototype.");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Framecode: http://localhost:${port}`),
);
