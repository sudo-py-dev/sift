# Sift

**Sift the signal from the noise in big GitHub repos.** A Claude Code plugin that reads every open issue and pull request, ranks what deserves a maintainer's time, and gives you a keyboard-first inbox to act on it. You queue the actions; Claude applies them after you confirm.

```
/sift:triage astral-sh/uv      # fetch, score, judge, open the inbox
/sift:apply  astral-sh/uv      # review the queued actions and apply them
```

**Quick install** (needs Node 18+ and `gh auth login`; full steps in [Install](#install)):

```
/plugin marketplace add sudo-py-dev/sift
/plugin install sift@sift
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
| **Overview** | Claude's headline; counts that open their list (urgent, no team reply, contributors waiting, ready to merge, quick wins, noise); the top issues and PRs that need you, each with Claude's one-line read; what's worth knowing; and the themes that explain most of the backlog. |
| **Needs you: Urgent issues** | Severe bugs (crashes, corruption, regressions, security), threads active right now, and problems nobody from the team has answered. |
| **Needs you: PRs to review** | Ready to merge, contributors waiting on a first review, small green fixes, competing PRs for the same issue. |
| **Needs you: Most wanted** | The requests the most people are asking for. |
| **You may have missed: No team reply** | Every issue nobody from the team has answered yet (not only the short list), most pressing first. |
| **You may have missed: Contributors waiting** | Outside PRs with no review from the team, longest wait first among equals. |
| **Clean up: Quick wins** | Items Claude has already decided: closes, repro requests, nudges and merges that take one `y` each. |
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

### 1. Requirements

| | Check | Get it |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| Node.js 18 or newer | `node --version` | [nodejs.org](https://nodejs.org/) |
| GitHub CLI, signed in | `gh auth status` | [cli.github.com](https://cli.github.com/), then `gh auth login` |

Sift reads GitHub through your own `gh` sign-in, so it can see any repo you can see, private ones included. To apply actions (close, label, merge…) your account needs triage or write access to that repo.

### 2. Install the plugin

**Inside Claude Code**, run these one at a time:

```
/plugin marketplace add sudo-py-dev/sift
```

```
/plugin install sift@sift
```

**Or from your terminal:**

```bash
claude plugin marketplace add sudo-py-dev/sift
```

```bash
claude plugin install sift@sift
```

Restart Claude Code (or start a new session) so the skills load.

### 3. Check it worked

```bash
claude plugin list
```

`sift@sift` should be listed as enabled. In Claude Code, typing `/sift` should suggest `/sift:triage` and `/sift:apply`.

### 4. First run

Open Claude Code in any folder (the report is written to `./sift/` there, with its own `.gitignore`) and run:

```
/sift:triage owner/repo
```

Or just ask in plain words: *"triage astral-sh/uv"*, *"what in our tracker actually needs attention?"*. Claude fetches, scores and judges the repo, then opens the inbox in your browser. On a big repo the first run takes a few minutes. When you've queued actions, run `/sift:apply owner/repo` or say *"apply my Sift queue"*.

### Update, disable, remove

```bash
claude plugin marketplace update sift
```

```bash
claude plugin update sift@sift
```

```bash
claude plugin disable sift@sift
```

```bash
claude plugin uninstall sift@sift
```

```bash
claude plugin marketplace remove sift
```

### Install from a local clone (to hack on it)

```bash
git clone https://github.com/sudo-py-dev/sift.git
```

```bash
claude plugin marketplace add ./sift
```

```bash
claude plugin install sift@sift
```

Changes to the clone take effect after `claude plugin marketplace update sift` and a new session.

### Troubleshooting

| Problem | Fix |
|---|---|
| “The GitHub CLI (gh) is not signed in” | Run `gh auth login`. |
| “Repository not found” | Check the spelling, and that `gh repo view owner/repo` works for your account. |
| Rate limit reached | Wait for the hourly reset, or fetch less with `--max 1000`. |
| The inbox opens but actions don't save | Open it through the URL that `open.mjs` prints (`http://127.0.0.1:…`), not as a file. As a file, use **Copy for Claude** in the Queue view. |
| Can't open the inbox on a remote machine | On a machine with a browser, run `node <plugin>/skills/triage/scripts/serve.mjs` from the folder that holds `sift/`. |

### Options

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

## Security

Sift reads text written by strangers and puts it in front of Claude and your browser, so it's built so that text can't take control of either:

- **Prompt injection.**
  - Issue text is cleaned of invisible characters and HTML comments, then fenced in worksheets with a random-id boundary it can't close.
  - Text aimed at AI tools is flagged: overrides, fake system or chat tags, fake approval, requests for secrets, lookalike-letter tricks.
  - Claude's own verdicts are linted before they can become a comment.
  - Nothing reaches GitHub without your confirmation in chat.
- **Code injection.**
  - The inbox never parses text as HTML, and a strict CSP blocks outside requests.
  - `gh` runs with argument arrays, never a shell.
  - The local server rejects other origins and framing.
- **Supply chain.** No dependencies, hooks or MCP servers. CI runs with a read-only token, its actions are pinned to commit SHAs, and every change must keep the security tests green.

The test suite includes a corpus of modern injection payloads (ChatML/`[INST]` templates, fake tool calls, forged fences, homoglyphs, Unicode tag smuggling, hidden comments, fake authority, secret exfiltration) plus real-world benign text that must not trip the detector. `evals/` holds behavioural cases you can run against Claude:

```bash
claude plugin eval . --tag security
```

See [SECURITY.md](SECURITY.md) for the full model and how to report a vulnerability.

## Limits

- Only the latest 6 comments per issue are fetched, so "no maintainer reply" is claimed only on threads short enough to have been read in full.
- "Maintainer" means OWNER/MEMBER/COLLABORATOR. Org members with private membership can look like contributors.
- Two inbox tabs open on the same repo: the last one to save wins.

## Development

```
npm test
```

No dependencies. Tests cover scoring, duplicate detection, the analyze→build pipeline, decision validation, the server's origin and path checks, `apply` against a fake `gh`, the injection corpus, and the security invariants CI enforces.

MIT licensed.
