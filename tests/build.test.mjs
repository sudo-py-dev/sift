// End to end without the network: fake fetched data → analyze → verdicts → build → HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { issue, pr, byKey } from './helpers.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'triage', 'scripts');
const run = (script, base, ...args) => execFileSync(process.execPath, [path.join(scripts, script), 'o/r', '--base', base, ...args], { encoding: 'utf8' });

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
  const dir = path.join(base, 'sift', 'o__r');
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verdicts'), { recursive: true });
  const evil = '</script><script>alert(1)</script><!--';
  const items = byKey(
    issue({ number: 1, title: `Crash ${evil}`, labels: ['bug', 'crash'], participants: 6, reactions: { positive: 9, negative: 0 } }),
    issue({ number: 2, title: 'How do I set the index?', labels: ['question'] }),
    pr({ number: 3, reviewDecision: 'APPROVED', closesIssues: [1] }),
  );
  fs.writeFileSync(path.join(dir, '.cache', 'items.json'), JSON.stringify(items));
  fs.writeFileSync(path.join(dir, '.cache', 'meta.json'), JSON.stringify({ repo: 'o/r', fetchedAt: new Date().toISOString(), totals: { openIssues: 2, openPRs: 1 }, fetched: { issues: 2, prs: 1 }, url: 'https://github.com/o/r' }));
  return { base, dir, evil };
}

test('analyze queues worksheets, build merges verdicts and stays safe with hostile titles', () => {
  const { base, dir, evil } = fixture();
  const a = run('analyze.mjs', base);
  assert.match(a, /WORKSHEETS/);
  const part = path.join(dir, 'verdicts', 'part-1.json');
  const v = JSON.parse(fs.readFileSync(part, 'utf8'));
  assert.ok(v.i1 && v.p3, 'urgent issue and ready PR are queued');
  v.i1 = { ...v.i1, summary: 'Crashes on start.', why: 'Severe.', action: 'fix' };
  v.p3 = { ...v.p3, summary: 'Fixes the crash.', why: 'Approved and green.', action: 'merge' };
  fs.writeFileSync(part, JSON.stringify(v));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify({ headline: 'One crash, one fix ready.', themes: [{ title: 'Crash', items: [1, 3] }], notes: [] }));

  const b = run('build.mjs', base);
  assert.doesNotMatch(b, /PROBLEMS/);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(!html.includes(evil), 'hostile title must not appear unescaped');
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'only the two real closing script tags');
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.items.find((x) => x.number === 1).verdict.action, 'fix');
  assert.equal(report.items.find((x) => x.number === 2).bucket, 'noise');
});

test('build reports bad actions instead of silently accepting them', () => {
  const { base, dir } = fixture();
  run('analyze.mjs', base);
  const part = path.join(dir, 'verdicts', 'part-1.json');
  const v = JSON.parse(fs.readFileSync(part, 'utf8'));
  v.i1 = { ...v.i1, summary: 'x', action: 'merge' };
  fs.writeFileSync(part, JSON.stringify(v));
  assert.match(run('build.mjs', base), /PROBLEMS[\s\S]*not one of/);
});

test('re-running analyze does not re-queue judged, unchanged items', () => {
  const { base, dir } = fixture();
  run('analyze.mjs', base);
  const part = path.join(dir, 'verdicts', 'part-1.json');
  const v = JSON.parse(fs.readFileSync(part, 'utf8'));
  for (const k of Object.keys(v)) Object.assign(v[k], k.startsWith('dupes:') ? { verdict: 'related' } : { summary: 's', why: 'w', action: k.startsWith('p') ? 'review' : 'keep-watching' });
  fs.writeFileSync(part, JSON.stringify(v));
  assert.match(run('analyze.mjs', base), /nothing new to judge/);
});

test('the inbox never turns issue text into HTML', () => {
  const viewer = fs.readFileSync(path.join(scripts, '..', 'assets', 'viewer.html'), 'utf8');
  assert.doesNotMatch(viewer, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(viewer, /Content-Security-Policy/);
});
