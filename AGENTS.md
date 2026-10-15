# AGENTS.md — personal_dashboard

RULES-VERSION: 2026-10-15.1

These rules are the machine-wide rules mirrored into this project, so they are injected for
every agent working here. The canonical copy is `~/.agents/AGENTS.md`; if this file and that
one ever disagree, **that file wins**.

They apply to every agent, in every task, in this project.

## 1. Browser work must be visible — always

- Using the internal/agent browser is **never a hidden action**. Before navigating, state in
  plain text which site or URL you are about to open and why.
- Do the browsing in the panel or tab **the user can watch**. Never page a site in a
  background or headless context the user cannot see.
- **Narrate each step while browsing**: where you are, what you clicked, what you are looking
  for, and what the page actually shows.
- Say so **before opening a new tab**, and never close a tab without naming which one and why.
  Any tab holding a signed-in session stays open until the user says otherwise.
- Read a fresh snapshot before acting, and show the outcome afterwards — a screenshot or a
  summary of what the page displays — instead of only asserting that it worked.
- **Never sign out, log out, or end any session in the browser.**

## 2. Credentials, secrets and privacy — hard rules

- **Never print, echo, log, screenshot, paste or summarize the VALUE of a secret**: passwords,
  API keys, tokens, OAuth codes, cookies, session IDs, private keys, connection strings.
- **Identities and metadata are fine to report**: account name, email, resource ID prefixes,
  status, timestamps, whether a key resolves. Values are not.
- Read a secret-bearing file **only to the minimum needed**, and say which file and why first.
  Never dump such a file in full.
- Never put a secret into a prompt, a tool argument, a URL, a commit, project source, a log,
  browser storage, or a filename. Keys go in headers, never in query strings.
- Secrets live in the platform's own store: Cloudflare Secrets / Secrets Store, environment
  variables, an OS credential store, or an `.env` file that is git-ignored and excluded from
  published assets.
- **Ask before creating, rotating, revealing, or deleting any credential**, naming the account
  or service it belongs to.
- If a secret is exposed: **stop, say so immediately, and recommend rotation.** Never hide a
  leak, and never weaken, skip or suppress a check to make something pass.

## 3. Accounts and deployment

Three Cloudflare accounts exist on this machine:

| Account | Account ID | Role |
|---|---|---|
| `Drifter_87@live.com` | `8660293d…` | **main hosting account** |
| `the legacy client account` | `c3e022ad…` | legacy; one live client app |
| `an unused account` | `7b2a94e4…` | empty |

Full inventory, bindings and credential status: [docs/CLOUDFLARE_ACCOUNTS.md](docs/CLOUDFLARE_ACCOUNTS.md).
The release runbook (gate → publish → verify → rollback): [DEPLOY.md](DEPLOY.md).

- **ALWAYS ask the user which account to use before any deploy or publish**, and state which
  account is currently authenticated (for example `wrangler whoami`) before acting. Never
  assume, infer, or default silently.
- A **Pages deploy carries no account binding** in config — the credential alone decides where
  a page lands. That is exactly why the question above is mandatory.
- Never deploy, publish, or run any write action against a hosted service without the user's
  **explicit consent for that action, in that account**.

## 4. Destructive and irreversible actions

- Ask first for deletes, deploys, publishes, credential changes, account or session changes,
  and anything client-facing or hard to undo.
- Never discard, overwrite, stash, or commit work you did not create. Keep unrelated changes
  untouched.
- State plainly what was verified, what failed, and what could not be checked — never report
  a check as passing when it did not run.
