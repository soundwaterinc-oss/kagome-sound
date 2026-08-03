import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.resolve(root, process.argv[2] || ".");
const defaultDocument = process.env.SITES_DEFAULT_DOCUMENT || "index.html";
const project = JSON.parse(await fs.readFile(path.join(root, ".openai/hosting.json"), "utf8"));
const excluded = new Set([".git", ".openai", "dist", "node_modules", "site-static"]);
const mimeTypes = {
  ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".wav": "audio/wav", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2"
};

async function collect(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(absolute, files);
    else files.push(absolute);
  }
  return files;
}

const assets = {};
for (const absolute of await collect(sourceDir)) {
  const relative = path.relative(sourceDir, absolute).split(path.sep).join("/");
  const extension = path.extname(relative).toLowerCase();
  assets["/" + relative] = {
    body: (await fs.readFile(absolute)).toString("base64"),
    type: mimeTypes[extension] || "application/octet-stream"
  };
}

const worker = [
  "const ASSETS = " + JSON.stringify(assets) + ";",
  "const DEFAULT_DOCUMENT = " + JSON.stringify("/" + defaultDocument.replace(/^\/+/, "")) + ";",
  "function decode(value) {",
  "  const binary = atob(value);",
  "  const bytes = new Uint8Array(binary.length);",
  "  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);",
  "  return bytes;",
  "}",
  "async function handleRequest(request) {",
  "  const url = new URL(request.url);",
  "  let pathname;",
  "  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }",
  "  if (pathname === '/') pathname = DEFAULT_DOCUMENT;",
  "  const asset = ASSETS[pathname];",
  "  if (!asset) return new Response('Not Found', { status: 404 });",
  "  return new Response(decode(asset.body), {",
  "    headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=300' }",
  "  });",
  "}",
  "export default { fetch: handleRequest };",
  "export const fetch = handleRequest;",
  ""
].join("\n");

await fs.mkdir(path.join(root, "dist/server"), { recursive: true });
await fs.mkdir(path.join(root, "dist/.openai"), { recursive: true });
await fs.writeFile(path.join(root, "dist/server/index.js"), worker);
await fs.writeFile(path.join(root, "dist/.openai/hosting.json"), JSON.stringify(project, null, 2));
console.log("Packed " + Object.keys(assets).length + " static assets for Sites.");

