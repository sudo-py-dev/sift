// What the signed-in user may do on a repository, and which queued actions that allows.
// GitHub's repository roles, lowest to highest. `viewerPermission` (GraphQL) returns one of the last five.
// Used by fetch (records the role), build/viewer (locks actions), serve (refuses to save them) and
// plan/apply (warn, then re-check live before anything is sent).

export const ROLES = ['NONE', 'READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'];

/** Minimum role per inbox action. Report-only actions (keep, watch, escalate) change nothing on GitHub. */
export const NEEDS = {
  comment: 'READ',
  'needs-repro': 'READ',
  nudge: 'READ',
  close: 'TRIAGE',
  duplicate: 'TRIAGE',
  label: 'TRIAGE',
  approve: 'WRITE', // anyone can approve, but only a write-access approval counts toward merging
  merge: 'WRITE',
  keep: 'NONE',
  watch: 'NONE',
  escalate: 'NONE',
};

const rank = (r) => ROLES.indexOf(r);

/**
 * The role to act with. `viewerPermission` is null for some public repos you have no role on: that is
 * read access (you can comment). An archived repository is read-only for everyone.
 */
export function effectiveRole({ permission, isPrivate = false, archived = false } = {}) {
  if (archived) return 'NONE'; // archived: nothing can be changed, not even with a comment
  return ROLES.includes(permission) ? permission : isPrivate ? 'NONE' : 'READ';
}

/** True when `role` may take `action`. An unknown role (an old report) allows everything: apply re-checks live. */
export function can(role, action) {
  if (!role) return true;
  const need = NEEDS[action];
  if (!need) return false;
  return rank(role) >= rank(need);
}

/** Plain-language explanation for a locked action. */
export function lockReason(role, action) {
  const need = NEEDS[action] || 'WRITE';
  if (role === 'NONE') return 'You have no write access to this repository (or it is archived).';
  return `Needs ${need.toLowerCase()} access; your account has ${String(role).toLowerCase()} access.`;
}

export const roleLabel = (role) => ({ NONE: 'no access', READ: 'read', TRIAGE: 'triage', WRITE: 'write', MAINTAIN: 'maintain', ADMIN: 'admin' })[role] || 'unknown';
