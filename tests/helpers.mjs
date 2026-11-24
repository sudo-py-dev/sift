// Builds fake normalized items the way fetch.mjs stores them.
const NOW = Date.now();
export const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

let n = 1000;
export function issue(over = {}) {
  const number = over.number ?? n++;
  return {
    key: `i${number}`, kind: 'issue', number, title: 'Something is wrong with the resolver', url: `https://github.com/o/r/issues/${number}`,
    state: 'OPEN', author: 'someone', assoc: 'NONE', isBot: false,
    createdAt: daysAgo(30), updatedAt: daysAgo(2), labels: [], assignees: [], milestone: null,
    reactions: { up: 0, down: 0, positive: 0, negative: 0 }, participants: 1, commentCount: 0, recentComments: [],
    body: 'Steps to reproduce: run the command with these flags and it fails with an error message.', bodyLen: 90, hasCode: false, linkedPRs: [],
    ...over,
  };
}

export function pr(over = {}) {
  const number = over.number ?? n++;
  return {
    ...issue({ number }),
    key: `p${number}`, kind: 'pr', url: `https://github.com/o/r/pull/${number}`, title: 'Fix a thing',
    draft: false, additions: 20, deletions: 5, changedFiles: 1, mergeable: 'MERGEABLE', reviewDecision: null,
    reviewRequests: 0, reviews: [], checks: 'SUCCESS', lastCommitAt: daysAgo(20), closesIssues: [], base: 'main',
    ...over,
  };
}

export const byKey = (...items) => Object.fromEntries(items.map((x) => [x.key, x]));
export const comment = (author, assoc, days, body = 'some text') => ({ author, assoc, at: daysAgo(days), body });
