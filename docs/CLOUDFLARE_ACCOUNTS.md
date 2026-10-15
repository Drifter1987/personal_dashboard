# Cloudflare accounts on this machine

Verified 2026-10-15 by read-only audit: accounts A and B over the Cloudflare API with the
wrangler credentials below, account C in the Cloudflare dashboard through the browser (it is
empty, so there was nothing to enumerate).

**Nothing in this file is a secret.** It records identities, IDs and resource names only —
never a key or token value. That is deliberate, and it is the machine-wide rule.

## The three accounts

| | Account | Account ID | Role |
|---|---|---|---|
| **A** | `Drifter_87@live.com` | `8660293d…` | **Main hosting account.** The dashboard lives here. |
| **B** | `the legacy client account` | `c3e022ad…` | Legacy, but **not spare**: it hosts one live client application and five legacy Pages sites. |
| **C** | `an unused account` | `7b2a94e4…` | Empty. |

## Account A — `drifter-87`

workers.dev subdomain: `drifter-87`

| Type | Resource | Details |
|---|---|---|
| Worker | `home-dashboard-api` | → `https://home-dashboard-api.drifter-87.workers.dev` |
| Pages | `home-dashboard` | → `https://home-dashboard-5ma.pages.dev`, production branch `main` (`-5ma` was appended because the plain name was taken) |
| Secrets store | `511d1a67…` | one secret, `personal_dashboard` (the metals provider key), status `active` |

Live Worker bindings, exactly as deployed:

- `ALLOWED_ORIGIN = https://home-dashboard-5ma.pages.dev` (plain text)
- `METALS_API_KEY` → secrets store `511d1a67…` / secret `personal_dashboard`
- `compatibility_date = 2026-10-11`, no compatibility flags

Deployment configuration is reproducible from [`wrangler.toml`](../wrangler.toml) at the
project root, which names this account, the Worker, the Pages project, the store ID and the
secret name. `/api/health` reports `keyResolved: true` and `keyKind: secrets-store`.

**Credential status: DEAD (HTTP 403).** The stored OAuth grant was revoked or rotated and must
be re-created with a fresh login before anything can be deployed here.

## Account B — the legacy client account

workers.dev subdomain: withheld (it is the client account's own handle)

### Workers

| Worker | Bindings | compatibility_date | URL |
|---|---|---|---|
| `the legacy client app` | `DB` → D1 the application's user database (`id withheld`) | `2024-01-01` | `(worker hostname withheld)` |
| `the legacy expense tracker` | none | `2024-01-01` | `(worker hostname withheld)` |

Both have workers.dev enabled. These two are the **live client application** documented in
the client's own docs folder — a bilingual finance/expense tracker
whose in-app admin identity is `the client account`. Its own project caches
that account's cached identity in `.wrangler/cache/`, and its
`README.md`, `RELEASE_NOTES.md` and Master prompt all hard-code the two client worker URLs — including as a **Google OAuth redirect origin**.

### Pages projects

| Project | URL | Created | Latest deployment |
|---|---|---|---|
| `endocare` | `endocare-1w4.pages.dev` | 2026-07-07 | 2026-07-07 |
| `arcadecopilot` | `arcadecopilot.pages.dev` | 2026-06-17 | 2026-06-17 |
| `arcadegrok` | `arcadegrok.pages.dev` | 2026-06-17 | 2026-06-17 |
| `arcade` | `arcade-ckv.pages.dev` | 2026-06-17 | 2026-06-17 |
| `worldcup26` | `worldcup26-aun.pages.dev` | 2026-06-16 | 2026-06-16 |

These five are audited in [LEGACY_SITES_AUDIT_AND_REBUILD_PLAN.md](LEGACY_SITES_AUDIT_AND_REBUILD_PLAN.md).
None of them has source anywhere in the workspace.

### Storage and secrets

- D1: the application's user database (`id withheld`, created 2026-08-24)
- Secrets store `80be65fb…` — **empty**, and created `2026-10-15T19:57:18Z`
  as a side effect of this session's read-only enumeration (Cloudflare provisions an account's
  default store on first touch). Nothing binds it. It has been left in place deliberately.

## Account C — the unused account

Empty: no Workers, no Pages projects, 0 requests today. Verified in the dashboard. It could
host new work, but nothing is being moved to it and no credential for it exists on this machine.

## Credentials: who reaches what

| Account | Credential | Where it lives | Status |
|---|---|---|---|
| A | wrangler OAuth | `~/.wrangler/config/default.toml` (+ duplicate in the XDG root) | **403 — dead** |
| B | wrangler OAuth | its own backup under `~/.wrangler/credential-backups/` | valid |
| C | none | — | — |

See `~/.wrangler/credential-backups/README.md` for how to switch or re-create a credential.

## Browser sessions

At the time of the audit the Cloudflare dashboard was open for **B** in the incognito tab and
for **C** in the normal tab. Account **A** had no browser session. Sessions are the user's —
they are never signed out by an agent.

## The hazard this file exists to prevent

Two wrangler config roots exist, and they resolved to different accounts at one point, which
put a `wrangler pages deploy` on course for the wrong account. `wrangler.toml` pins the account
for a **Worker** deploy, but a **Pages deploy carries no account binding in config at all** —
the credential alone decides where a page lands.

So, always, before publishing anything:

```bash
wrangler whoami        # which account is this actually going to use?
```

and ask the user which account is intended.
