#!/usr/bin/env node
// WRITES TO GITHUB. Runs the queued decisions the user confirmed, one gh command each, and records the result.
// Usage: node apply.mjs <owner/repo> --keys i123,p45 | --all  [--base <dir>]
// Run plan.mjs first and get the user's confirmation. Each command runs without a shell.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, parseRepo, repoDir, readJSON, writeJSON, die } from './lib/common.mjs';
import { command, shellQuote, validateDecisions } from './lib/decisions.mjs';
import { can, effectiveRole, lockReason, roleLabel } from './lib/permissions.mjs';
import { viewerAccess } from './lib/gh.mjs';

const args = parseArgs();
const repo = parseRepo(args._[0]);
if (!repo) die('Give a repository: owner/name.');
if (!args.keys && !args.all) die('Name what to apply: --keys i123,p45 or --all. Run plan.mjs first and confirm with the user.');
const dir = repoDir(repo, args.base || process.cwd());
const file = path.join(dir, 'decisions.json');
const raw = readJSON(file, null);
if (raw?.repo && parseRepo(raw.repo)?.slug.toLowerCase() !== repo.slug.toLowerCase()) die(`decisions.json is for ${raw.repo}, not ${repo.slug}. Refusing to mix repositories.`);
// Re-check the file: it may have been edited by hand or by something else since the inbox saved it.
const checked = raw ? validateDecisions(raw, repo.slug) : { value: null, errors: [] };
for (const e of checked.errors) console.log(`INVALID   ${e} (ignored)`);
const data = checked.value;
if (data) for (const [k, d] of Object.entries(raw.decisions || {})) if (data.decisions[k] && d.appliedAt) data.decisions[k].appliedAt = String(d.appliedAt).slice(0, 40);
if (!data) die('No decisions.json.');

const wanted = args.all ? null : new Set(String(args.keys).split(',').map((s) => s.trim()).filter(Boolean));
const targets = Object.entries(data.decisions).filter(([k, d]) => d.status === 'pending' && (!wanted || wanted.has(k)));
if (wanted) for (const k of wanted) if (!data.decisions[k] || data.decisions[k].status !== 'pending') console.log(`SKIP      ${k}: not a pending decision`);
if (!targets.length) die('Nothing pending to apply.');

// Check the account's role on the repo live, right before sending anything. The inbox locks actions too,
// but roles change and decisions.json can be edited; this is the check that counts.
let role;
try {
  role = effectiveRole(await viewerAccess(repo.owner, repo.name));
} catch (e) {
  die(`Could not check your access to ${repo.slug} (${String(e.message).slice(0, 200)}). Nothing was applied.`);
}
console.log(`ACCESS    ${roleLabel(role)}`);

let ok = 0, failed = 0;
for (const [key, d] of targets) {
  if (!can(role, d.action)) {
    d.status = 'skipped';
    d.result = lockReason(role, d.action);
    d.appliedAt = new Date().toISOString();
    console.log(`SKIP      ${key}: ${d.action} is locked. ${d.result}`);
    writeJSON(file, data);
    continue;
  }
  const argv = command(d, repo.slug);
  if (argv === undefined) {
    console.log(`SKIP      ${key}: the comment text is still empty. Draft it into decisions.json, show the user, then apply.`);
    continue;
  }
  if (!argv) {
    d.status = 'done';
    d.result = 'Report only';
    ok++;
    console.log(`DONE      ${key}  ${d.action} (report only)`);
    continue;
  }
  try {
    const out = execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    d.status = 'done';
    d.result = (out.trim().split('\n').pop() || 'ok').slice(0, 300);
    ok++;
    console.log(`DONE      ${key}  $ ${shellQuote(argv).replace(/\n/g, '\\n').slice(0, 160)}`);
  } catch (e) {
    d.status = 'failed';
    d.result = String(e.stderr || e.message).trim().slice(0, 300);
    failed++;
    console.log(`FAILED    ${key}  ${d.result}`);
  }
  d.appliedAt = new Date().toISOString();
  writeJSON(file, data); // after every step, so an interruption never loses what already happened
}
console.log(`RESULT    ${ok} done, ${failed} failed. Recorded in ${path.relative(process.cwd(), file)}.`);
console.log(`NEXT      node <skill>/scripts/build.mjs ${repo.slug}   (the inbox shows applied actions as done)`);
