# Secrets architecture

Owner's question, 2026-10-15: *"Can't we just use wrangler / Cloudflare secrets / GitHub secrets?"*
Raw-text answer: **yes for deployed Workers, yes for CI — no for local development.** This file records
why, what was changed, and the safe order for anything further.

**No secret value appears in this file, and none was printed while producing it.**

Related: [DEPLOY.md](../DEPLOY.md) (the release runbook, including the credential-refresh recipe and the
account guardrails), [SECRETS_SWEEP.md](SECRETS_SWEEP.md) (what the credential scan found), and
[CLOUDFLARE_ACCOUNTS.md](CLOUDFLARE_ACCOUNTS.md) (which account each credential reaches).

## The constraint that decides it: both are write-only

| Surface | Readable back? | Covers | Cannot cover |
|---|---|---|---|
| **Cloudflare Workers secrets** (`wrangler secret put`) | **No** — `wrangler secret list` returns names and metadata only | values inside a deployed Worker | local dev, Python, shell, CI outside Cloudflare |
| **Cloudflare Secrets Store** (account-level, open beta) | **No** — retrievable only *by a Worker* through a binding | reuse across many Workers in one account | anything running on your machine |
| **GitHub Actions secrets** | **No** — injected only into a workflow run | CI/deploy steps | local dev, and the Workers at runtime |
| **Local `.dev.vars` / `.env`** | yes (it is plaintext) | local dev | nothing else — it *is* the plaintext copy |Because the first three cannot be read back, none of them can be the single source of truth for a project you also run locally: the moment the value is in Cloudflare or GitHub, your machine has no copy and no way to fetch one. That is the reason a dedicated store (Infisical / Doppler / SOPS+age) exists — its whole job is to *give values back* at process start.

**Verified on this machine, 2026-10-15** (`drifter_87@live.com`):

```
GET /accounts/8660293d…/secrets_store/stores                       -> 200, 1 store, no value field
GET /accounts/8660293d…/secrets_store/stores/511d1a67…/secrets     -> 200, 1 secret, no value field
wrangler secret list                                               -> []  (names only, never values)
```

The store and its secret are enumerable; the **value is not exposed through the API at all**. That is the
write-only behaviour the table describes, confirmed by request rather than by citation. An earlier probe
of the same path returned `401` — transient, and superseded by the two `200` responses above.

## The decision taken: use what you already have, per surface

No new account. Each secret lives where it is needed, and the split is explicit:

| Where the code runs | Where its secrets live | Status |
|---|---|---|
| Deployed Worker | **Cloudflare Secrets Store** (account-level, bindable per environment) | already working for this project — see below |
| CI (if a remote ever exists) | **GitHub Actions secrets** | not wired: no GitHub remote, no `gh` |
| Local dev (Node / Python / shell) | gitignored `.dev.vars` / `.env` | protected now; still plaintext by design |

The cost of this split is honest and worth stating: **there are two copies** — one in Cloudflare, one in
the local file — and nothing keeps them in sync automatically. If that duplication ever becomes the
problem, a manager (Infisical is the best fit researched: free tier of 5 identities / 3 environments per
project / 10 syncs, `infisical sm run --env=dev -- <anything>`, native sync into Cloudflare Secrets
Store, self-hostable) is the upgrade path. It is **not** required for correctness today.

## Proof the Cloudflare side is genuinely centralised (this project)

The dashboard Worker does not read its key from a file or a plain variable — it resolves it from the
account Secrets Store, verified live:

```
GET https://home-dashboard-api.drifter-87.workers.dev/api/health
-> { "ok": true, "keyResolved": true, "keyKind": "secrets-store", ... }
```

`wrangler.toml` declares the store id and secret name, so a deploy cannot silently drop the binding.
That is the pattern to copy for any other Worker; nothing about it needs to change.

## Inventory: every plaintext secret file on this machine (2026-10-15)

Key **names** only. "Risk" is about how safely the file can be moved, not about whether it is exposed —
none of these is committed or pushed anywhere (verified: no `.env` is git-tracked, and the workspace repo
has 0 commits, 0 tracked files and no remotes).

| File | Keys | Migration risk |
|---|---|---|
| `00_System/AI_Brain/.env` | 3 OpenAI-shaped + 1 OpenRouter-shaped key | **High** — consumed by many local tools; only 2 of 7 files on this machine hold strictly-shaped live keys, and this is one |
| `00_System/AI_Brain/memory/backups/configs/opencode-global.….bak` | 1 `nvapi-` key | **High** — a rotated backup, not read by anything at runtime; safest to delete once confirmed unused |
| `Houdini-Mail-Hub/.env` | `NODE_ENV, PORT, APP_URL, DATABASE_PATH, WORKERS_INLINE, OWNER_NAME, OWNER_EMAIL, OWNER_PASSWORD, ENCRYPTION_KEY` | **Low-medium** — has a test suite (`tests/`) that reads `process.env`, so a move is verifiable |
| `Houdini Business Leads HBL/.env` | `DATABASE_URL, APP_ENV, GOOGLE_PLACES_API_KEY` | **Medium** — a local database path lives in `DATABASE_URL`; moving it changes which DB the app opens |
| `nvidia_build/.env` | `NVIDIA_API_KEY` | **Low** — one key, one script |
| `12_Temp/archive/.env` | `HUGGINGFACE_TOKEN` | **Low** — archived material |
| `Desktop/Bannouni/F1_Roum/.env` | `GEMINI_API_KEY` | **Low** — one key, not in a repo |
| `Desktop/testooos/ai-visibility-tracker/secrets.json` | secret-shaped value | **Medium** — has `test/credentials.test.mjs`, so verifiable; not in a repo |

## What was changed today

1. **`Documents/AI_Workspace/.gitignore` created** — that repo had none, so every `.env` under it was one
   `git add -A` from being committed into a repo spanning the whole workspace.
   Verified with `git check-ignore`: all four `.env` files ignored (including the one whose path contains
   spaces), the `.bak` holding an `nvapi-` key ignored, and `.env.TEMPLATE.md` / `.env.example`
   **deliberately not** ignored — a strict scan proved they contain placeholders only (0 real values,
   44 placeholder markers).
2. **Nothing else was touched.** No application's env loading was altered, no file deleted, no value read.

## ⚠️ Do not run `git add -A` in that workspace

`git add -A --dry-run` there **timed out twice at 240 s** — the tree contains model data. A blind
`git add -A` is slow enough to be dangerous and is the exact command that would sweep loose secrets in.
Stage explicit paths.

## Safe order for anything further

Each step ends in a check that the application still works, and none removes a plaintext file until its
own check passes.

1. **Delete the rotated backup** `…/configs/opencode-global.….bak` — after confirming nothing reads it.
   Highest value per unit of risk: it holds a live-shaped key, is likely forgotten, and no runtime path
   touches it.
2. **`nvidia_build` and `12_Temp/archive`** — single-key files; move to Cloudflare/GitHub only if those
   scripts ever run in a deployed context, otherwise the gitignore protection is already the right answer.
3. **`Houdini-Mail-Hub`** — the one project where a full move is genuinely verifiable: install the manager
   or keep `.env`, run `tests/` with the new injection, and only then remove the file.
4. **`Houdini Business Leads HBL`** — do **not** move `DATABASE_URL` to a remote store as a blind copy;
   the value names a local database and a mismatch silently points the app at a different one.
5. **`AI_Brain/.env`** — leave in place until each consuming tool is listed and tested. It is the master
   provider file; a mistake here degrades many tools at once.

## Environment separation for the dashboard (planned, not executed)

Wrangler environments are **additive**: adding `[env.staging]` creates a *new* Worker and leaves the
top-level (production) Worker `home-dashboard-api` exactly as it is. That is the safe way to get
dev/staging/prod without touching the live site:

```toml
# wrangler.toml — top level stays production, unchanged
[[secrets_store_secrets]]
binding    = "METALS_API_KEY"
store_id   = "511d1a67…"      # elided here — a real config needs the full id verbatim
secret_name = "personal_dashboard"

[env.staging]
name = "home-dashboard-api-staging"
[[env.staging.secrets_store_secrets]]
binding    = "METALS_API_KEY"
store_id   = "511d1a67…"       # or a separate store per environment
secret_name = "personal_dashboard_staging"
```

*(The store id is elided in both snippets. A truncated id will not work in a real config — the full
value is required verbatim, and is kept in the owner's local `.ops-private/originals/` copy of this
file and in the Cloudflare dashboard.)*

Verify with a staging deploy (`CLOUDFLARE_ACCOUNT_ID=<drifter> wrangler deploy --env staging`) and a
staging `/api/health`, then leave production alone. Secrets are **not inherited** between environments,
which is a feature here: a staging mistake cannot reach the production binding.

**Honesty note on this section:** the additivity claim is Cloudflare's documented behaviour, **not
verified here**. My `--dry-run` probe was inconclusive — a dry run does not print the resolved Worker
name, so it could not show that plain deploy targets `home-dashboard-api` while `--env staging` targets
`home-dashboard-api-staging`. Treat this section as a plan to test, not as a tested result: confirm it on
a staging deploy before relying on it, and never on production first.
