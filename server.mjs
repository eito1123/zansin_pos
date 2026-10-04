import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cloudHandler from './api/cloud.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/cloud') return await cloudHandler(req, res);
    const allowed = ['/', '/index.html', '/app.js', '/db.js', '/logic.js', '/cloud.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/icon.svg'];
    if (!allowed.includes(pathname)) { res.writeHead(404); res.end('Not found'); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !types[path.extname(file)]) { res.writeHead(404); res.end(); return; }
    const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control':'no-cache' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '0.0.0.0', () => console.log('POS preview: http://localhost:4173'));
