#!/usr/bin/env node
// Fetch open issues and PRs for a GitHub repo into sift/<owner>__<name>/.cache/items.json.
// Usage: node fetch.mjs <owner/name|url> [--max 2000] [--max-prs 800] [--full] [--concurrency 6] [--base <dir>]
// A second run only asks GitHub for what changed since the last fetch (use --full to start over).
import path from 'node:path';
import { parseArgs, parseRepo, ensureDirs, readJSON, writeJSON, die, excerpt, meaningfulText, BOT_RE } from './lib/common.mjs';
import { ghAvailable, repoInfo, fetchTopReacted, shard, fetchSearch, pool, updatedCutoff, budget } from './lib/gh.mjs';

const args = parseArgs();
const repo = parseRepo(args._[0]);
if (!repo) die('Give a repository: owner/name or a github.com URL.');
if (!ghAvailable()) die('The GitHub CLI (gh) is not signed in. Run `gh auth login` first.');

const base = args.base || process.cwd();
const dir = ensureDirs(repo, base);
const itemsFile = path.join(dir, '.cache', 'items.json');
const metaFile = path.join(dir, '.cache', 'meta.json');
const maxIssues = Number(args.max || 2000);
const maxPRs = Number(args['max-prs'] || 800);

const prevMeta = readJSON(metaFile, null);
const prevItems = args.full ? {} : readJSON(itemsFile, {});
const incremental = !args.full && prevMeta?.fetchedAt && Object.keys(prevItems).length > 0;
// Overlap a little so nothing that changed during the last fetch slips through.
const since = incremental ? new Date(new Date(prevMeta.fetchedAt).getTime() - 10 * 60_000).toISOString() : null;

const startedAt = new Date().toISOString();
const info = await repoInfo(repo.owner, repo.name);
console.log(`REPO      ${info.nameWithOwner}  ·  ${info.openIssues.totalCount} open issues  ·  ${info.openPRs.totalCount} open PRs  ·  ★ ${info.stargazerCount}`);
if (info.isArchived) console.log('NOTE      This repository is archived.');
console.log(`MODE      ${incremental ? `refresh (changes since ${prevMeta.fetchedAt})` : 'full fetch'}`);

const concurrency = Number(args.concurrency || 6);
const from = new Date(info.createdAt);
const to = new Date(Date.now() + 60_000);
let got = 0;
const tick = () => process.stdout.write(`\rFETCHING  ${got} items   (API budget left: ${budget.remaining ?? '?'})      `);

/** Plans shards for one kind (issue|pr), honouring --max by keeping the most recently updated. */
async function plan(kind, max) {
  const scope = `repo:${repo.slug} is:${kind}`;
  if (incremental) return shard(`${scope} updated:>=${since}`, from, to);
  const open = `${scope} is:open`;
  const total = kind === 'issue' ? info.openIssues.totalCount : info.openPRs.totalCount;
  let base = open;
  if (total > max) {
    const cut = await updatedCutoff(open, max, from, to);
    base = `${open} updated:>=${cut.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  }
  return shard(base, from, to);
}

const [issueShards, prShards] = await Promise.all([plan('issue', maxIssues), plan('pr', maxPRs)]);
console.log(`PLAN      ${issueShards.length + prShards.length} search windows (${issueShards.reduce((a, x) => a + x.n, 0)} issues, ${prShards.reduce((a, x) => a + x.n, 0)} PRs), ${concurrency} at a time`);
const jobs = [
  ...issueShards.map((s) => async () => ({ kind: 'issue', nodes: await fetchSearch(s.q, 'issue', { onItems: (n) => { got += n; tick(); } }) })),
  ...prShards.map((s) => async () => ({ kind: 'pr', nodes: await fetchSearch(s.q, 'pr', { onItems: (n) => { got += n; tick(); } }) })),
];
const results = await pool(jobs, concurrency);
process.stdout.write('\n');
const issues = { items: results.filter((r) => r.kind === 'issue').flatMap((r) => r.nodes) };
const prs = { items: results.filter((r) => r.kind === 'pr').flatMap((r) => r.nodes) };
let top = [];
try {
  top = await fetchTopReacted(repo.owner, repo.name, 100);
} catch (e) {
  console.log(`NOTE      Skipped the most-upvoted search: ${e.message}`);
}

const reactions = (groups = []) => {
  const r = Object.fromEntries(groups.map((g) => [g.content.toLowerCase(), g.reactors.totalCount]));
  const up = r.thumbs_up || 0;
  return {
    up,
    down: r.thumbs_down || 0,
    positive: up + (r.heart || 0) + (r.hooray || 0) + (r.rocket || 0) + (r.eyes || 0),
    negative: (r.thumbs_down || 0) + (r.confused || 0),
  };
};

function normalize(n, kind) {
  const login = n.author?.login || 'ghost';
  const base = {
    key: `${kind === 'pr' ? 'p' : 'i'}${n.number}`,
    kind,
    number: n.number,
    title: n.title,
    url: n.url,
    state: n.state,
    author: login,
    assoc: n.authorAssociation,
    isBot: BOT_RE.test(login),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    labels: (n.labels?.nodes || []).map((l) => l.name),
    assignees: (n.assignees?.nodes || []).map((a) => a.login),
    milestone: n.milestone?.title || null,
    reactions: reactions(n.reactionGroups),
    participants: n.participants?.totalCount || 0,
    commentCount: n.comments?.totalCount || 0,
    recentComments: (n.comments?.nodes || []).map((c) => ({
      author: c.author?.login || 'ghost',
      assoc: c.authorAssociation,
      at: c.createdAt,
      body: excerpt(c.body, 280),
    })),
    body: excerpt(n.body, 1200),
    bodyLen: meaningfulText(n.body).length,
    hasCode: /```|^\s{4}\S|Traceback|Exception|panicked|error\[/m.test(n.body || ''),
  };
  if (kind === 'issue') {
    base.linkedPRs = (n.closedByPullRequestsReferences?.nodes || []).map((p) => p.number);
    return base;
  }
  const last = n.commits?.nodes?.[0]?.commit;
  return {
    ...base,
    draft: n.isDraft,
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    mergeable: n.mergeable,
    reviewDecision: n.reviewDecision,
    reviewRequests: n.reviewRequests?.totalCount || 0,
    reviews: (n.reviews?.nodes || []).map((r) => ({ author: r.author?.login || 'ghost', assoc: r.authorAssociation, state: r.state, at: r.submittedAt })),
    checks: last?.statusCheckRollup?.state || 'NONE',
    lastCommitAt: last?.committedDate || n.createdAt,
    closesIssues: (n.closingIssuesReferences?.nodes || []).map((x) => x.number),
    base: n.baseRefName,
  };
}

const items = { ...prevItems };
let added = 0, updated = 0, removed = 0;
const apply = (n, kind) => {
  const it = normalize(n, kind);
  if (it.state !== 'OPEN') {
    if (items[it.key]) { delete items[it.key]; removed++; }
    return;
  }
  if (items[it.key]) updated++; else added++;
  items[it.key] = it;
};
issues.items.forEach((n) => apply(n, 'issue'));
prs.items.forEach((n) => apply(n, 'pr'));
let topAdded = 0;
for (const n of top) {
  const k = `i${n.number}`;
  if (items[k] && items[k].updatedAt >= n.updatedAt) continue;
  if (!items[k]) topAdded++;
  items[k] = normalize(n, 'issue');
}

writeJSON(itemsFile, items, false);
const counts = Object.values(items).reduce((a, it) => ((a[it.kind] = (a[it.kind] || 0) + 1), a), {});
writeJSON(metaFile, {
  repo: repo.slug,
  fetchedAt: startedAt,
  description: info.description,
  url: info.url,
  stars: info.stargazerCount,
  archived: info.isArchived,
  hasDiscussions: info.hasDiscussionsEnabled,
  totals: { openIssues: info.openIssues.totalCount, openPRs: info.openPRs.totalCount },
  fetched: { issues: counts.issue || 0, prs: counts.pr || 0 },
  limits: incremental ? prevMeta.limits : { maxIssues, maxPRs },
  repoLabels: info.labels.nodes,
});

console.log(`SAVED     ${counts.issue || 0} issues, ${counts.pr || 0} PRs  →  ${path.relative(base, itemsFile)}`);
if (incremental) console.log(`CHANGES   ${added} new, ${updated} updated, ${removed} closed or merged since last fetch`);
if (topAdded) console.log(`TOP       ${topAdded} heavily-upvoted older issues added beyond --max`);
const missed = info.openIssues.totalCount - (counts.issue || 0);
if (!incremental && missed > 0)
  console.log(`NOTE      ${missed} open issues were not fetched (least recently updated, beyond --max ${maxIssues}). Raise --max to include them.`);
console.log(`NEXT      node <skill>/scripts/analyze.mjs ${repo.slug}`);
