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
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // No other site may frame the inbox and trick clicks into queueing actions.
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=()',
  });
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

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Crect width='1024' height='1024' rx='224' fill='%231b1b1a'/%3E%3Cg transform='translate(170 200)'%3E%3Crect width='534' height='93' rx='46.5' fill='%23f87171'/%3E%3Crect y='130' width='425' height='93' rx='46.5' fill='%23fb923c'/%3E%3Crect y='260' width='329' height='93' rx='46.5' fill='%234ade80'/%3E%3Crect y='390' width='206' height='93' rx='46.5' fill='%23a3a19a'/%3E%3Crect y='520' width='151' height='93' rx='46.5' fill='%23a3a19a'/%3E%3C/g%3E%3C/svg%3E";
const MARK = '<svg class="logo" width="26" height="30" viewBox="0 0 534 613" aria-hidden="true"><rect width="534" height="93" rx="46.5" fill="#f87171"/><rect y="130" width="425" height="93" rx="46.5" fill="#fb923c"/><rect y="260" width="329" height="93" rx="46.5" fill="#4ade80"/><rect y="390" width="206" height="93" rx="46.5" fill="#a3a19a"/><rect y="520" width="151" height="93" rx="46.5" fill="#a3a19a"/></svg>';

function listReports() {
  const dirs = fs.readdirSync(root).filter((d) => SLUG.test(d) && fs.existsSync(path.join(root, d, 'index.html')));
  const rows = dirs.map((d) => {
    const meta = readJSON(path.join(root, d, '.cache', 'meta.json'), {});
    const name = (meta.repo || d.replace('__', '/')).replace(/[<>&"]/g, '');
    return `<li><a href="/${encodeURIComponent(d)}/"><b>${name}</b><span>${meta.fetchedAt ? `fetched ${new Date(meta.fetchedAt).toLocaleString()}` : ''}</span></a></li>`;
  });
  // Brand: tokens, mark and favicon match BRAND.md and the inbox (viewer.html).
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sift</title>`
    + `<link rel="icon" href="${FAVICON}"><meta name="theme-color" content="#1b1b1a">`
    + `<style>:root{--bg:#131312;--surface:#1b1b1a;--surface-2:#222220;--line:rgba(255,255,255,.065);--text:#ecebe6;--muted:#a3a19a;--faint:#8b8982;--accent:#8e8cff;color-scheme:dark}`
    + `@media (prefers-color-scheme:light){:root{--bg:#f6f5f2;--surface:#fff;--surface-2:#faf9f7;--line:rgba(27,27,26,.08);--text:#1b1b1a;--muted:#57554f;--faint:#6c6963;--accent:#5552e8;color-scheme:light}}`
    + `body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}`
    + `main{max-width:640px;margin:72px auto;padding:0 24px}header{display:flex;align-items:center;gap:12px;margin-bottom:6px}h1{margin:0;font-size:24px;font-weight:700;letter-spacing:-.02em}`
    + `p{color:var(--muted);margin:0 0 24px}ul{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}`
    + `li + li{border-top:1px solid var(--line)}a{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:14px 18px;color:inherit;text-decoration:none}a:hover{background:var(--surface-2)}`
    + `a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}b{font-weight:600}span{color:var(--faint);font-size:12.5px;white-space:nowrap}</style>`
    + `<main><header>${MARK}<h1>Sift</h1></header><p>Triage inboxes on this machine. Nothing here changes GitHub until you confirm in Claude Code.</p>`
    + `${rows.length ? `<ul>${rows.join('')}</ul>` : '<p>No reports yet. Ask Claude to triage a repository.</p>'}</main></html>`;
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) return send(res, 403, { error: 'forbidden' });
  if ((req.url || '').length > 2048) return send(res, 414, { error: 'too long' });
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
    // Refuse actions the user's account can't take on this repo (role recorded by fetch.mjs).
    const { value, errors } = validateDecisions(body, meta.repo, meta.permission || null);
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
