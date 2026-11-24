// Shared helpers: argument parsing, paths, JSON IO, time math. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const DAY = 86_400_000;

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** Accepts owner/name, a github.com URL, or git@github.com:owner/name(.git). */
export function parseRepo(s) {
  if (!s) return null;
  const m = String(s).trim().match(/(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

export function outRoot(base = process.cwd()) {
  return path.join(base, 'sift');
}

export function repoDir(repo, base) {
  return path.join(outRoot(base), `${repo.owner}__${repo.name}`);
}

/** Creates sift/ with a .gitignore so nothing here is ever committed by accident. */
export function ensureDirs(repo, base) {
  const root = outRoot(base);
  fs.mkdirSync(root, { recursive: true });
  const gi = path.join(root, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Made by the Sift plugin. Nothing here is meant to be committed.\n*\n');
  const dir = repoDir(repo, base);
  for (const sub of ['', '.cache', '.cache/worksheets', 'verdicts']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

export function readJSON(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

export function writeJSON(file, data, pretty = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, pretty ? 2 : 0) + '\n');
}

export const daysBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / DAY);

export function fmtDays(d) {
  if (d < 1) return 'today';
  if (d < 2) return '1 day';
  if (d < 60) return `${Math.round(d)} days`;
  if (d < 730) return `${Math.round(d / 30)} months`;
  return `${(d / 365).toFixed(1)} years`;
}

export function die(msg) {
  console.error(`\nERROR  ${msg}\n`);
  process.exit(1);
}

/** Strips HTML comments and template headers so "body quality" measures what the author actually wrote. */
export function meaningfulText(body = '') {
  return String(body)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*[-*]\s*\[[ xX]\]\s.*$/gm, ' ')
    .replace(/_?No response_?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerpt(s = '', n = 300) {
  const t = String(s).replace(/<!--[\s\S]*?-->/g, ' ').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
}

export const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const BOT_RE = /(\[bot\]$|^dependabot|^renovate|^github-actions|^copilot|-bot$|^bot-|^codspeed|^codecov|^netlify|^vercel|^sonarcloud|^coderabbit|-connector$|^changeset-bot|^pre-commit-ci|^allcontributors|^stale$)/i;
