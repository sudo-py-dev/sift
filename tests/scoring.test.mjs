import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAll } from '../skills/triage/scripts/lib/scoring.mjs';
import { issue, pr, byKey, comment, daysAgo } from './helpers.mjs';

const score = (...items) => {
  const { scores } = scoreAll(byKey(...items));
  return Object.fromEntries(scores.map((s) => [s.key, s]));
};
const has = (s, t) => s.signals.some((g) => g.t.startsWith(t));

test('a severe, unanswered bug lands in the urgent lane', () => {
  const s = score(issue({ number: 1, title: 'Install silently corrupts the cache', labels: ['bug'], participants: 4, reactions: { positive: 6, negative: 0 } }));
  assert.equal(s.i1.bucket, 'attention');
  assert.equal(s.i1.lane, 'urgent');
  assert.ok(has(s.i1, 'sounds severe'));
  assert.ok(has(s.i1, 'no maintainer reply'));
});

test('a heavily upvoted feature request lands in the wanted lane', () => {
  const s = score(issue({ number: 2, title: 'Add a task runner', labels: ['enhancement'], reactions: { positive: 900, negative: 0 }, participants: 80, createdAt: daysAgo(700) }));
  assert.equal(s.i2.bucket, 'attention');
  assert.equal(s.i2.lane, 'wanted');
});

test('"no maintainer reply" is not claimed when older comments were not fetched', () => {
  const s = score(issue({ number: 3, title: 'App crashes on start', participants: 40, reactions: { positive: 50, negative: 0 }, commentCount: 120,
    recentComments: [comment('a', 'NONE', 40), comment('b', 'NONE', 39)] }));
  assert.ok(!has(s.i3, 'no maintainer reply'));
});

test('a maintainer comment counts as a reply', () => {
  const s = score(issue({ number: 4, title: 'Crash on save', participants: 5, reactions: { positive: 10, negative: 0 }, commentCount: 1,
    recentComments: [comment('lead', 'MEMBER', 3)] }));
  assert.ok(!has(s.i4, 'no maintainer reply'));
});

test('usage questions, empty reports and stale threads are noise', () => {
  const s = score(
    issue({ number: 5, title: 'How do I configure the cache?', labels: ['question'] }),
    issue({ number: 6, title: 'broken', body: '', bodyLen: 0, createdAt: daysAgo(400), recentComments: [] }),
    issue({ number: 7, labels: ['invalid'] }),
  );
  for (const k of ['i5', 'i6', 'i7']) assert.equal(s[k].bucket, 'noise', k);
});

test('demand protects an old issue from being called stale', () => {
  const s = score(issue({ number: 8, createdAt: daysAgo(900), reactions: { positive: 40, negative: 0 }, participants: 12 }));
  assert.notEqual(s.i8.bucket, 'noise');
});

test('PRs: ready, contributor waiting, abandoned, bot', () => {
  const s = score(
    pr({ number: 10, reviewDecision: 'APPROVED' }),
    pr({ number: 11, assoc: 'FIRST_TIME_CONTRIBUTOR', createdAt: daysAgo(40) }),
    pr({ number: 12, draft: true, mergeable: 'CONFLICTING', checks: 'FAILURE', lastCommitAt: daysAgo(300), createdAt: daysAgo(320) }),
    pr({ number: 13, author: 'dependabot[bot]', isBot: true }),
  );
  assert.equal(s.p10.status, 'ready');
  assert.equal(s.p10.bucket, 'attention');
  assert.ok(has(s.p11, 'contributor waiting'));
  assert.equal(s.p12.bucket, 'noise');
  assert.equal(s.p13.bucket, 'bots');
});

test('a PR with a maintainer review comment is no longer "unreviewed"', () => {
  const s = score(pr({ number: 14, createdAt: daysAgo(40), recentComments: [comment('lead', 'MEMBER', 30, 'I am not sure about this approach')] }));
  assert.notEqual(s.p14.status, 'unreviewed');
});

test('competing PRs for the same issue are flagged', () => {
  const s = score(issue({ number: 20 }), pr({ number: 21, closesIssues: [20] }), pr({ number: 22, closesIssues: [20] }));
  assert.ok(has(s.p21, 'competes with #22'));
  assert.ok(has(s.p22, 'competes with #21'));
});

test('short lists are capped on huge repos', () => {
  const many = Array.from({ length: 200 }, (_, i) => issue({ number: 5000 + i, title: `Crash number ${i}`, labels: ['bug', 'regression'] }));
  const { scores } = scoreAll(byKey(...many));
  assert.ok(scores.filter((x) => x.bucket === 'attention' && x.lane === 'urgent').length <= 30);
});
