# Deploying the dashboard

Two things get published, to **different Cloudflare products**, and they are pinned to the
account in different ways. Read the credential section before running anything.

| What | Command | Where it lands |
|---|---|---|
| Worker API | `wrangler deploy` | `home-dashboard-api.drifter-87.workers.dev` |
| Static page | `wrangler pages deploy deploy/ --project-name home-dashboard` | `home-dashboard-5ma.pages.dev` |

Target account: **`Drifter_87@live.com`** (`8660293d…`) — the main
hosting account. Full inventory: [docs/CLOUDFLARE_ACCOUNTS.md](docs/CLOUDFLARE_ACCOUNTS.md).

To stop doing this by hand — a push that publishes itself, with no API token — follow
[docs/PUBLISHING.html](docs/PUBLISHING.html). It is written for the person clicking, not for
an agent.

## 0. Before anything: which account, and is it even alive?

```bash
wrangler whoami        # state the resolved account out loud before publishing
```

- **Ask the user which account is intended.** Never infer it, never default silently.
- Neither deploy pins an account in config: `wrangler.toml` fixes the Worker, its bindings and
  the compatibility date, but the credential — or an explicit `CLOUDFLARE_ACCOUNT_ID` — selects
  the account, for a **Worker** deploy exactly as for a **Pages** deploy, which carries no
  account binding at all. That is the whole reason for this step.
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

### Release notes

The changelog exists in two places that must not disagree: the `CHANGELOG` array inside
`index.html` (rendered by the in-app Changelog modal, in both languages) and `CHANGELOG.md` at
the repo root. The page is the source of truth, and the markdown is generated from it:

```bash
node _changelog.mjs           # regenerate CHANGELOG.md from index.html
node _changelog.mjs --check   # exit 1 if CHANGELOG.md is stale (CI-ready)
```

The generator refuses to write when an entry is missing its version, date, or English text,
or when the array is out of order. The harness independently fails when the newest entry's
version or language text does not match the running `VERSION`, so a release that bumps the
page but forgets its notes cannot get through the gate. Regenerate the markdown in the same
commit as the version bump.

## 2. Publish the Worker

```bash
wrangler deploy
```

`wrangler.toml` declares both live bindings, so a deploy cannot silently drop them. This
matters: `wrangler deploy` driven by a config file does **not** preserve variables it does not
know about (`keep_vars` defaults to false). An undeclared `ALLOWED_ORIGIN` would vanish, and an
undeclared secrets-store binding would take `/api/metals` down with it.

### Due-date reminders — the three things that must exist first

The push routes are useless without a store, a signing key and a schedule, and `wrangler.toml`
can only declare the first two once they exist in the account:

```bash
npx wrangler kv namespace create PUSH      # prints an id; paste it over the local-dev placeholder
npx wrangler secret put VAPID_JWK          # paste the private key JWK when prompted
npx wrangler deploy                        # the cron trigger goes live with this deploy
```

The VAPID key is one P-256 keypair, held only as a JWK in the Worker secret — the page reads
the matching public key from `GET /api/push/key`, so nothing has to be kept in sync by hand.
Generate one with `node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))"`.
When the secret is missing the routes answer **503** and the page says so instead of pretending
to be armed.

What the store holds, and nothing more: the push endpoint, its two keys, the device's timezone
and chosen hour, and the titles of open cards that carry a due date. Removing a device from the
page deletes its record in the same request.

Changes to the push crypto are worth checking locally before they ship, because a mistake
there produces a push that is *accepted* by the service and then never decrypts on the phone:

```bash
npm install --prefix . --no-save http_ece jose   # test-only; node_modules is gitignored
node _pushcrypto.mjs     # encrypts here, decrypts with http_ece - the library web-push uses
node _push.test.mjs      # the routes and the cron digest against a fake KV namespace
```

The week-review card reads three stores that already exist, so its arithmetic is worth a run of
its own after touching it - the window edges, a completion that happened just after local
midnight, a habit younger than the window, and minutes from before they were recorded all have
exactly one right answer:

```bash
TZ=Asia/Beirut node _week.test.mjs    # the real weekStats out of index.html, no dependencies
```

### Repeats, successors and rollover

Three plan rules look identical in a screenshot whether they work or not, so all three are
arguments in `_deploy.mjs` before anything ships:

- **repeat** - a card can be daily, weekly or monthly, and completing one schedules exactly one
  successor carrying its words, with the start date cleared and no completion stamp.
- **successor** - the next copy is always in the future (a week-late daily card yields tomorrow,
  a neglected monthly one lands once), a weekly card keeps its weekday, and a monthly one lands in
  the month after its parent - the last day of a short month, never skipped into the one after. It
  is claimed by `from`, so ticking a card twice - or undoing and redoing it - cannot create two. Both ways of
  finishing a card (the list's circle, the board's columns) go through `setDone`/`kbSet`, which
  are the only two places `done` is written.
- **rollover** - an open card whose date has passed moves to today, once per day, with `rolled`
  counting the carries; a finished card keeps the date it was finished on, a future date is left
  alone, a missing or malformed date is not invented into today, and a repeating card that was
  never finished is carried like any other (then schedules from the new date).

```bash
node _tasks.test.mjs    # the real nextDue/spawnNext/setDone/kbSet/rollOverdue out of
                        # index.html, run against a pinned clock: no dependencies
```

The harness is lifted from the page at run time and fails loudly if a function it needs is
renamed or deleted, so the gate cannot pass by testing a stale copy.

### Offline and the update prompt

`deploy/sw.js` caches the **shell only** - `index.html`, the manifest and the icons - so the
installed dashboard opens with no signal. Market prices, headlines and prayer times are fetched
from the Worker and are never cached: a stale price is a lie, so those cards keep saying they
cannot reach the API while the rest of the app works.

Two things move together and must never drift:

| Where | What |
|---|---|
| `deploy/sw.js` | `const VERSION` - also the cache name (`home-dashboard-<version>`) |
| `index.html` | `CONFIG.VERSION` - what the page reports and the changelog is keyed on |

A release with a new worker installs it **waiting**, which is what makes the page offer
"A new version is ready - reload to use it". The gate fails if the two versions differ, so a
release can never ship without the prompt. Activating a worker deletes every other
`home-dashboard-*` cache, so an old shell cannot be served afterwards.

If only the HTML changes, the page still learns about it: the worker compares a fresh copy with
the cached one on every check (on load, on returning to the tab, every twenty minutes while
visible) and reports a change the same way. Nothing is ever swapped underneath the user, and
"Later" only hides the bar.

Both halves are checked without a browser, and then by hand before a release:

```bash
node _sw.test.mjs      # the worker in a fake ServiceWorkerGlobalScope: install, cache,
                       # cross-origin pass-through, offline navigation, update check, push
```

To feel it locally, serve `deploy/` over http://127.0.0.1 (a service worker needs a secure
context, and loopback counts):

```bash
python -m http.server 8099 --bind 127.0.0.1 --directory deploy
```

1. Open `http://127.0.0.1:8099/?p=3`, let it settle, reload once - the second load is served
   from the cache.
2. **Stop the server** and reload. The dashboard must still paint, with "Offline - showing the
   saved copy" under the page label, and the market/news cards saying they are unavailable.
3. Start the server, change any byte in `deploy/index.html`, reload: the update bar appears.
   Press **Reload** and the new copy is what loads.
4. For the waiting-worker path, bump `VERSION` in `deploy/sw.js` (and `CONFIG.VERSION`), reload,
   and the bar appears from the new worker instead - the message differs, the promise does not.

## 3. Publish the page

```bash
wrangler pages deploy deploy/ --project-name home-dashboard
```

Uploads the bundle produced by the gate. This is the step with no account binding, so it is the
step where `whoami` has to be right.

## 4. Verify — always, against the live site

A successful command is not proof that the site works. This step runs **after** publishing — the
gate decides whether a publish may start, this decides whether it actually landed — and a deploy
is not done until it exits 0:

```bash
node _smoke.mjs               # the whole check, exit 0 only if the live site matches
node _smoke.mjs --once        # one fetch per URL: no edge-staleness re-fetch
node _smoke.mjs --timeout=20000
```

It asks three questions of the live site and exits **1** if any answer is wrong (2 on bad usage):

| Check | What must be true |
|---|---|
| **Page** | Every file under `deploy/` is fetched from the page's origin and its sha256 compared with the local copy — `index.html` first, then the manifest and the five icons. The live page must also report the bundle's version. |
| **Worker** | `/api/health` answers 200 JSON, `ok: true`, `keyResolved: true`, and the deployed `v` equals `VERSION` in [worker.js](worker.js) — a page published against an old API fails here. |
| **CORS** | `ALLOWED_ORIGIN` in [wrangler.toml](wrangler.toml) is the dashboard's own origin, that origin is echoed exactly (with `Vary: Origin`), a foreign origin is **not** echoed, and preflight answers 204 with `GET`. |

A page-hash mismatch is re-fetched twice, 4s apart, before it is believed: Cloudflare can serve
the previous deployment for a few seconds, and `--once` is what to use when you know the edge
has settled. `_headers` is compared against nothing — it is Pages configuration, not a served
asset. Failures are listed individually with the offending hash, version or header, so a stale
page, a stale icon, a dead key and a mis-pinned origin read differently in the log.

URLs default to the two production hosts; override them to smoke a preview deployment, or a
local server over `deploy/` to watch the check pass before trusting it on the real thing:

```bash
SMOKE_PAGE=http://127.0.0.1:8000/ node _smoke.mjs    # a local server over deploy/
SMOKE_API=https://<branch>.home-dashboard-api.workers.dev node _smoke.mjs
```

### If you need to look by hand

```bash
curl -s https://home-dashboard-api.drifter-87.workers.dev/api/health   # keyResolved: true?
curl -s https://home-dashboard-5ma.pages.dev/ -o /tmp/live.html
cmp -s /tmp/live.html deploy/index.html && echo "live == tested bundle"
```

The last one is the important one: **the live page must be byte-identical to the tested bundle.**
If it mismatches, re-fetch before concluding anything — `node _smoke.mjs` already does that.

Then load the page in the browser and check the console is clean; the script cannot see a
JavaScript error that only shows up once the page runs.

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

### If the credential answers 403 (`9109 Invalid access token`)

That error means the short-lived **access** token expired. The stored `refresh_token` usually
still works, and refreshing is faster and safer than a re-login:

- `oauth_token`, `refresh_token` and `expiration_time` live in the wrangler config above.
- POST `grant_type=refresh_token` with that refresh token and wrangler's **public** OAuth
  client id (`54d11594-84e4-41aa-b438-e81b8fa78ee7`) to `https://dash.cloudflare.com/oauth2/token`.
  No client secret is involved — it is a public client, which is why this works from a script.
- Store the returned access token **and** the rotated refresh token back into the file; then
  confirm the identity with `wrangler whoami`.
- Do **not** print, log or paste any of these values, and do not commit the config file.

Work on the file in place only after taking a copy — `~/.wrangler/credential-backups/` holds the
known-good copies, including account B's.

### Pass the account explicitly — wrangler can *assert* one

Observed 2026-10-15: with a credential for account B installed and no account in any config,
`wrangler d1 export` / `d1 list` addressed **account A's** account id anyway and got
`401` / `Authentication error [code: 10000]` back. Wrangler does not always *derive* the account
from the credential; it will happily **assert** one and let the API reject it. So for anything that
reads or writes remote state, make the target explicit rather than inferred:

```bash
CLOUDFLARE_ACCOUNT_ID=8660293d… wrangler deploy     # account A
CLOUDFLARE_ACCOUNT_ID=c3e022ad… wrangler d1 list    # account B
```

With the account set explicitly the same command succeeded and listed the right database. The
controller for this hazard is `whoami` **plus** an explicit id on every write — not the file you
assume is being read. (The source of the asserted id was not identified; no config file, cache or
environment variable on the machine carried it. It is unknown, not absent, so do not rely on it
being absent.)

### A presigned URL is a credential

`wrangler d1 export` prints a one-hour `*.r2.cloudflarestorage.com` download URL whose query string
contains live `X-Amz-Credential`, `X-Amz-Signature` and `X-Amz-Date` values. Treat that link exactly
like a password: it can be used by anyone who has it. Never paste it into chat, an issue, a commit or
a log, and let it expire.

## CI publishing

`.github/workflows/checks.yml` runs the gate on every push and pull request, and produces the
upload bundle in a second job. GitHub only reads `.github/workflows` at the **repository root**,
so for CI publishing to work this project must be its own repository with its own remote (see
the mission notes) — otherwise the workflow never runs at all.

Publishing from CI is not wired yet; until it is, releases are manual and start at step 0.
Whenever it is wired, the publish job must finish with `node _smoke.mjs` (plus the two repository
secrets above), because a `wrangler` exit code says the upload was accepted, not that the edge is
serving it — that is the difference the script exists to catch.
