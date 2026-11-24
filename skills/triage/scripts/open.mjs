#!/usr/bin/env node
// Open the inbox. Starts the local Sift server in the background (or reuses it) so queued actions save to decisions.json.
// Usage: node open.mjs <owner/repo> [--base <dir>] [--no-open] [--port 4390]
// Stop the server with: node serve.mjs --stop
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseRepo, repoDir, outRoot, readJSON, die } from './lib/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const repo = parseRepo(args._[0]);
if (!repo) die('Give a repository: owner/name.');
const base = args.base || process.cwd();
const file = path.join(repoDir(repo, base), 'index.html');
if (!fs.existsSync(file)) die(`No report yet. Run build.mjs ${repo.slug} first.`);
const slugDir = `${repo.owner}__${repo.name}`;

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).app === 'sift';
  } catch {
    return false;
  }
}

async function ensureServer() {
  const stateFile = path.join(outRoot(base), '.server.json');
  const st = readJSON(stateFile, null);
  if (st && (await alive(st.port))) return st.port;
  const child = spawn(process.execPath, [path.join(here, 'serve.mjs'), '--base', base, ...(args.port ? ['--port', String(args.port)] : [])], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = readJSON(stateFile, null);
    if (s && s.pid === child.pid && (await alive(s.port))) return s.port;
  }
  return null;
}

const port = await ensureServer();
const url = port ? `http://127.0.0.1:${port}/${slugDir}/` : pathToFileURL(file).href;
console.log(`INBOX     ${url}`);
if (port) console.log(`SAVES     actions you queue are saved to sift/${slugDir}/decisions.json  ·  stop with: node ${path.join(here, 'serve.mjs')} --stop`);
else console.log('NOTE      Could not start the local server; opened the file directly. Queued actions stay in this browser until you export them.');
if (!args['no-open']) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, argv, { detached: true, stdio: 'ignore' }).on('error', () => console.log('NOTE      Could not open a browser here; open the URL above yourself.')).unref();
}
