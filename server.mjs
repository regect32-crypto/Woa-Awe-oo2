import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceApiHandler } from "./source-api.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const dist = resolve(root, "dist");
const sourceApi = createSourceApiHandler();
const port = Number(process.env.PORT ?? 4173);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".geojson", "application/geo+json; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

async function serveStatic(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed.");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Invalid URL.");
    return;
  }

  if (pathname.includes("\0")) {
    response.writeHead(400);
    response.end("Invalid path.");
    return;
  }
  const filePath = pathname === "/" ? resolve(dist, "index.html") : resolve(dist, `.${pathname}`);
  if (filePath !== dist && !filePath.startsWith(`${dist}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden.");
    return;
  }

  let content;
  let servedPath = filePath;
  try {
    content = await readFile(servedPath);
  } catch (error) {
    if (error.code !== "ENOENT" || extname(pathname)) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found." : "Unable to read the requested file.");
      return;
    }
    servedPath = resolve(dist, "index.html");
    try {
      content = await readFile(servedPath);
    } catch (fallbackError) {
      console.error("Could not read the built application:", fallbackError);
      response.writeHead(500);
      response.end("Built application is unavailable; run npm run build first.");
      return;
    }
  }

  const extension = extname(servedPath);
  response.writeHead(200, {
    "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new RangeError("PORT must be an integer between 1 and 65535.");
}

const server = createServer((request, response) => {
  sourceApi(request, response, (error) => {
    if (error) {
      console.error("Data source API request failed:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Data source API request failed.");
      return;
    }
    serveStatic(request, response).catch((serveError) => {
      console.error("Static request failed:", serveError);
      if (!response.headersSent) response.writeHead(500);
      response.end("Unable to serve the requested resource.");
    });
  }).catch((error) => {
    console.error("Request handler failed:", error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Request failed.");
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Orbital Atlas listening on http://0.0.0.0:${port}`);
});
