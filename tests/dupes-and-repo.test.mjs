import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, tokens } from '../skills/triage/scripts/lib/dupes.mjs';
import { parseRepo, meaningfulText } from '../skills/triage/scripts/lib/common.mjs';

const filler = Array.from({ length: 40 }, (_, i) => ({ key: `f${i}`, title: `Unrelated topic ${['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]} widget ${i} renderer` }));

test('near-identical issues cluster, unrelated ones do not', () => {
  const docs = [
    { key: 'a', title: 'uv self update ignores required-version setting', body: 'self update installs latest even with required-version' },
    { key: 'b', title: '`uv self update` should respect the required-version setting', body: 'required-version in pyproject is ignored by self update' },
    { key: 'c', title: 'Support Conda environments', body: 'manage conda packages' },
    ...filler,
  ];
  const { clusters } = findDuplicates(docs);
  const ab = clusters.find((c) => c.includes('a'));
  assert.ok(ab && ab.includes('b'), 'a and b should cluster');
  assert.ok(!clusters.some((c) => c.includes('c')));
});

test('tokens drop stopwords, urls and code blocks', () => {
  const t = tokens('How do I use the cache? see https://x.y/z ```rm -rf /```');
  assert.ok(!t.includes('how') && !t.includes('https') && !t.includes('rm'));
  assert.ok(t.includes('cache'));
});

test('parseRepo accepts slugs and URLs', () => {
  assert.equal(parseRepo('astral-sh/uv').slug, 'astral-sh/uv');
  assert.equal(parseRepo('https://github.com/astral-sh/uv').slug, 'astral-sh/uv');
  assert.equal(parseRepo('git@github.com:astral-sh/uv.git').slug, 'astral-sh/uv');
  assert.equal(parseRepo('nope'), null);
});

test('meaningfulText ignores template scaffolding', () => {
  const body = '<!-- Please describe -->\n### Summary\n\n_No response_\n\n- [ ] I searched existing issues';
  assert.equal(meaningfulText(body), '');
});
