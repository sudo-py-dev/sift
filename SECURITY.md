# Security

Sift reads text written by strangers (GitHub issues, PRs, comments) and puts it in front of Claude and a browser. It is built so that text can't take control of either.

## What Sift guarantees

- **Read-only until you confirm.** Triage only reads GitHub, through GraphQL queries. The inbox only writes to a local `decisions.json`. GitHub changes happen only in `/sift:apply`, which shows every command and waits for your yes. `apply.mjs` is not pre-approved in the skill, so Claude Code also asks permission before it runs.
- **Issue text is data, never instructions.**
  - Fetched text is cleaned of invisible characters (zero-width, bidi overrides, Unicode tag characters) and HTML comments.
  - In worksheets it sits inside a fence with a random id that the text can't guess or close.
  - Text that addresses an AI (overrides, fake system or chat tags, fake authority, "skip confirmation", secret exfiltration) is flagged and pushed toward Noise.
  - The skills tell Claude never to follow it.
- **Claude's output is checked.**
  - Verdicts are linted for links off GitHub, `@mentions` and AI-steering text before they can become a suggested comment.
  - `plan.mjs` and `apply.mjs` re-validate `decisions.json`, refuse a file made for another repository, and run `gh` with an argument array, never a shell.
  - A comment is never sent until its text exists and you have seen it.
- **The page can't run issue text.**
  - The inbox builds every element node by node; nothing is parsed as HTML.
  - A strict Content Security Policy blocks all outside requests, including image beacons.
  - Links show their real host.
- **The local server is local.** It binds to 127.0.0.1, rejects other `Host` and `Origin` headers (other websites, DNS rebinding), refuses to be framed (clickjacking), serves only report files and never dotfiles or the cache, and accepts only validated JSON.
- **Supply chain.** No dependencies, no hooks, no MCP servers, no network access beyond `gh`. CI enforces these invariants on every change, runs with a read-only token, and pins its actions to commit SHAs.

## Limits

Detection of prompt injection is a heuristic. It catches the common shapes, but determined text can still read like a normal bug report. The real protection is structural: Sift never acts on issue text, and nothing reaches GitHub without your confirmation.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability), not a public issue. Include steps to reproduce and the Sift version (`claude plugin list`).
