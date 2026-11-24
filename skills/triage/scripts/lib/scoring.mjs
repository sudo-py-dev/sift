// Deterministic signal-vs-noise scoring. Every point comes with a reason a person can read,
// so the report can always answer "why is this here?".
import { daysBetween, fmtDays, MAINTAINER_ASSOC, BOT_RE } from './common.mjs';

export const RX = {
  severeLabel: /(security|vulnerab|cve|crash|regression|data[\s_-]?loss|corrupt|critical|blocker|urgent|p0\b|pri(ority)?[\s:/_-]*(0|1|high|critical)|sev(erity)?[\s:/_-]*(0|1|high|critical)|hotfix)/i,
  severeTitle: /\b(crash(es|ed|ing)?|segfault|panic(s|ked)?|regression|data[\s-]?loss|security|vulnerab\w*|cve-\d|corrupt\w*|deadlock|memory leak|hangs?|freez(e|es|ing)|infinite loop|lost (all|my)|broke(n)? (after|since|in) v?\d)/i,
  bugLabel: /^(type[:/ ]\s*)?(bug|defect|kind\/bug|t-bug|confirmed)\b/i,
  featureLabel: /(enhancement|feature|proposal|idea|request|rfc)/i,
  confirmedLabel: /(confirmed|accepted|triaged|good first issue|help wanted|planned|roadmap|p1|p2)/i,
  hardNoiseLabel: /(^|\W)(invalid|spam|duplicate|wontfix|won'?t[\s-]?fix|not[\s-]?planned|abandoned|off[\s-]?topic)(\W|$)/i,
  softNoiseLabel: /(question|support|usage|how[\s-]?to|needs?[\s-]?(info|repro|reproduction|more[\s-]?info|feedback|author)|awaiting|waiting[\s-]?(for|on)[\s-]?(author|response|reporter)|stale|incomplete|can'?t[\s-]?reproduce|cannot[\s-]?reproduce|unconfirmed|third[\s-]?party|upstream)/i,
  questionTitle: /^(\[?question\]?|how (do|can|to|should)|what('s| is| are)|why (does|is|do)|is (it|there) (possible|a way)|can (i|you|we)|does .+\?)|\?\s*$/i,
  bump: /^\s*(\+1|same( here| issue| problem)?|me too|any (update|news|progress|eta)s?|bump|still (happening|an issue|broken)|👍|any update on this)[\s!.?]*$/i,
};

const log = (x, top) => Math.min(1, Math.log10(1 + x) / Math.log10(1 + top));

function collectMaintainers(items) {
  const m = new Set();
  for (const it of items) {
    if (MAINTAINER_ASSOC.has(it.assoc)) m.add(it.author);
    for (const c of it.recentComments || []) if (MAINTAINER_ASSOC.has(c.assoc)) m.add(c.author);
    for (const r of it.reviews || []) if (MAINTAINER_ASSOC.has(r.assoc)) m.add(r.author);
  }
  return m;
}

const isMaint = (maint, login, assoc) => MAINTAINER_ASSOC.has(assoc) || maint.has(login);

function common(it, ctx) {
  const now = ctx.now;
  const s = [];
  const comments = it.recentComments || [];
  const lastComment = comments[comments.length - 1];
  const lastActivityAt = lastComment?.at && lastComment.at > it.createdAt ? lastComment.at : it.createdAt;
  const age = daysBetween(it.createdAt, now);
  const idle = daysBetween(lastActivityAt, now);
  const maintComments = comments.filter((c) => isMaint(ctx.maint, c.author, c.assoc) && !BOT_RE.test(c.author));
  const lastMaintAt = maintComments.length ? maintComments[maintComments.length - 1].at : null;
  const byMaint = isMaint(ctx.maint, it.author, it.assoc);
  const touched = byMaint || maintComments.length > 0 || it.assignees.length > 0 || !!it.milestone;
  const recent14 = comments.filter((c) => daysBetween(c.at, now) <= 14 && !BOT_RE.test(c.author)).length;
  const bumps = comments.filter((c) => RX.bump.test(c.body)).length;
  const labels = it.labels.join(' | ');
  return { s, age, idle, lastActivityAt, lastMaintAt, touched, byMaint, recent14, bumps, labels, comments };
}

export function scoreIssue(it, ctx) {
  const c = common(it, ctx);
  const { s } = c;
  const r = it.reactions;
  // Two separate questions: is it urgent (severity, momentum, nobody answering), and is it wanted (demand)?
  let urgency = 0;
  let demand = 0;
  let noise = 0;

  demand += 32 * log(r.positive, 1000);
  if (r.positive >= 5) s.push({ t: `${r.positive} 👍`, tone: 'hot', why: `${r.positive} people reacted in support` });
  demand += 14 * log(it.participants, 60);
  if (it.participants >= 5) s.push({ t: `${it.participants} people`, tone: 'hot', why: `${it.participants} people took part in the thread` });

  if (c.recent14 >= 2) {
    urgency += Math.min(16, c.recent14 * 4);
    s.push({ t: 'active now', tone: 'hot', why: `${c.recent14} comments in the last two weeks` });
  }
  if (c.age <= 21 && r.positive >= 5) {
    urgency += 10;
    s.push({ t: 'rising fast', tone: 'hot', why: `${r.positive} reactions within ${fmtDays(c.age)}` });
  }

  const severeL = RX.severeLabel.test(c.labels);
  const severeT = RX.severeTitle.test(it.title);
  const bug = it.labels.some((l) => RX.bugLabel.test(l));
  if (severeL) { urgency += 26; s.push({ t: 'severe label', tone: 'warn', why: 'Labelled as security, crash, regression, data loss or top priority' }); }
  else if (severeT) { urgency += 15; s.push({ t: 'sounds severe', tone: 'warn', why: 'Title mentions a crash, hang, regression, data loss or security problem' }); }
  if (bug) urgency += 6;
  if (it.labels.some((l) => RX.confirmedLabel.test(l))) { urgency += 4; s.push({ t: 'confirmed', tone: 'info', why: 'Maintainers labelled it confirmed, triaged or planned' }); }
  // Bugs that many people hit are urgent, not just wanted.
  if (bug || severeL || severeT) urgency += 0.5 * demand;

  // We only see the latest comments, so "never answered" is only claimed when the whole thread was fetched.
  const sawAll = it.commentCount <= c.comments.length;
  const traction = r.positive >= 5 || it.participants >= 4 || severeL || severeT;
  if (!c.touched && traction && c.age > 3) {
    if (sawAll) {
      urgency += 14;
      s.push({ t: 'no maintainer reply', tone: 'warn', why: `Open ${fmtDays(c.age)} with real interest and no reply, assignee or milestone from the team` });
    } else if (c.recent14 >= 1) {
      urgency += 6;
      s.push({ t: 'no recent team reply', tone: 'warn', why: `None of the last ${c.comments.length} comments are from the team, and people are still posting` });
    }
  } else if (!c.touched && sawAll && c.age > 30 && !it.isBot) {
    s.push({ t: 'never triaged', tone: 'info', why: `No maintainer has touched it in ${fmtDays(c.age)}` });
  }
  if (c.lastMaintAt && daysBetween(c.lastMaintAt, ctx.now) > 60 && c.recent14 >= 2) {
    urgency += 5;
    s.push({ t: 'users still waiting', tone: 'warn', why: `Last maintainer comment ${fmtDays(daysBetween(c.lastMaintAt, ctx.now))} ago, users still active` });
  }

  if (it.linkedPRs?.length) {
    urgency -= 8;
    s.push({ t: `fix in PR #${it.linkedPRs[0]}`, tone: 'good', why: 'An open pull request says it will close this' });
  }
  if (c.bumps >= 2) s.push({ t: `${c.bumps} “+1” comments`, tone: 'info', why: 'Recent comments are mostly “+1 / any update?”: demand, but no new information' });
  if (it.assignees.length) s.push({ t: `@${it.assignees[0]}`, tone: 'info', why: `Assigned to ${it.assignees.join(', ')}` });

  // Noise.
  if (RX.hardNoiseLabel.test(c.labels)) { noise += 55; s.push({ t: 'closing label', tone: 'noise', why: 'Labelled invalid, duplicate, wontfix or spam but still open' }); }
  else if (RX.softNoiseLabel.test(c.labels)) {
    const waiting = /needs?|awaiting|waiting|incomplete|reproduc/i.test(c.labels);
    noise += waiting ? (c.idle > 30 ? 40 : 22) : 28;
    s.push({ t: waiting ? 'waiting on reporter' : 'support / question', tone: 'noise', why: waiting ? `Waiting for the reporter; quiet for ${fmtDays(c.idle)}` : 'Labelled as a question or support request' });
  }
  if (!bug && !severeL && RX.questionTitle.test(it.title) && !it.labels.some((l) => RX.featureLabel.test(l))) {
    noise += 18;
    s.push({ t: 'reads like a question', tone: 'noise', why: 'Title is phrased as a usage question; may belong in Discussions' });
  }
  if (it.bodyLen < 40 && !it.hasCode) { noise += it.bodyLen < 10 ? 26 : 16; s.push({ t: 'almost empty', tone: 'noise', why: 'The description has almost nothing beyond the template' }); }
  const lowDemand = r.positive < 5 && it.participants < 4;
  if (c.idle > 365 && lowDemand) { noise += 30; s.push({ t: `quiet ${fmtDays(c.idle)}`, tone: 'noise', why: 'No activity for over a year and little interest' }); }
  else if (c.idle > 180 && lowDemand) { noise += 18; s.push({ t: `quiet ${fmtDays(c.idle)}`, tone: 'noise', why: 'No activity for over six months and little interest' }); }
  if (r.negative > r.positive && r.negative >= 3) { noise += 10; s.push({ t: 'mostly 👎', tone: 'noise', why: 'More negative than positive reactions' }); }
  if (it.isBot) { noise += 8; s.push({ t: 'bot', tone: 'info', why: `Opened by ${it.author}` }); }

  const dupe = ctx.dupeOf?.get(it.key);
  if (dupe) {
    noise += 40;
    s.push({ t: `dup of #${dupe.number}?`, tone: 'noise', why: `Very similar to #${dupe.number}, which has more support (${Math.round(dupe.sim * 100)}% match)` });
  } else if (ctx.dupeCanonical?.has(it.key)) {
    s.push({ t: `${ctx.dupeCanonical.get(it.key)} similar`, tone: 'info', why: 'Other open issues look like duplicates of this one' });
    demand += Math.min(8, ctx.dupeCanonical.get(it.key) * 2);
  }

  noise = Math.min(100, noise);
  const penalty = noise * 0.45;
  urgency = clamp(urgency - penalty);
  demand = clamp(demand - penalty);
  const res = finish(it, c, Math.max(urgency, demand), noise, s);
  res.urgency = Math.round(urgency);
  res.demand = Math.round(demand);
  res.lane = urgency >= demand ? 'urgent' : 'wanted';
  return res;
}

const clamp = (x) => Math.max(0, Math.min(100, x));

export function scorePR(it, ctx) {
  const c = common(it, ctx);
  const { s } = c;
  let attention = 0;
  let noise = 0;
  const size = (it.additions || 0) + (it.deletions || 0);
  const external = !c.byMaint && !it.isBot;
  const maintReviews = (it.reviews || []).filter((r) => isMaint(ctx.maint, r.author, r.assoc));
  const lastPush = daysBetween(it.lastCommitAt || it.createdAt, ctx.now);
  const sinceUpdate = Math.min(c.idle, lastPush);
  const green = it.checks === 'SUCCESS' || it.checks === 'NONE';
  const failing = it.checks === 'FAILURE' || it.checks === 'ERROR';
  const conflicts = it.mergeable === 'CONFLICTING';

  let status = 'open';
  if (it.isBot) status = 'bot';
  else if (it.draft) status = 'draft';
  else if (it.reviewDecision === 'APPROVED' && green && !conflicts) status = 'ready';
  else if (it.reviewDecision === 'CHANGES_REQUESTED') status = 'changes';
  else if (!maintReviews.length && !c.comments.some((x) => isMaint(ctx.maint, x.author, x.assoc) && !BOT_RE.test(x.author))) status = 'unreviewed';

  if (status === 'ready') { attention += 40; s.push({ t: 'ready to merge', tone: 'good', why: 'Approved, checks passing, no conflicts' }); }
  if (status === 'unreviewed' && green && !conflicts) {
    const wait = daysBetween(it.createdAt, ctx.now);
    attention += external ? 18 + Math.min(12, wait / 3) : 10;
    if (external && wait > 7) s.push({ t: `contributor waiting ${fmtDays(wait)}`, tone: 'warn', why: `${it.author} (${(it.assoc || '').toLowerCase().replace(/_/g, ' ')}) has had no review from the team` });
    else s.push({ t: 'needs review', tone: 'info', why: 'No review from the team yet' });
  }
  if (it.assoc === 'FIRST_TIME_CONTRIBUTOR' || it.assoc === 'FIRST_TIMER') s.push({ t: 'first-timer', tone: 'info', why: 'First contribution to this repo' });

  // Links to the issues it fixes carry their weight over.
  const fixes = (it.closesIssues || []).map((n) => ctx.issueScore?.get(`i${n}`)).filter(Boolean);
  if (fixes.length) {
    const best = Math.max(...fixes.map((f) => f.attention));
    attention += Math.min(25, best * 0.4);
    s.push({ t: `fixes #${it.closesIssues[0]}${it.closesIssues.length > 1 ? ` +${it.closesIssues.length - 1}` : ''}`, tone: best > 35 ? 'hot' : 'info', why: `Closes ${it.closesIssues.map((n) => '#' + n).join(', ')}` });
  }
  for (const n of it.closesIssues || []) {
    const others = (ctx.competing?.get(n) || []).filter((x) => x !== it.number);
    if (others.length) { s.push({ t: `competes with #${others[0]}${others.length > 1 ? ` +${others.length - 1}` : ''}`, tone: 'warn', why: `Other open PRs also close #${n}: ${others.map((x) => '#' + x).join(', ')}. Pick one.` }); break; }
  }
  attention += 20 * log(it.reactions.positive, 200);
  if (it.reactions.positive >= 5) s.push({ t: `${it.reactions.positive} 👍`, tone: 'hot', why: 'People want this merged' });
  if (size > 0 && size <= 60) { attention += 8; s.push({ t: `small (${size} lines)`, tone: 'good', why: 'Quick to review' }); }
  else if (size > 2000) s.push({ t: `large (${size.toLocaleString()} lines)`, tone: 'info', why: `${it.changedFiles} files changed` });
  if (RX.severeLabel.test(c.labels) || RX.severeTitle.test(it.title)) { attention += 12; s.push({ t: 'severe fix', tone: 'warn', why: 'Fixes a crash, regression or security problem' }); }

  if (failing) { s.push({ t: 'checks failing', tone: 'noise', why: 'CI is red' }); noise += sinceUpdate > 30 ? 25 : 6; }
  if (conflicts) { s.push({ t: 'conflicts', tone: 'noise', why: 'Has merge conflicts with the base branch' }); noise += sinceUpdate > 30 ? 20 : 5; }
  if (status === 'changes' && sinceUpdate > 30) { noise += 30; s.push({ t: 'author went quiet', tone: 'noise', why: `Changes were requested; nothing new for ${fmtDays(sinceUpdate)}` }); }
  if (status === 'draft' && sinceUpdate > 60) { noise += 30; s.push({ t: `stale draft`, tone: 'noise', why: `Draft untouched for ${fmtDays(sinceUpdate)}` }); }
  if (sinceUpdate > 180) { noise += 30; s.push({ t: `quiet ${fmtDays(sinceUpdate)}`, tone: 'noise', why: 'Nothing has happened for over six months' }); }
  if (it.bodyLen < 15 && !it.closesIssues?.length && external) { noise += 10; s.push({ t: 'no description', tone: 'noise', why: 'No description and no linked issue' }); }
  if (it.isBot) s.push({ t: it.author.replace(/\[bot\]$/, ''), tone: 'info', why: 'Automated dependency or maintenance PR' });
  else if (c.byMaint) s.push({ t: 'team PR', tone: 'info', why: `Opened by ${it.author}, a maintainer: closing or finishing it is the team's own call` });

  noise = Math.min(100, noise);
  attention = Math.max(0, Math.min(100, attention - noise * 0.45));
  const res = finish(it, c, attention, noise, s);
  res.status = status;
  res.size = size;
  return res;
}

function finish(it, c, attention, noise, signals) {
  return {
    key: it.key,
    attention: Math.round(attention),
    noise: Math.round(noise),
    age: Math.round(c.age),
    idle: Math.round(c.idle),
    lastActivityAt: c.lastActivityAt,
    touched: c.touched,
    signals,
  };
}

/**
 * Puts items in buckets. Each short list is capped so a 10k-issue repo still yields lists a person can read.
 * Issues: "urgent" (severity, momentum, unanswered) and "wanted" (demand) are ranked separately.
 */
export function bucketize(scored, { urgentCap = 30, wantedCap = 25, prCap = 30 } = {}) {
  const issues = scored.filter((x) => x.kind === 'issue');
  const prs = scored.filter((x) => x.kind === 'pr');
  for (const x of issues) {
    if (x.noise >= 45) x.bucket = 'noise';
    else if (x.urgency >= 26) { x.bucket = 'attention'; x.lane = 'urgent'; }
    else if (x.demand >= 30) { x.bucket = 'attention'; x.lane = 'wanted'; }
    else x.bucket = x.attention >= 16 ? 'watch' : 'backlog';
  }
  for (const x of prs) {
    x.lane = 'review';
    if (x.status === 'bot') x.bucket = 'bots';
    else if (x.noise >= 45) x.bucket = 'noise';
    else if (x.status === 'ready') x.bucket = 'attention';
    else x.bucket = x.attention >= 30 ? 'attention' : x.attention >= 15 ? 'watch' : 'backlog';
  }
  const demote = (list, cap, by) => {
    list.sort((a, b) => by(b) - by(a)).slice(cap).forEach((x) => (x.bucket = 'watch'));
  };
  demote(issues.filter((x) => x.bucket === 'attention' && x.lane === 'urgent'), urgentCap, (x) => x.urgency);
  demote(issues.filter((x) => x.bucket === 'attention' && x.lane === 'wanted'), wantedCap, (x) => x.demand);
  demote(prs.filter((x) => x.bucket === 'attention'), prCap, (x) => x.attention);
  return scored;
}

export function scoreAll(items, { now = new Date().toISOString(), dupes } = {}) {
  const list = Object.values(items);
  const ctx = { now, maint: collectMaintainers(list), dupeOf: new Map(), dupeCanonical: new Map() };
  if (dupes) {
    // In each cluster the most-supported issue is the one to keep; the rest point at it.
    for (const cl of dupes.clusters) {
      const members = cl.map((k) => items[k]).filter(Boolean).sort((a, b) => b.reactions.positive + b.participants - (a.reactions.positive + a.participants) || a.number - b.number);
      const canon = members[0];
      ctx.dupeCanonical.set(canon.key, members.length - 1);
      for (const m of members.slice(1)) {
        const sim = dupes.pairs.get(m.key)?.find((p) => p.other === canon.key)?.sim ?? dupes.pairs.get(m.key)?.[0]?.sim ?? 0;
        // Only call it a duplicate when this one is clearly the weaker copy.
        if (m.reactions.positive <= Math.max(3, canon.reactions.positive)) ctx.dupeOf.set(m.key, { number: canon.number, sim });
      }
    }
  }
  const issueScores = list.filter((x) => x.kind === 'issue').map((it) => ({ ...scoreIssue(it, ctx), kind: 'issue' }));
  ctx.issueScore = new Map(issueScores.map((x) => [x.key, x]));
  // Several open PRs closing the same issue: someone has to pick one.
  const fixers = new Map();
  for (const pr of list.filter((x) => x.kind === 'pr' && !x.isBot)) for (const n of pr.closesIssues || []) fixers.set(n, [...(fixers.get(n) || []), pr.number]);
  ctx.competing = fixers;
  const prScores = list.filter((x) => x.kind === 'pr').map((it) => ({ ...scorePR(it, ctx), kind: 'pr' }));
  return { scores: bucketize([...issueScores, ...prScores]), maintainers: [...ctx.maint], dupeOf: ctx.dupeOf };
}
