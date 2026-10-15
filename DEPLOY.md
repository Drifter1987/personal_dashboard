# Deploying the dashboard

Two things get published, to **different Cloudflare products**, and they are pinned to the
account in different ways. Read the credential section before running anything.

| What | Command | Where it lands |
|---|---|---|
| Worker API | `wrangler deploy` | `home-dashboard-api.drifter-87.workers.dev` |
| Static page | `wrangler pages deploy deploy/ --project-name home-dashboard` | `home-dashboard-5ma.pages.dev` |

Target account: **`Drifter_87@live.com`** (`8660293d…`) — the main
hosting account. Full inventory: [docs/CLOUDFLARE_ACCOUNTS.md](docs/CLOUDFLARE_ACCOUNTS.md).

## 0. Before anything: which account, and is it even alive?

```bash
wrangler whoami        # state the resolved account out loud before publishing
```

- **Ask the user which account is intended.** Never infer it, never default silently.
- `wrangler.toml` pins the account for the **Worker** deploy, but a **Pages deploy carries no
  account binding at all** — the credential alone decides where the page lands. That asymmetry
  is the whole reason for this step.
- If `whoami` reports the wrong account, stop. Copy the right credential into place
  (`~/.wrangler/credential-backups/README.md` explains how) and re-check.

## 1. The gate

Nothing is published until this exits 0:

```bash
node _deploy.mjs                 # harness (node _check.mjs) + release bundle verification
node _deploy.mjs --artifacts-only # fast re-check of the bundle only, no third-party calls
node _deploy.mjs --sync          # after a green run, repair deploy/ from index.html
```

A green run proves two things: the shipped page and Worker pass the harness against the real
sources, and the thing that gets published is byte-identical to the thing that was tested
(`deploy/index.html` matches `index.html`; every `deploy/` file is in `dashboard-site.zip` with
the same CRC-32). A failing check stops the run before anything is written.

Note: the harness talks to live third parties (ECB, Yahoo, CoinGecko, news feeds), so a red
run is worth reading before re-running.

## 2. Publish the Worker

```bash
wrangler deploy
```

`wrangler.toml` declares both live bindings, so a deploy cannot silently drop them. This
matters: `wrangler deploy` driven by a config file does **not** preserve variables it does not
know about (`keep_vars` defaults to false). An undeclared `ALLOWED_ORIGIN` would vanish, and an
undeclared secrets-store binding would take `/api/metals` down with it.

## 3. Publish the page

```bash
wrangler pages deploy deploy/ --project-name home-dashboard
```

Uploads the bundle produced by the gate. This is the step with no account binding, so it is the
step where `whoami` has to be right.

## 4. Verify — always, against the live site

A successful command is not proof that the site works.

```bash
curl -s https://home-dashboard-api.drifter-87.workers.dev/api/health   # keyResolved: true?
curl -s "https://home-dashboard-api.drifter-87.workers.dev/api/rates?base=USD" | head -c 300
curl -s https://home-dashboard-5ma.pages.dev/ -o /tmp/live.html
cmp -s /tmp/live.html deploy/index.html && echo "live == tested bundle"
```

The last check is the important one: **the live page must be byte-identical to the tested
bundle.** Cloudflare's edge can serve a stale copy for a few seconds after a deploy, so if it
mismatches, re-fetch before concluding anything.

Then load the page in the browser and check the console is clean.

## 5. Rollback

- **Worker:** `wrangler deployments list` then `wrangler rollback [version-id]`.
- **Page:** re-deploy the previous known-good `deploy/` bundle, or use the Cloudflare
  dashboard's deployment history to promote an earlier deployment to production.

## Credentials

- **Locally:** the wrangler OAuth credential in `~/.wrangler/config/default.toml`. A second
  root at `%APPDATA%/xdg.config/.wrangler/config/default.toml` exists and has drifted from it
  before; when in doubt, trust `wrangler whoami`, not the file you assume is read.
- **In CI:** there is no OAuth credential. An **API token is the account selector** — it must
  be scoped to the drifter account, or the publish lands somewhere else. Stored as the repo
  secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Secrets are never printed, logged or committed: the machine-wide rule and this project's
[`AGENTS.md`](AGENTS.md) both say so. `.gitignore` covers `.cf_access_token`, `.env` and
`.wrangler/`.

## CI publishing

`.github/workflows/checks.yml` runs the gate on every push and pull request, and produces the
upload bundle in a second job. GitHub only reads `.github/workflows` at the **repository root**,
so for CI publishing to work this project must be its own repository with its own remote (see
the mission notes) — otherwise the workflow never runs at all.

Publishing from CI is not wired yet; until it is, releases are manual and start at step 0.
