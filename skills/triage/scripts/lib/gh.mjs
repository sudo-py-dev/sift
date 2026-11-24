// Talks to GitHub through the user's own `gh` CLI sign-in. Read-only: GraphQL queries only, never mutations.
//
// Speed on big repos: GitHub search returns at most 1,000 results per query, so we split the repo's
// history into created-date shards that each hold fewer than that, and fetch several shards at once.
import { execFile, execFileSync } from 'node:child_process';

const COMMON = `
  number title url state createdAt updatedAt closedAt
  author { login } authorAssociation body
  labels(first: 15) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  milestone { title }
  reactionGroups { content reactors { totalCount } }
  participants { totalCount }
`;

export const ISSUE_FIELDS = `
  ${COMMON}
  stateReason
  comments(last: 6) { totalCount nodes { author { login } authorAssociation createdAt body } }
  closedByPullRequestsReferences(first: 3, includeClosedPrs: false) { nodes { number isDraft } }
`;

export const PR_FIELDS = `
  ${COMMON}
  isDraft mergedAt additions deletions changedFiles mergeable reviewDecision baseRefName
  comments(last: 4) { totalCount nodes { author { login } authorAssociation createdAt body } }
  reviewRequests { totalCount }
  reviews(last: 6) { totalCount nodes { author { login } authorAssociation state submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  closingIssuesReferences(first: 5) { nodes { number } }
`;

export function ghAvailable() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(input) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['api', 'graphql', '--input', '-'], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

export const budget = { remaining: null, resetAt: null };

export async function graphql(query, variables = {}, { retries = 4 } = {}) {
  const input = JSON.stringify({ query, variables });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const json = JSON.parse(await run(input));
      if (json.errors?.length) {
        const err = new Error(json.errors.map((e) => e.message).join('; '));
        err.permanent = !/timeout|timed out|something went wrong|loading/i.test(err.message);
        throw err;
      }
      if (json.data?.rateLimit) Object.assign(budget, json.data.rateLimit);
      return json.data;
    } catch (e) {
      lastErr = e;
      const msg = String(e.stderr || e.message);
      if (/Could not resolve to a Repository/i.test(msg)) throw new Error('Repository not found, or not visible to your gh sign-in.');
      if (/API rate limit exceeded|RATE_LIMITED/i.test(msg)) throw new Error('GitHub rate limit reached. Try again after it resets, or lower --max.');
      if (e.permanent) throw e;
      // Secondary rate limits and 502s are transient: back off and retry.
      if (attempt < retries) await sleep(2000 * (attempt + 1) * (/secondary|abuse/i.test(msg) ? 4 : 1));
    }
  }
  const err = new Error(`GitHub query failed: ${String(lastErr?.stderr || lastErr?.message).slice(0, 400)}`);
  err.transient = true;
  throw err;
}

export async function repoInfo(owner, name) {
  const d = await graphql(
    `query($o:String!,$n:String!){ rateLimit{remaining resetAt}
      repository(owner:$o,name:$n){ nameWithOwner description url stargazerCount isArchived createdAt
        hasDiscussionsEnabled
        openIssues: issues(states:OPEN){totalCount}
        openPRs: pullRequests(states:OPEN){totalCount}
        labels(first:100){ nodes{ name description } } } }`,
    { o: owner, n: name },
  );
  return d.repository;
}

export async function searchCount(q) {
  const d = await graphql(`query($q:String!){ search(query:$q, type:ISSUE, first:0){ issueCount } }`, { q });
  return d.search.issueCount;
}

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Splits `base` (a search query) into created-date windows of at most `limit` results each.
 * Returns query strings; together they cover every result of `base` exactly once.
 */
export async function shard(base, from, to, limit = 300, depth = 0) {
  const q = `${base} created:${iso(from)}..${iso(to)}`;
  const n = await searchCount(q);
  if (n === 0) return [];
  if (n <= limit || depth > 18 || to - from < 60_000) return [{ q, n }];
  const mid = new Date(Math.floor((from.getTime() + to.getTime()) / 2 / 1000) * 1000);
  const [a, b] = await Promise.all([
    shard(base, from, mid, limit, depth + 1),
    shard(base, new Date(mid.getTime() + 1000), to, limit, depth + 1),
  ]);
  return [...a, ...b];
}

/** Every result of one search query (≤1,000), paged. Halves the page size if GitHub times out. */
export async function fetchSearch(q, kind, { onItems } = {}) {
  const frag = kind === 'pr' ? `... on PullRequest { ${PR_FIELDS} }` : `... on Issue { ${ISSUE_FIELDS} }`;
  let size = kind === 'pr' ? 30 : 50;
  let cursor = null;
  const out = [];
  for (;;) {
    let d;
    try {
      d = await graphql(
        `query($q:String!,$cursor:String){ rateLimit{remaining resetAt}
          search(query:$q, type:ISSUE, first:${size}, after:$cursor){ pageInfo{hasNextPage endCursor} nodes{ ${frag} } } }`,
        { q, cursor },
      );
    } catch (e) {
      if (size > 10 && e.transient) { size = Math.max(10, size >> 1); continue; }
      throw e;
    }
    const nodes = d.search.nodes.filter((x) => x && x.number);
    out.push(...nodes);
    onItems?.(nodes.length);
    if (!d.search.pageInfo.hasNextPage) break;
    cursor = d.search.pageInfo.endCursor;
  }
  return out;
}

/** Runs async jobs with at most `n` in flight. */
export async function pool(jobs, n = 4) {
  const results = new Array(jobs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) {
        const k = i++;
        results[k] = await jobs[k]();
      }
    }),
  );
  return results;
}

/**
 * Finds the oldest "updated" date that keeps the open set at or under `max` items,
 * so a capped fetch keeps the most recently active ones.
 */
export async function updatedCutoff(base, max, from, to) {
  let lo = from.getTime(), hi = to.getTime();
  for (let i = 0; i < 16 && hi - lo > 3_600_000; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const n = await searchCount(`${base} updated:>=${iso(mid)}`);
    if (n > max) lo = mid; else hi = mid;
  }
  return new Date(hi);
}

/** The most-upvoted open issues, so old-but-loved requests are never cut off by --max. */
export async function fetchTopReacted(owner, name, n = 100) {
  const d = await graphql(
    `query($q:String!){ search(query:$q, type:ISSUE, first:${n}){ nodes{ ... on Issue { ${ISSUE_FIELDS} } } } }`,
    { q: `repo:${owner}/${name} is:issue is:open sort:reactions-+1-desc` },
  );
  return d.search.nodes.filter((x) => x && x.number);
}
