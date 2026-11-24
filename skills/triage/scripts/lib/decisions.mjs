// The actions a person can queue in the inbox, how they're validated, and the exact gh command each becomes.
// Commands are argument arrays (run without a shell), so issue text can never be interpreted as shell.

export const ACTIONS = {
  issue: {
    close: { label: 'Close', gh: true },
    duplicate: { label: 'Close as duplicate', gh: true },
    comment: { label: 'Comment', gh: true },
    'needs-repro': { label: 'Ask for a reproduction', gh: true },
    label: { label: 'Edit labels', gh: true },
    keep: { label: 'Not noise: keep', gh: false },
    watch: { label: 'Move to Watch', gh: false },
    escalate: { label: 'Mark urgent', gh: false },
  },
  pr: {
    merge: { label: 'Merge', gh: true },
    approve: { label: 'Approve', gh: true },
    close: { label: 'Close', gh: true },
    comment: { label: 'Comment', gh: true },
    nudge: { label: 'Nudge the author', gh: true },
    label: { label: 'Edit labels', gh: true },
    keep: { label: 'Not noise: keep', gh: false },
    watch: { label: 'Move to Watch', gh: false },
  },
};

export const DEFAULT_TEXT = {
  'needs-repro': 'Thanks for the report. Could you share a minimal reproduction, the exact version you are using, and your OS? We will take another look once we can reproduce it.',
  nudge: 'Are you still working on this? It needs a rebase and green checks before it can be reviewed. Let us know if you would like someone else to pick it up.',
  stale: 'Closing as stale. Please open a new issue if this still affects you on the latest version.',
};

const STATUSES = new Set(['pending', 'done', 'failed', 'skipped']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Cleans what the browser sends. Returns { value, errors }. */
export function validateDecisions(body, repo) {
  const errors = [];
  if (!body || typeof body !== 'object' || typeof body.decisions !== 'object' || Array.isArray(body.decisions)) return { value: null, errors: ['expected { decisions: {...} }'] };
  const out = { repo: repo || str(body.repo, 200), updatedAt: new Date().toISOString(), instructions: str(body.instructions, 4000), decisions: {} };
  const entries = Object.entries(body.decisions);
  if (entries.length > 5000) errors.push('too many decisions');
  for (const [key, d] of entries.slice(0, 5000)) {
    const m = /^([ip])(\d{1,9})$/.exec(key);
    if (!m || !d || typeof d !== 'object') { errors.push(`${key}: bad key`); continue; }
    const kind = m[1] === 'p' ? 'pr' : 'issue';
    if (!ACTIONS[kind][d.action]) { errors.push(`${key}: "${d.action}" is not an action for ${kind === 'pr' ? 'pull requests' : 'issues'}`); continue; }
    const v = { action: d.action, kind, number: Number(m[2]), title: str(d.title, 300), note: str(d.note, 2000), at: str(d.at, 40) || new Date().toISOString(), status: STATUSES.has(d.status) ? d.status : 'pending' };
    if (d.result) v.result = str(d.result, 1000);
    if (d.action === 'close') v.reason = d.reason === 'completed' ? 'completed' : 'not planned';
    if (['close', 'duplicate', 'comment', 'needs-repro', 'nudge', 'approve'].includes(d.action)) v.text = str(d.text, 5000);
    if (d.action === 'comment' && !v.text.trim()) {
      // A comment may be left for Claude to draft from the note; it is never sent until the text exists.
      if (!v.note.trim()) { errors.push(`${key}: a comment needs text or a note asking Claude to draft it`); continue; }
      v.needsDraft = true;
    }
    if (d.action === 'duplicate') {
      v.of = Number(d.of);
      if (!Number.isInteger(v.of) || v.of <= 0 || v.of === v.number) { errors.push(`${key}: duplicate needs the issue number to keep`); continue; }
    }
    if (d.action === 'merge') v.method = ['merge', 'rebase'].includes(d.method) ? d.method : 'squash';
    if (d.action === 'label') {
      const clean = (a) => (Array.isArray(a) ? a : []).map((x) => str(x, 50).trim()).filter(Boolean).slice(0, 20);
      v.add = clean(d.add);
      v.remove = clean(d.remove);
      if (!v.add.length && !v.remove.length) { errors.push(`${key}: no labels to add or remove`); continue; }
    }
    out.decisions[key] = v;
  }
  return { value: out, errors };
}

/** gh argv for one decision; null for report-only actions; undefined when the text still has to be drafted. */
export function command(d, repo) {
  const n = String(d.number);
  const R = ['-R', repo];
  const t = d.text?.trim();
  const isPR = d.kind === 'pr';
  switch (d.action) {
    case 'close':
      return isPR ? ['pr', 'close', n, ...R, ...(t ? ['--comment', t] : [])] : ['issue', 'close', n, ...R, '--reason', d.reason || 'not planned', ...(t ? ['--comment', t] : [])];
    case 'duplicate':
      return ['issue', 'close', n, ...R, '--reason', 'not planned', '--comment', `Duplicate of #${d.of}${t ? `\n\n${t}` : ''}`];
    case 'comment':
      if (!t) return undefined; // still needs drafting
      return [isPR ? 'pr' : 'issue', 'comment', n, ...R, '--body', t];
    case 'needs-repro':
      return ['issue', 'comment', n, ...R, '--body', t || DEFAULT_TEXT['needs-repro']];
    case 'nudge':
      return ['pr', 'comment', n, ...R, '--body', t || DEFAULT_TEXT.nudge];
    case 'label':
      return [isPR ? 'pr' : 'issue', 'edit', n, ...R, ...(d.add?.length ? ['--add-label', d.add.join(',')] : []), ...(d.remove?.length ? ['--remove-label', d.remove.join(',')] : [])];
    case 'merge':
      return ['pr', 'merge', n, ...R, `--${d.method || 'squash'}`];
    case 'approve':
      return ['pr', 'review', n, ...R, '--approve', ...(t ? ['--body', t] : [])];
    default:
      return null;
  }
}

export const shellQuote = (argv) => ['gh', ...argv].map((a) => (/^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
