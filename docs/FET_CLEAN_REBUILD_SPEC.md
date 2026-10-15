# Clean rebuild spec — the client finance/expense app, on drifter

Owner's decision, 2026-10-15: the existing app **stays exactly as it is on the client account** (live, untouched).
In parallel, the app gets a clean, optimised rebuild that deploys on **`Drifter_87@live.com`** — the main
hosting account — **without user management, without OAuth and without Google sign-in**.

This document is the spec for that rebuild. It is written to be executed in a **new project**, not by
editing the live client app.

## 1. Why the rebuild removes sign-in rather than migrating it

The current app's data model exists to serve accounts: a `users` table, Google Drive sync, an admin
panel that can read every user's data, and a recovery-passphrase escrow that hands the administrator a
copy of each user's key. Measured against the live database that is **5 users and 2 leads** — a very
large amount of machinery, and the largest possible amount of risk, for a small private tool.

Dropping sign-in removes, in one move:

- every credential in the app (no Google client, no OAuth redirect, no API key — **nothing left to leak**);
- the recovery-passphrase escrow, i.e. the administrator can no longer read anyone's data (the current
  design is deliberately *not* zero-knowledge because of that escrow);
- the `users` and `leads` tables and the whole `the legacy client app` surface that exists to serve them;
- the Google OAuth console step, and the "existing users must re-authorise" problem;
- the two live demo accounts whose passwords are currently written down in the project
  (see [SECRETS_SWEEP.md](SECRETS_SWEEP.md)).

The cost is: the app becomes single-device unless the user exports a backup file. That trade is
explicit and accepted.

## 2. Non-goals (hard boundaries for the rebuild)

- No accounts, no sign-in, no OAuth, no Google Drive, no per-user data on any server.
- No admin panel, no user directory, no passphrase escrow, no "recovery" of anyone's data.
- No D1 database, no KV, no R2 — the deploy must be **static assets plus, at most, one tiny Worker**.
- No API keys or client secrets of any kind. A build that needs none cannot leak one.
- No change to the live client app, its database or its URLs.

## 3. What the app must still do

Carried over from the current feature set, minus the account surface:

- **Bilingual EN/AR with true RTL**, one file, no build step required for the user.
- **Invoicing**: client profiles, itemised invoices, payment tracking, XLSX and PDF export.
- **Expenses**: log with amount, category, location, client; running total; spending-by-category chart.
- **Domains → categories**: keep the domain/category mapping (civil, arch, MEP, tech, auto, leisure,
  IT, own business, office, interior) including the `[common]` categories and the custom-category escape.
- **Attachments** on records, with per-client / per-project / per-period **ZIP download**.
- **Local encryption at rest** (AES-GCM) behind one passphrase, unlocked once per session.
- **Backup export/import** as a single versioned envelope file, plus a full ZIP archive.
- **PWA**: installable, offline-capable, dark theme, bilingual chrome.
- Everything that already works in the app's 38 automated suites that does *not* depend on accounts.

## 4. Architecture

```
drifter-87 account
└── Worker  fet-ledger            ← static assets (index.html + icons + manifest + sw.js)
    optional /api/health          ← returns { ok, version } only; no data, no keys
```

- **Storage is the browser**: IndexedDB for records and attachments, localStorage only for preferences.
  No server round-trip is needed for any feature except the (optional) health route.
- **One passphrase, never transmitted.** Derive a key with PBKDF2-SHA-256 (≥ 250k iterations) or
  Argon2id if a bundled WASM build is acceptable; encrypt with AES-GCM and a per-record IV.
- **Envelope format is versioned** (`{ v: 2, salt, iv, ciphertext, meta }`) so an old export can always
  be read by a newer build — this is the only real compatibility contract the rebuild must honour.
- **No CDN globals.** Chart.js, SheetJS and jsPDF are currently loaded from three different CDNs with
  SRI; the rebuild self-hosts them from the bundle so offline mode and supply-chain integrity stop
  depending on someone else's uptime.
- **Libraries decide the budget, not the page**: lazy-import Chart.js and the XLSX/PDF exporters so the
  first paint carries none of them.

## 5. Measurable acceptance criteria

| # | Criterion | How it is checked |
|---|---|---|
| 1 | Deployed on drifter, `wrangler whoami` = `Drifter_87@live.com`, account passed explicitly on deploy | deploy log + live URL |
| 2 | Zero third-party network requests at runtime | DevTools network panel: only same-origin entries |
| 3 | No credential anywhere in the project | credential sweep returns nothing (see [SECRETS_SWEEP.md](SECRETS_SWEEP.md)) |
| 4 | Export → wipe → import round-trip is lossless | automated: record counts and a hash of the decrypted payload match |
| 5 | Arabic RTL renders correctly on every screen, both languages | visual pass, both directions |
| 6 | Invoice PDF and XLSX export open in Excel/Reader | open the produced files |
| 7 | Offline reload works after first visit; app installs as PWA | DevTools offline + install prompt |
| 8 | First interactive ≤ 2.0 s on a throttled "Fast 3G" profile, initial JS ≤ 250 KB gzipped | Lighthouse/DevTools on the live URL |
| 9 | Attachment ZIP download works per client, per project and per month | click through, open the ZIP |
| 10 | The LIVE client app is byte-identical to before this project started | no writes to that project, no deploys to that account |

## 6. Data migration

Nothing has to be migrated. The current server data is **5 users + 2 leads**:

- `users` — not needed: the rebuild has no accounts. The export is kept as a backup only.
- `leads` (2 rows) — if those two enquiries matter, they can be copied by hand; they are not worth a
  schema.

A verified SQL export of the live database already exists **outside the project**, kept in a local
`~/cf-migration/` directory (3.8 KB: schema + all rows, taken 2026-10-15 with an explicit account id).
Its exact filename — which carries the database's own name — is withheld from this copy. It contains
real emails, so it stays out of any repository and any share.

## 7. Deploy recipe (for the new project)

1. New project, new repo — **do not** touch the live client project.
2. `wrangler.toml` naming the Worker and the drifter account; compatibility date set deliberately.
3. Build the static bundle, then `CLOUDFLARE_ACCOUNT_ID=8660293d… wrangler deploy`.
4. Verify against the live URL with the criteria in §5 — especially #2 (zero third-party requests) and
   #4 (round-trip), which are the two the old build could not claim.
5. Only then decide whether the client copy is retired; retiring it is a separate, explicit decision.

Full deployment rules, including the account-selection hazards, are in [`../DEPLOY.md`](../DEPLOY.md).
