# Legacy sites — audit and rebuild plan

**Status: audit and specification only. Nothing here has been rebuilt, moved or redeployed.**
The rebuild is deferred to a new Freebuff project, which will use this document as its brief.

Audited 2026-10-15 by fetching each live site. Account: `the legacy client account`
(`c3e022ad…`) — see [CLOUDFLARE_ACCOUNTS.md](CLOUDFLARE_ACCOUNTS.md).

## Why these sites matter

None of the five has any source anywhere in the workspace — I searched for projects matching
their names and found nothing. What makes the rebuild feasible is that **all five are
self-contained single-file HTML apps**: zero references to local asset files, one inline script
each. The deployed HTML *is* complete, recoverable source.

## Frozen provenance (capture 2026-10-15T20:49:03Z)

Sizes and SHA-256 are over the raw response body of the live `index.html`. Recorded so a future
rebuild can prove it recovered the same bytes rather than something the edge had changed.

| Site | Project | HTTP | Bytes | SHA-256 (first 16) |
|---|---|---|---|---|
| `endocare-1w4.pages.dev` | `endocare` | 200 | 106 433 | `cb02c21957cba3fe` |
| `arcadecopilot.pages.dev` | `arcadecopilot` | 200 | 49 012 | `5b43aeeb5cb2534d` |
| `arcadegrok.pages.dev` | `arcadegrok` | 200 | 9 811 | `9d1094dc5ca49c7f` |
| `arcade-ckv.pages.dev` | `arcade` | 200 | 4 067 | `27cb579b1d230509` |
| `worldcup26-aun.pages.dev` | `worldcup26` | 200 | 31 639 | `e07ff71998e59349` |

Deployment history (both from the account audit):

| Project | Created | Latest production deploy | Deployments |
|---|---|---|---|
| `endocare` | 2026-07-07 | 2026-07-07 | 2 |
| `arcadecopilot` | 2026-06-17 | 2026-06-17 | 2 |
| `arcadegrok` | 2026-06-17 | 2026-06-17 | 2 |
| `arcade` | 2026-06-17 | 2026-06-17 | 3 |
| `worldcup26` | 2026-06-16 | 2026-06-16 | 3 |

## Per-site audit

### 1. `endocare` — "EndoCare — Healthcare Management Platform" (106 KB)

The most substantial of the five and the only one that looks institutional rather than
experimental. Its structure includes a landing view plus an **Admin Dashboard** driven by live
metric bindings — `metrics.totalUsers`, `metrics.totalPatients`, `metrics.pendingLabResults`,
`metrics.unreadMessages` — and a "Recent Users" panel, with ~40 tab/panel/nav elements, 28
buttons and 12 distinct localStorage keys. No canvas, no Arabic/RTL, 2 external URLs.

Reads as a clinic/endoscopy practice tool: users, patients, lab results, messaging, with an
admin layer. Its data model is entirely client-side (localStorage) — there is no backend.

### 2. `arcadecopilot` — "Tiny Arcade — 20 Games (Improved)" (49 KB)

The richest of the three arcade builds and the natural **merge base**: 2 canvases, 16 buttons
and ~69 game/level references. Zero external URLs, zero localStorage, so it is pure
self-contained game code.

### 3. `arcadegrok` — "🎮 MINI ARCADE" (9.8 KB)

A much smaller, template-driven descendant — its second heading is literally `${title}`, i.e. a
rendered template — with one canvas, one button, ~30 game/level references and 1 external URL.

### 4. `arcade` — "🎮 20 Lightweight Mini Games" (4 KB)

The earliest and simplest prototype of the same idea: "Welcome! 👾", one button, no canvas, ~15
game/level references, zero externals. Created first (2026-06-17T00:36Z) and deployed most (3).

### 5. `worldcup26` — "FIFA World Cup 2026 Command Center" (31 KB)

A tournament companion with clearly named sections: *Search Global Matchups*, *Today's Matchups
& Timers*, *Disqualified Teams*, *Official Group Fixtures Schedule*, *Live Tournament Standings
Matrix*, *Round of 32*, and *Live Match Analytics*. 7 buttons, 3 external URLs (so it does fetch
something from outside — worth identifying during the rebuild, since a dated tournament dataset
is exactly what goes stale).

## Overlap analysis — the merge case

Three of the five are iterations of one idea, all created within about 5 hours on 2026-06-17:

```
arcade (4 KB, 00:36Z)  →  arcadegrok (9.8 KB, 05:21Z)  →  arcadecopilot (49 KB, 05:31Z)
 simplest prototype        template-driven               richest build
```

**Recommendation: merge into one canonical arcade app, using `arcadecopilot` as the base** (it
has the most content and the only multi-canvas implementation), then port anything worth keeping
from the other two. Three near-duplicate deployments of one idea is the clearest consolidation
win in the set. Keep the other two as archived reference, not as live sites.

`endocare` and `worldcup26` are distinct products with no sibling to merge with — they should
become their own maintained projects with their sources preserved properly.

## Existing workspace overlap

Checked and found none: no local project matches `endocare`, `arcade*` or `worldcup*`. These
apps have never had a home in the workspace, which is why the merge is between themselves and
not with an existing tool.

## Re-host procedure (for the future project)

1. **Recover.** Fetch each live HTML and confirm its SHA-256 against the table above before
   trusting it. Record the hash of what was recovered.
2. **Store.** One folder per site with the HTML plus a `PROVENANCE.md` (source URL, capture
   time, size, hash, account it came from).
3. **Re-host under drifter**, unmodified first: create a Pages project per site in
   `Drifter_87@live.com` and deploy the recovered file. Deploying the untouched artifact first
   separates "can we publish it at all" from "did our changes break it".
4. **Verify** each: HTTP 200, and the served bytes equal the recovered file.
5. **Then rebuild**: the arcade merge, and EndoCare / WorldCup26 as real projects with sources
   under version control.
6. **Only with explicit sign-off**, decommission the originals in account B — after the new
   copies are verified live.

Because a Pages deploy carries no account binding, every one of these deploys requires
`wrangler whoami` to be checked first and the account to be confirmed with the user.

## Open questions for you

1. **Arcade merge**: adopt `arcadecopilot` as the canonical base, as recommended — or rebuild
   the games list from scratch instead of merging three legacy builds?
2. **New hostnames**: keep the existing names (e.g. `endocare`, `arcade`, `worldcup26`) under
   the drifter account, or rename them while moving? (drifter's subdomain is `drifter-87` for
   Workers; Pages projects get their own `<name>.pages.dev`.)
3. **EndoCare's data**: everything is in localStorage, so there is nothing to migrate — but is
   it meant to become a real multi-user app with a backend, or stay a single-browser tool?
4. **WorldCup26's 3 external URLs**: the tournament is dated; keep it as an archive of the
   group stage, or make it live-data-driven?
5. **Decommission timing**: delete the account-B copies as soon as the drifter copies verify,
   or leave both running for a while?

## Brief for the future Freebuff project

Suggested name: **`legacy-sites-rebuild`**

Deliverables:
- Recovered sources for all five sites, each hash-verified against this document.
- One canonical arcade app (merged), plus EndoCare and WorldCup26 as maintained projects.
- Each re-hosted under `Drifter_87@live.com` and verified live.
- A short README per app describing what it is and how to deploy it.

Definition of done: every rebuilt app returns HTTP 200 on the drifter account and its source
lives in the workspace under version control — with the originals in account B still running
until you approve decommissioning.

## What this document does not claim

- It does not claim the five sites still have any owner or audience; that is yours to judge.
- It does not claim the feature lists above are exhaustive — they come from titles, headings and
  structural counts, not a line-by-line read of the code.
- It does not claim the frozen hashes are permanent: they were taken at the capture time above,
  and anything that changes a live site would invalidate them.
