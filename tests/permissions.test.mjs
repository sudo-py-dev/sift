import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, effectiveRole, lockReason, NEEDS, ROLES } from '../skills/triage/scripts/lib/permissions.mjs';

test('each role unlocks exactly the actions GitHub allows it', () => {
  const gh = ['comment', 'needs-repro', 'nudge', 'close', 'duplicate', 'label', 'approve', 'merge'];
  const allowed = (role) => gh.filter((a) => can(role, a));
  assert.deepEqual(allowed('NONE'), []);
  assert.deepEqual(allowed('READ'), ['comment', 'needs-repro', 'nudge']);
  assert.deepEqual(allowed('TRIAGE'), ['comment', 'needs-repro', 'nudge', 'close', 'duplicate', 'label']);
  for (const r of ['WRITE', 'MAINTAIN', 'ADMIN']) assert.deepEqual(allowed(r), gh);
});

test('report-only actions are never locked, unknown actions always are', () => {
  for (const r of ROLES) for (const a of ['keep', 'watch', 'escalate']) assert.ok(can(r, a));
  assert.equal(can('ADMIN', 'delete-repo'), false);
  assert.ok(Object.values(NEEDS).every((n) => ROLES.includes(n)));
});

test('no recorded role locks nothing (apply re-checks live)', () => {
  assert.ok(can(null, 'merge'));
});

test('effective role: archived is read-only for everyone, a null role means public read or private none', () => {
  assert.equal(effectiveRole({ permission: 'ADMIN', archived: true }), 'NONE');
  assert.equal(effectiveRole({ permission: null, isPrivate: false }), 'READ');
  assert.equal(effectiveRole({ permission: null, isPrivate: true }), 'NONE');
  assert.equal(effectiveRole({ permission: 'TRIAGE' }), 'TRIAGE');
  assert.equal(effectiveRole({ permission: 'bogus' }), 'READ');
});

test('lock reasons say what is needed and what the account has', () => {
  assert.equal(lockReason('READ', 'merge'), 'Needs write access; your account has read access.');
  assert.match(lockReason('NONE', 'comment'), /no write access/);
});
