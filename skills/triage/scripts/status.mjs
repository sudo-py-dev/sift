#!/usr/bin/env node
// List Sift reports under ./sift, with how fresh each one is and how much is judged.
// Usage: node status.mjs [--base <dir>]
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, outRoot, readJSON, fmtDays, daysBetween } from './lib/common.mjs';

const args = parseArgs();
const root = outRoot(args.base || process.cwd());
const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.includes('__') && fs.existsSync(path.join(root, d, '.cache', 'meta.json'))) : [];
if (!dirs.length) {
  console.log('No Sift reports in this folder yet.');
  process.exit(0);
}
for (const d of dirs) {
  const meta = readJSON(path.join(root, d, '.cache', 'meta.json'), {});
  const vdir = path.join(root, d, 'verdicts');
  let filled = 0, total = 0;
  for (const f of fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.endsWith('.json')) : []) {
    for (const v of Object.values(readJSON(path.join(vdir, f), {}))) { total++; if (v.summary || v.verdict) filled++; }
  }
  const built = fs.existsSync(path.join(root, d, 'index.html'));
  const brief = readJSON(path.join(root, d, 'brief.json'), {});
  console.log(`${meta.repo}  ·  fetched ${((d) => (d < 1 ? 'today' : fmtDays(d) + ' ago'))(daysBetween(meta.fetchedAt, new Date()))}  ·  ${meta.fetched?.issues ?? '?'} issues, ${meta.fetched?.prs ?? '?'} PRs  ·  verdicts ${filled}/${total}  ·  brief ${brief.headline ? 'yes' : 'no'}  ·  ${built ? 'report built' : 'not built'}  →  sift/${d}/index.html`);
}
