/* A stand-in for GitHub Pages: plain files, nothing else.
 *
 * Serves the Bolt folder under /bolt/, the same shape as a project site at
 * https://<user>.github.io/bolt/, so relative asset paths are exercised the way
 * Pages will exercise them. Everything outside /bolt/ is a 404 — in particular
 * /bolt/ping, which is what makes the app choose static mode. No proxies. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 8090;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith('/bolt/')) return notFound(res);
  const rel = path.slice('/bolt/'.length) || 'index.html';
  const full = resolve(join(ROOT, normalize(rel)));
  if (!full.startsWith(ROOT)) return notFound(res);
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    notFound(res);
  }
}).listen(PORT, 'localhost', () => console.log(`static (Pages stand-in) on http://localhost:${PORT}/bolt/`));

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>404</title><h1>404</h1>');
}
