#!/usr/bin/env node
// Read-only: show what the queued decisions would do. Prints every gh command exactly as apply.mjs would run it.
// Usage: node plan.mjs <owner/repo> [--base <dir>] [--json]
import path from 'node:path';
import { parseArgs, parseRepo, repoDir, readJSON, die, fmtDays, daysBetween } from './lib/common.mjs';
import { ACTIONS, command, shellQuote, validateDecisions } from './lib/decisions.mjs';

const args = parseArgs();
const repo = parseRepo(args._[0]);
if (!repo) die('Give a repository: owner/name.');
const dir = repoDir(repo, args.base || process.cwd());
const file = path.join(dir, 'decisions.json');
const raw = readJSON(file, null);
if (raw?.repo && parseRepo(raw.repo)?.slug.toLowerCase() !== repo.slug.toLowerCase()) die(`decisions.json is for ${raw.repo}, not ${repo.slug}. Refusing to mix repositories.`);
// Re-check the file: it may have been edited by hand or by something else since the inbox saved it.
const checked = raw ? validateDecisions(raw, repo.slug) : { value: null, errors: [] };
for (const e of checked.errors) console.log(`INVALID   ${e} (ignored)`);
const data = checked.value;
if (data) for (const [k, d] of Object.entries(raw.decisions || {})) if (data.decisions[k] && d.appliedAt) data.decisions[k].appliedAt = String(d.appliedAt).slice(0, 40);
if (!data || !Object.keys(data.decisions || {}).length) die(`No decisions queued. Open the inbox (open.mjs ${repo.slug}) and queue some actions first.`);
const items = readJSON(path.join(dir, '.cache', 'items.json'), {});

const pending = Object.entries(data.decisions).filter(([, d]) => d.status === 'pending');
const rows = pending.map(([key, d]) => {
  const it = items[key];
  const argv = command(d, repo.slug);
  const warnings = [];
  if (!it) warnings.push('not in the last fetch (it may already be closed or merged)');
  else if (d.at && it.updatedAt > d.at) warnings.push(`changed on GitHub ${fmtDays(daysBetween(it.updatedAt, new Date()))} ago, after you decided`);
  if (d.action === 'merge' && it && (it.checks === 'FAILURE' || it.mergeable === 'CONFLICTING')) warnings.push(`checks ${it.checks.toLowerCase()}, mergeable ${String(it.mergeable).toLowerCase()}`);
  if (argv === undefined) warnings.push('comment text is empty: draft it from the note, write it into decisions.json, and show the user before applying');
  return { key, ...d, title: it?.title || d.title, label: ACTIONS[d.kind][d.action].label, github: argv !== null, command: argv ? shellQuote(argv) : null, warnings };
});

if (args.json) {
  console.log(JSON.stringify({ repo: repo.slug, instructions: data.instructions || '', pending: rows }, null, 2));
  process.exit(0);
}

const gh = rows.filter((r) => r.github);
const local = rows.filter((r) => !r.github);
const done = Object.values(data.decisions).filter((d) => d.status !== 'pending').length;
console.log(`QUEUE     ${rows.length} pending  ·  ${gh.length} change GitHub  ·  ${local.length} only change the report${done ? `  ·  ${done} already applied` : ''}`);
if (data.instructions?.trim()) console.log(`\nINSTRUCTIONS FROM YOU\n  ${data.instructions.trim().replace(/\n/g, '\n  ')}`);
const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const r of list) {
    console.log(`  ${r.key.padEnd(8)} ${r.label}${r.of ? ` of #${r.of}` : ''}  ·  #${r.number} ${String(r.title || '').slice(0, 70)}`);
    if (r.command) console.log(`           $ ${r.command.replace(/\n/g, '\\n')}`);
    if (r.note) console.log(`           note: ${r.note.replace(/\n/g, ' ')}`);
    for (const w of r.warnings) console.log(`           ! ${w}`);
  }
};
show('CHANGES ON GITHUB', gh);
show('REPORT ONLY (no GitHub change)', local);
console.log(`\nNEXT      after the user confirms: node <skill>/scripts/apply.mjs ${repo.slug} --keys <k1,k2,...> (or --all)`);
