---
name: Global agent rules
description: Visible browser work, secrets and credential privacy, and account consent before deploy
alwaysApply: true
---

# Global agent instructions

RULES-VERSION: 2026-10-15.1
Canonical copy of these rules: `~/.agents/AGENTS.md` (if the two ever disagree, that file wins).

Applies to every task in this workspace.

## Browser work must be visible — always

- Using the internal/agent browser is never a hidden action. Before navigating, state which
  site or URL you are about to open and why.
- Do the browsing in the panel or tab the user can watch. Never page a site in a background
  or headless context the user cannot see.
- Narrate each step while browsing: where you are, what you clicked, what you are looking
  for, and what the page shows.
- Say so before opening a new tab, and never close a tab without naming it and why. Tabs
  holding a signed-in session stay open until the user says otherwise.
- Snapshot before acting and show the outcome afterwards instead of only asserting success.
- Never sign out, log out, or end any session in the browser.

## Credentials, secrets and privacy — hard rules

- Never print, echo, log, screenshot, paste or summarize the VALUE of a secret: passwords,
  API keys, tokens, OAuth codes, cookies, session IDs, private keys, connection strings.
- Identities and metadata are fine to report — account name, email, resource ID prefixes,
  status, timestamps. Values are not.
- Read a secret-bearing file only to the minimum needed, and say which file and why first.
  Never dump such a file in full.
- Never put a secret into a prompt, a tool argument, a URL, a commit, project source, a log,
  browser storage, or a filename. Keys go in headers, never in query strings.
- Secrets live in the platform's own store: Cloudflare Secrets / Secrets Store, environment
  variables, an OS credential store, or a git-ignored `.env`.
- Ask before creating, rotating, revealing, or deleting any credential, naming the account or
  service it belongs to.
- If a secret is exposed: stop, say so immediately, and recommend rotation. Never hide a leak,
  and never weaken or suppress a check to make something pass.

## Accounts and deployment

- Three Cloudflare accounts exist on this machine: `Drifter_87@live.com`
  (`8660293d…`, the main hosting account), `the legacy client account`
  (`c3e022ad…`, legacy, holds one live client app), and
  `an unused account` (`7b2a94e4…`, empty).
- ALWAYS ask the user which account to use before any deploy or publish, and state which
  account is currently authenticated (e.g. `wrangler whoami`) before acting. Never assume.
- Never deploy, publish, or run any write action against a hosted service without the user's
  explicit consent for that action, in that account.

## Destructive and irreversible actions

- Ask first for deletes, deploys, publishes, credential changes, account or session changes,
  and anything client-facing or hard to undo.
- Never discard, overwrite, stash or commit work you did not create.
- State plainly what was verified, what failed, and what could not be checked.
