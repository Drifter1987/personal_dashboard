# Credential sweep — 2026-10-15

A scan of this project and the client project for exposed credentials. Patterns searched: private-key
blocks, Google/OpenAI/GitHub/GitLab/Slack keys, JWTs, AWS access keys, SigV4-signed URLs, database URLs
with passwords, literal bearer headers, token assignments, plus credential-shaped filenames
(`.env`, `.dev.vars`, `credentials.json`, `service-account*.json`, `*.pem`, `id_rsa`, `_netrc` …).

**No secret value is written in this file, and none was printed during the sweep.** Findings are
recorded as path, line and pattern only.

## Result summary

| Area | Real exposures | Notes |
|---|---|---|
| This project (`personal_dashboard`) | **none** | Four pattern hits in `worker.js` are URL templates that *receive* the key at runtime from the secrets store — not literals. |
| The client project | **demo-account credentials** | See below. Also third-party signed URLs and private client data inside its archive folder. |
| Secret-shaped files anywhere | **none** | No `.env`, `.dev.vars`, `credentials.json`, `*.pem`, `id_rsa` or `_netrc` in either project. |

## Finding 1 — demo credentials in plaintext, and two of them are live accounts

Severity: **high** (these are working credentials for accounts that exist in the production database).

| Where the credentials sit | What is in it |
|---|---|
| machine-readable demo password files | demo logins and data passwords |
| per-account credential sheets | one sheet per demo account |
| a root-level `demo accounts.json` (58 KB) | demo credentials **plus encrypted vault blobs** |
| a demo-account creation script (one line) | prints a demo password |
| a local agent run note (one line) | lists two demo logins and passwords in plain prose |
| a seeded demo-account data file | seeded demo account data |

**The exact file paths, and the client's database and account identifiers, are withheld from this
copy.** This document is published, and a map showing exactly where working credentials sit does not
belong in a public repository. The full list — every path, the database name and id — is in the
owner's local `.ops-private/originals/` copy of this file.

Cross-check against production (the client application's live database; account and database details
withheld here): of the **3** demo accounts in the file, **2 are live rows in that application's
`users` table**. So the demo passwords in these files are not harmless fixtures — they open accounts
in the running app.

**Status:** the files were **not deleted** (they are the author's test workflow and the docs reference
them), and they were **not published**. The project now has a `.gitignore` that excludes the demo
credential files, the demo backups, the archive and any `.env`/`.dev.vars`, so a future
`git init && git push` cannot publish them.

**Still needs the owner's decision** (each is a production change, so it needs explicit consent):
1. Change the demo accounts' passwords in the live database (invalidating the written-down ones), or
2. Delete the demo accounts from the live database, or
3. Keep them deliberately and accept that they are demo credentials — but then strip the plaintext
   copies out of `README`/`CHANGELOG`/`run.md`, which are the files most likely to be shared.

## Finding 2 — `archive/chat-history/` (privacy, not credentials)

The client project's archived build-chat exports (exact paths withheld, as above) include:
- a third-party CDN URL carrying a long JWT (`eyJ…`, 263 chars) — issued by the model provider, and
  expired; low risk, and a different one was found in a second export;
- **private financial records belonging to a third party** (itemised payments, names, amounts) pasted into the chat — private data rather than a credential, and the reason that archive stays out of any share.

**Status:** left untouched — it is the owner's archive, and deleting another author's material is not
something an agent should do unasked. It is now gitignored. Recommendation: keep it out of any zip,
share or repository, and consider moving it to an encrypted archive outside the project.

## Finding 3 — this project's own scratch credentials (fixed)

Earlier in this mission, token-bearing scratch files created while diagnosing the wrangler credential
(`_cf_token.mjs`, `.cf_access_token`) were removed, `.gitignore` was added before the first commit, and
the credentials now live only in the platform's own stores (`~/.wrangler/`, with copies under
`~/.wrangler/credential-backups/`, plus the Cloudflare Secrets Store for the metals key).

## How to re-run this sweep

The scanner is not kept in the project (it names the patterns it hunts). Re-create it or ask an agent to
run a credential sweep — the important rules are: never print a match, report path + line + pattern
name, and treat "credential-shaped filename" as a finding even when the contents look empty.

## Standing rules this sweep enforces

- Never print, log, paste or screenshot a secret **value**. Identities, IDs and status are fine.
- Secrets live in the platform's own store — Cloudflare Secrets Store, environment variables, an OS
  credential store, or a git-ignored `.env`.
- A signed/presigned URL is a credential. `wrangler d1 export` prints a one-hour R2 download URL with
  live `X-Amz-*` credentials in the query string: treat it as a secret, never paste it into chat,
  issues or logs, and let it expire.
