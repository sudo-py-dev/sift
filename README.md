# Sift

**Sift the signal from the noise in big GitHub repos.** A Claude Code plugin that reads every open issue and pull request, ranks what deserves a maintainer's time, and gives you a keyboard-first inbox to act on it. You queue the actions; Claude applies them after you confirm.

```
/sift:triage astral-sh/uv      # fetch, score, judge, open the inbox
/sift:apply  astral-sh/uv      # review the queued actions and apply them
```

## The inbox

Three panes: **views** on the left, a dense **ranked list** in the middle, and the **full item** on the right. The detail pane shows:
- Claude's read of the item;
- why the item is in this list;
- urgency, demand and noise meters;
- related duplicates and PRs;
- the description and latest comments.

| View | What's in it |
|---|---|
| **Brief** | Claude's headline on the backlog, what's worth knowing, and the themes that explain most of it. |
| **Urgent** | Severe bugs (crashes, corruption, regressions, security), threads active right now, and problems nobody from the team has answered. |
| **Most wanted** | The requests the most people are asking for. |
| **PRs to review** | Ready to merge, contributors waiting on a first review, small green fixes, competing PRs for the same issue. |
| **Duplicates** | Look-alike groups judged *duplicates*, *related* or *different*, with the one to keep marked. |
| **Noise** | Usage questions, empty reports, stale threads, abandoned PRs, issues labelled invalid but still open. |
| **Watch / Everything** | The rest: searchable and filterable by theme and label. |
| **Queue** | Everything you've queued, the exact `gh` command for each, and a box for instructions to Claude. |

### Keyboard

| | |
|---|---|
| `j` `k` | next / previous |
| `y` | accept Claude's suggestion (you review the text first) |
| `c` | close (not planned / completed, optional comment) |
| `d` | close as duplicate of… |
| `m` | comment (write it, or leave a note and let Claude draft it) |
| `r` | ask for a reproduction |
| `l` | add / remove labels |
| `s` | not noise: keep |
| `w` / `u` | move to Watch / mark urgent |
| `a` / `g` / `n` | PR: approve / merge / nudge the author |
| `x` / `shift+x` | select for bulk actions / select everything shown |
| `z` | undo on this item |
| `o` | open on GitHub |
| `/` `1`–`9` `q` `?` | search, switch views, queue, all shortcuts |

Every action form has a **Note to Claude** field ("check it isn't fixed in the latest release first", "draft a kinder reply that links the docs"). The Queue view takes instructions for the whole batch.

### Applying

The inbox never writes to GitHub. Queued actions are saved to `sift/<owner>__<repo>/decisions.json` (through a small server bound to 127.0.0.1). `/sift:apply` then:

1. shows every pending change with the exact `gh` command, and warns about items that changed since you decided, merges with red CI, and comments still to be drafted;
2. follows your notes, such as drafting replies or checking releases;
3. asks you once to confirm the list;
4. applies exactly what you confirmed. Commands run without a shell, each result is recorded, and the inbox shows them as done.

## How it works

1. **Fetch:** `gh` + GraphQL, read-only. Search is capped at 1,000 results per query, so the repo's history is split into date windows fetched in parallel: about **1.5 minutes for 3,000 items**. Refreshes fetch only what changed, in seconds.
2. **Score:** every item gets readable reasons.
   - **Urgency:** severity, momentum, unanswered threads.
   - **Demand:** reactions and participants.
   - **Noise:** questions, empty templates, staleness, duplicates, abandoned PRs.
   - **PRs:** review state, CI, conflicts, size, wait time, issues they fix.
   - Duplicates are found by TF-IDF clustering.
3. **Judge:** Claude reads only the short lists (about 100 items even on huge repos) and writes a verdict and suggested action for each, plus the brief.
4. **Build:** one self-contained HTML file. Issue text is escaped and the page runs under a strict Content Security Policy.

## Install

Needs Node 18+ and the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`).

```
/plugin marketplace add sudo-py-dev/sift
/plugin install sift@sift
```

Then just ask: *"triage astral-sh/uv"*, *"what in our tracker actually needs attention?"*, *"apply my Sift queue"*.

| Flag | Default | |
|---|---|---|
| `--max` | 2000 | Open issues to analyse (most recently active, plus the 100 most-upvoted of all time). |
| `--max-prs` | 800 | Same for PRs. |
| `--full` | off | Re-fetch from scratch. |

## Files

```
sift/                         ← own .gitignore; nothing here is committed
  <owner>__<repo>/
    index.html                ← the inbox
    decisions.json            ← your queued actions and their results
    brief.json, verdicts/     ← Claude's judgement (editable)
    report.json, .cache/      ← generated
```

## Limits

- Only the latest 6 comments per issue are fetched, so "no maintainer reply" is claimed only on threads short enough to have been read in full.
- "Maintainer" means OWNER/MEMBER/COLLABORATOR. Org members with private membership can look like contributors.
- Two inbox tabs open on the same repo: the last one to save wins.

## Development

```
npm test
```

No dependencies. Tests cover scoring, duplicate detection, the analyze→build pipeline, decision validation, the server's origin and path checks, and `apply` against a fake `gh`.

MIT licensed.
