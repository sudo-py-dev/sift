#!/usr/bin/env node
// Serves ./sift/ on 127.0.0.1 and saves the actions you queue in the inbox to sift/<owner>__<repo>/decisions.json.
// Usage: node serve.mjs [--port 4390] [--base <dir>]      (foreground)
//        node serve.mjs --stop [--base <dir>]              (stop a background server started by open.mjs)
// Nothing here talks to GitHub. Claude applies decisions later, with /sift:apply, after you confirm.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, outRoot, readJSON, writeJSON } from './lib/common.mjs';
import { validateDecisions } from './lib/decisions.mjs';

const args = parseArgs();
const root = outRoot(args.base || process.cwd());
const stateFile = path.join(root, '.server.json');

if (args.stop) {
  const st = readJSON(stateFile, null);
  if (!st) { console.log('No Sift server is running for this folder.'); process.exit(0); }
  try { process.kill(st.pid); console.log(`Stopped the Sift server on port ${st.port}.`); } catch { console.log('The server had already stopped.'); }
  fs.rmSync(stateFile, { force: true });
  process.exit(0);
}

fs.mkdirSync(root, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SLUG = /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;
let port = Number(args.port || 4390);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** Only this machine's browser, on this server's own address, may call the API (blocks other sites and DNS rebinding). */
function trusted(req) {
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!ok.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ok.has(origin.replace(/^https?:\/\//, ''))) return false;
  return true;
}

function listReports() {
  const dirs = fs.readdirSync(root).filter((d) => SLUG.test(d) && fs.existsSync(path.join(root, d, 'index.html')));
  const rows = dirs.map((d) => {
    const meta = readJSON(path.join(root, d, '.cache', 'meta.json'), {});
    const name = (meta.repo || d.replace('__', '/')).replace(/[<>&"]/g, '');
    return `<li><a href="/${encodeURIComponent(d)}/">${name}</a> <span>${meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString() : ''}</span></li>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Sift</title><style>body{font:16px system-ui;background:#111113;color:#e8e8ea;max-width:640px;margin:80px auto;padding:0 24px}a{color:#a5b4fc}span{color:#8b8b93;font-size:13px;margin-left:8px}li{margin:10px 0}</style><h1>Sift</h1>${rows.length ? `<ul>${rows.join('')}</ul>` : '<p>No reports yet. Ask Claude to triage a repository.</p>'}`;
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'api') {
    if (parts[1] === 'ping') return send(res, 200, { ok: true, app: 'sift' });
    if (parts[1] !== 'decisions' || !SLUG.test(parts[2] || '')) return send(res, 404, { error: 'not found' });
    const dir = path.join(root, parts[2]);
    if (!fs.existsSync(dir)) return send(res, 404, { error: 'no report for that repository' });
    const file = path.join(dir, 'decisions.json');
    if (req.method === 'GET') return send(res, 200, readJSON(file, { decisions: {} }));
    if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 4 * 1024 * 1024) return send(res, 413, { error: 'too large' });
      chunks.push(c);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    const meta = readJSON(path.join(dir, '.cache', 'meta.json'), {});
    const { value, errors } = validateDecisions(body, meta.repo);
    if (errors.length) return send(res, 400, { error: errors.slice(0, 5).join('; ') });
    // Keep results Claude already recorded; the browser only owns the pending queue.
    const prev = readJSON(file, { decisions: {} });
    for (const [k, d] of Object.entries(prev.decisions || {})) if (d.status && d.status !== 'pending' && !value.decisions[k]) value.decisions[k] = d;
    writeJSON(file, value);
    return send(res, 200, { ok: true, saved: Object.keys(value.decisions).length, path: path.relative(process.cwd(), file) });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (!parts.length) return send(res, 200, listReports(), TYPES['.html']);
  // Static files: report folders only, never dotfiles or the cache.
  if (parts.some((p) => p.startsWith('.') || p.includes('\\')) || !SLUG.test(parts[0])) return send(res, 404, 'Not found', 'text/plain');
  let file = path.join(root, ...parts);
  if (!file.startsWith(root + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  const ext = path.extname(file);
  if (!TYPES[ext] || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  return send(res, 200, fs.readFileSync(file), TYPES[ext]);
});

function listen(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) { port++; listen(attempt + 1); }
    else { console.error(`Could not start: ${e.message}`); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    writeJSON(stateFile, { pid: process.pid, port, startedAt: new Date().toISOString() });
    console.log(`SIFT      http://127.0.0.1:${port}/`);
  });
}
const cleanup = () => { const st = readJSON(stateFile, null); if (st?.pid === process.pid) fs.rmSync(stateFile, { force: true }); process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
listen();
