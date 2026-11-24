#!/usr/bin/env node
// Merge scores + Claude's verdicts + brief into sift/<owner>__<name>/index.html (one self-contained file).
// Usage: node build.mjs <owner/name> [--base <dir>]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseRepo, repoDir, readJSON, writeJSON, die, excerpt } from './lib/common.mjs';
import { clean, injectionFindings } from './lib/untrusted.mjs';
import { NEEDS, ROLES } from './lib/permissions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const repo = parseRepo(args._[0]);
if (!repo) die('Give a repository: owner/name.');
const dir = repoDir(repo, args.base || process.cwd());
const items = readJSON(path.join(dir, '.cache', 'items.json'), null);
const scored = readJSON(path.join(dir, '.cache', 'scores.json'), null);
if (!items || !scored) die(`Run fetch.mjs and analyze.mjs for ${repo.slug} first.`);
const meta = readJSON(path.join(dir, '.cache', 'meta.json'), {});
const brief = readJSON(path.join(dir, 'brief.json'), {});

export const ACTIONS = {
  issue: ['fix', 'investigate', 'respond', 'needs-repro', 'keep-watching', 'label', 'close-duplicate', 'close-stale', 'close-not-planned', 'close-completed', 'convert-to-discussion'],
  pr: ['merge', 'review', 'nudge-author', 'keep-watching', 'close'],
};
const BUCKETS = new Set(['attention', 'watch', 'backlog', 'noise']);

// ---- verdicts ----------------------------------------------------------------
const verdicts = {};
const problems = [];
const vdir = path.join(dir, 'verdicts');
const partNo = (f) => Number((f.match(/(\d+)/) || [])[1] || 0);
const isFilled = (v) => !!(v && (v.summary || v.why || v.action || v.verdict));
for (const f of fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.endsWith('.json')).sort((a, b) => partNo(a) - partNo(b)) : []) {
  let data;
  try { data = readJSON(path.join(vdir, f)); } catch (e) { problems.push(`${f}: not valid JSON (${e.message.split(':').pop().trim()})`); continue; }
  // Later parts win, but an empty skeleton never hides a written verdict.
  for (const [k, v] of Object.entries(data)) if (isFilled(v) || !verdicts[k]) verdicts[k] = { ...v, _file: f };
}

// Claude's verdicts are read with issue text in view, so check them for what an injection could plant:
// links off GitHub, @mentions, instruction-like text, oversize fields. The comment is what may get posted.
const STR = (v, n) => clean(typeof v === 'string' ? v : '').trim().slice(0, n);
function lintVerdict(key, v, it) {
  const out = { summary: STR(v.summary, 300), why: STR(v.why, 400), action: STR(v.action, 40), comment: STR(v.comment, 1500), bucket: STR(v.bucket, 20), duplicateOf: Number(v.duplicateOf) || undefined };
  const where = `${v._file} ${key}`;
  for (const f of ['summary', 'why', 'comment']) if (typeof v[f] === 'string' && v[f].length > { summary: 300, why: 400, comment: 1500 }[f]) problems.push(`${where}: ${f} is too long and was cut`);
  const all = `${out.summary}\n${out.why}\n${out.comment}`;
  const inj = injectionFindings(all);
  if (inj.length) problems.push(`${where}: verdict text looks like it was steered by the issue (${inj.join(', ')}). Re-judge this item from the worksheet.`);
  const links = (out.comment.match(/https?:\/\/[^\s)]+/g) || []).filter((u) => !/^https:\/\/(github\.com|docs\.github\.com)\//.test(u) && !(meta.homepage && u.startsWith(meta.homepage)));
  if (links.length) { problems.push(`${where}: the suggested comment links outside GitHub (${links.slice(0, 2).join(', ')}). Removed; add it back by hand only if you meant it.`); out.comment = out.comment.replace(/https?:\/\/[^\s)]+/g, (u) => (links.includes(u) ? '[link removed]' : u)); }
  const mentions = (out.comment.match(/(^|\s)@[A-Za-z0-9-]{1,39}/g) || []).map((m) => m.trim()).filter((m) => m.slice(1).toLowerCase() !== String(it.author).toLowerCase());
  if (mentions.length) problems.push(`${where}: the suggested comment mentions ${mentions.join(', ')}; posting it would notify them. Check that's intended.`);
  if (out.duplicateOf && !items[`i${out.duplicateOf}`]) problems.push(`${where}: duplicateOf #${out.duplicateOf} is not an open issue that was fetched`);
  return out;
}

const scoreBy = new Map(scored.scores.map((s) => [s.key, s]));
let filled = 0, empty = 0, stale = 0;
const out = [];
for (const s of scored.scores) {
  const it = items[s.key];
  if (!it) continue;
  const v = verdicts[s.key];
  const x = {
    key: it.key, kind: it.kind, number: it.number, title: clean(it.title), url: it.url, author: it.author,
    labels: it.labels, assignees: it.assignees, reactions: it.reactions.positive, participants: it.participants,
    commentCount: it.commentCount, age: s.age, idle: s.idle,
    bucket: s.bucket, lane: s.lane, status: s.status, unanswered: s.unanswered, external: s.external, attention: s.attention, urgency: s.urgency ?? s.attention, demand: s.demand ?? 0, noise: s.noise,
    signals: s.signals, excerpt: excerpt(clean(it.body), 160),
    // Detail pane: more text for the short lists, a little for the long tail (keeps the page small on huge repos).
    body: excerpt(clean(it.body), s.bucket === 'backlog' ? 500 : 1400),
    comments: (it.recentComments || []).slice(s.bucket === 'backlog' ? -1 : -3).map((c) => ({ author: c.author, assoc: c.assoc, at: c.at, body: excerpt(clean(c.body), s.bucket === 'backlog' ? 200 : 420) })),
    assoc: it.assoc, createdAt: it.createdAt, updatedAt: it.updatedAt, milestone: it.milestone,
    linkedPRs: it.linkedPRs || [], closesIssues: it.closesIssues || [],
  };
  if (it.kind === 'pr') Object.assign(x, { additions: it.additions, deletions: it.deletions, size: s.size, checks: it.checks, draft: it.draft });
  const dupSig = s.signals.find((g) => /^dup of #/.test(g.t));
  if (dupSig) x.dupOf = Number(dupSig.t.match(/#(\d+)/)[1]);
  if (v && (v.summary || v.why || v.action)) {
    filled++;
    if (v._seen && v._seen !== it.updatedAt) stale++;
    const allowed = ACTIONS[it.kind];
    if (v.action && !allowed.includes(v.action)) problems.push(`${v._file} ${s.key}: action "${v.action}" is not one of ${allowed.join(', ')}`);
    if (v.bucket && !BUCKETS.has(v.bucket)) problems.push(`${v._file} ${s.key}: bucket "${v.bucket}" must be one of ${[...BUCKETS].join(', ')}`);
    x.verdict = lintVerdict(s.key, v, it);
    // Claude has read it; its call on the bucket wins over the heuristic.
    if (v.bucket && BUCKETS.has(v.bucket) && v.bucket !== x.bucket && x.bucket !== 'bots') {
      x.signals = [...x.signals, { t: `moved to ${v.bucket}`, tone: 'info', why: `Scored as ${x.bucket}; Claude moved it after reading it` }];
      x.bucket = v.bucket;
      if (v.bucket === 'attention' && it.kind === 'issue' && !x.lane) x.lane = x.urgency >= x.demand ? 'urgent' : 'wanted';
    }
    if (v.lane === 'urgent' || v.lane === 'wanted') x.lane = v.lane;
  } else if (v) empty++;
  out.push(x);
}

// ---- duplicate clusters --------------------------------------------------------
const clusters = scored.clusters.map((cl) => {
  const members = cl.map((k) => items[k]).filter(Boolean).sort((a, b) => b.reactions.positive - a.reactions.positive);
  const key = `dupes:${members[0]?.key}`;
  const v = verdicts[key] || {};
  const keep = Number(v.keep) || members[0]?.number;
  if (v.verdict && !['duplicates', 'related', 'different'].includes(v.verdict)) problems.push(`${v._file} ${key}: verdict must be duplicates, related or different`);
  return { members: members.map((m) => m.number), keep, verdict: v.verdict || '', summary: v.summary || '' };
}).filter((c) => c.members.length > 1);
// A "different" verdict clears the duplicate penalty; "duplicates" makes the copies noise.
const byNum = new Map(out.filter((x) => x.kind === 'issue').map((x) => [x.number, x]));
for (const c of clusters) {
  for (const n of c.members) {
    const x = byNum.get(n);
    if (!x || n === c.keep) continue;
    if (c.verdict === 'different' || c.verdict === 'related') {
      x.signals = x.signals.filter((g) => !/^dup of #/.test(g.t));
      if (x.dupOf && !x.verdict?.bucket) { x.noise = Math.max(0, x.noise - 40); if (x.bucket === 'noise' && x.noise < 45) x.bucket = x.attention >= 16 ? 'watch' : 'backlog'; }
      delete x.dupOf;
    } else if (c.verdict === 'duplicates') {
      x.dupOf = c.keep;
      x.bucket = 'noise';
      x.verdict = { ...(x.verdict || {}), action: x.verdict?.action || 'close-duplicate', duplicateOf: c.keep, why: x.verdict?.why || `Duplicate of #${c.keep}` };
    }
  }
}
// Clusters that still have nobody to close (all kept apart) aren't worth listing.
const ORDER = { duplicates: 0, '': 1, related: 2 };
const shownClusters = clusters.filter((c) => c.verdict !== 'different').sort((a, b) => (ORDER[a.verdict] ?? 3) - (ORDER[b.verdict] ?? 3));

// ---- label hotspots ------------------------------------------------------------
const GENERIC = /^(bug|enhancement|feature|question|documentation|docs|help wanted|good first issue|duplicate|invalid|wontfix|triage|needs[- ]triage|stale|dependencies)$/i;
const hot = new Map();
for (const x of out) {
  if (x.kind !== 'issue' || x.bucket === 'noise') continue;
  for (const l of x.labels) {
    if (GENERIC.test(l)) continue;
    const h = hot.get(l) || { label: l, count: 0, attention: 0, weight: 0 };
    h.count++;
    if (x.bucket === 'attention') h.attention++;
    h.weight += x.attention;
    hot.set(l, h);
  }
}
const labelHotspots = [...hot.values()].filter((h) => h.count >= 3).sort((a, b) => b.weight - a.weight).slice(0, 12).map((h) => ({ ...h, weight: Math.round(h.weight) }));

// ---- brief ---------------------------------------------------------------------
const knownKeys = new Set(out.map((x) => x.key));
for (const t of brief.themes || []) {
  for (const ref of t.items || []) {
    const k = String(ref);
    const ok = knownKeys.has(k) || knownKeys.has('i' + k.replace(/\D/g, '')) || knownKeys.has('p' + k.replace(/\D/g, ''));
    if (!ok) problems.push(`brief.json theme "${t.title}": ${ref} is not an open item that was fetched`);
  }
}

const report = {
  repo: {
    slug: repo.slug, url: meta.url || `https://github.com/${repo.slug}`, description: meta.description || '',
    fetchedAt: meta.fetchedAt, totals: meta.totals, fetched: meta.fetched,
    // The signed-in user's role when fetched (lib/permissions.mjs). The inbox locks actions it doesn't allow.
    permission: meta.permission || null, archived: !!meta.archived, access: { roles: ROLES, needs: NEEDS },
    partial: meta.totals && meta.fetched && meta.fetched.issues < meta.totals.openIssues,
  },
  generatedAt: new Date().toISOString(),
  brief: { headline: brief.headline || '', themes: brief.themes || [], notes: brief.notes || [] },
  items: out,
  clusters: shownClusters,
  labelHotspots,
  dir: `${repo.owner}__${repo.name}`,
  repoLabels: (meta.repoLabels || []).map((l) => l.name),
  decisions: readJSON(path.join(dir, 'decisions.json'), { decisions: {} }),
};
writeJSON(path.join(dir, 'report.json'), report, false);

const tpl = fs.readFileSync(path.join(here, '..', 'assets', 'viewer.html'), 'utf8');
// Issue text is untrusted: escape anything that could close the script tag or open a comment.
const json = JSON.stringify(report).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const html = tpl.replace('__TITLE__', repo.slug.replace(/[<>&"]/g, '')).replace('__DATA__', () => json);
const outFile = path.join(dir, 'index.html');
fs.writeFileSync(outFile, html);

// ---- report --------------------------------------------------------------------
const c = (pred) => out.filter(pred).length;
console.log(`BUILT     ${path.relative(process.cwd(), outFile) || outFile}  (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`ISSUES    urgent ${c((x) => x.kind === 'issue' && x.bucket === 'attention' && x.lane === 'urgent')}  ·  most wanted ${c((x) => x.kind === 'issue' && x.bucket === 'attention' && x.lane === 'wanted')}  ·  watch ${c((x) => x.kind === 'issue' && x.bucket === 'watch')}  ·  noise ${c((x) => x.kind === 'issue' && x.bucket === 'noise')}`);
console.log(`PRS       to review ${c((x) => x.kind === 'pr' && x.bucket === 'attention')}  ·  noise ${c((x) => x.kind === 'pr' && x.bucket === 'noise')}  ·  bots ${c((x) => x.bucket === 'bots')}`);
console.log(`VERDICTS  ${filled} written${empty ? `, ${empty} still empty` : ''}${stale ? `, ${stale} on items that changed since (re-run analyze.mjs to requeue)` : ''}`);
console.log(`DUPES     ${shownClusters.length} groups shown (${clusters.filter((c) => c.verdict === 'duplicates').length} confirmed)`);
console.log(`BRIEF     ${brief.headline ? 'headline' : 'NO headline'} · ${(brief.themes || []).length} themes`);
if (problems.length) {
  console.log(`PROBLEMS  ${problems.length}`);
  for (const p of problems.slice(0, 30)) console.log(`  - ${p}`);
}
