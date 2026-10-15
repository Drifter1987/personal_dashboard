# Accounts, profiles and defaults on this machine

Inventoried 2026-10-15 by reading configuration only. **No token, key or password value was read out
into this file, printed, or pasted anywhere** — identities and metadata only.

Intent, on the owner's instruction: **`Drifter_87@live.com` is the main account** for AI playground,
workspace experiments and deployments. Everything below is either already drifter, or is flagged as
something that still points somewhere else.

## Cloudflare — see [CLOUDFLARE_ACCOUNTS.md](CLOUDFLARE_ACCOUNTS.md)

| Account | Role | CLI credential |
|---|---|---|
| `Drifter_87@live.com` `8660293d…` | **main hosting account** — `home-dashboard-api`, `home-dashboard`, the secrets store | live; `wrangler whoami` resolves here |
| `the legacy client account` `c3e022ad…` | legacy — one live client app (`the legacy client app`, `the legacy expense tracker`) + 5 legacy Pages sites | its credential backup under `~/.wrangler/credential-backups/` (filename withheld), not installed globally |
| `an unused account` `7b2a94e4…` | empty | none exists on this machine |

## Target accounts — the owner's decision, 2026-10-15

The identity to converge on is **`Drifter_87@live.com`**, with these hosts:

| Host | Username | State (checked 2026-10-15) |
|---|---|---|
| GitHub | **`Drifter1987`** | **exists** — created 2026-10-09, 0 public repos, no public email. Almost certainly the owner's own new account. |
| GitLab | **`golaninios`** | **exists** — profile `gitlab.com/golaninios`, display name "golanini os". Owned by the owner if they created it; it is not available as a new registration. |
| Cloudflare | `Drifter_87@live.com` `8660293d…` | main hosting account, `wrangler whoami` resolves here |

**Git identity: DONE.** Set globally on the owner's instruction and verified:

```
~/.gitconfig   user.name  = golani
               user.email = Drifter_87@live.com
git var GIT_AUTHOR_IDENT -> golani <Drifter_87@live.com>
```

That commit was **not re-authored**: `1cbac67` (formerly `554321c`) still carries the previous
identity as its author, with its original message and author date. Only its *content* changed —
identifiers were redacted before this repository was published, which is why the hash moved. Its
committer is now `golani <Drifter_87@live.com>`, which is the honest record of who rewrote it.

**Left for the owner (nothing else can proceed without these):**

1. Add **`Drifter_87@live.com`** to `github.com/Drifter1987` → Settings → Emails and verify it, so
   commits are attributed to that account instead of an unlinked author. It has **zero** public
   commits today, so it is not yet known to GitHub as an author address.
2. Sign the desktop clients in to the drifter accounts: **GitHub Desktop** for `drifter1987` and the
   browser for `gitlab.com/golaninios`.
3. ~~`gh` and `glab` are not installed.~~ **DONE 2026-10-16** — both installed and signed in, in a
   browser tab the owner could watch (see the next section). Item 1 above is now the only blocker for
   GitHub attribution of the new commits.

## Command-line clients — installed and signed in, 2026-10-16

Both were installed with `winget` and authenticated through a device/OAuth flow completed **in the
already signed-in browser tabs** — no password, token or secret value was typed, read or printed.

| CLI | Version | Installed at | Signed in as | How it was verified |
|---|---|---|---|---|
| `gh` (GitHub CLI) | 2.102.0 | `C:\Program Files\GitHub CLI\gh.exe` | **`Drifter1987`** (active account) | device flow at `github.com/login/device`; `gh api user -q .login` → `Drifter1987` |
| `glab` (GitLab CLI) | 1.123.0 | `%LOCALAPPDATA%\Programs\glab\glab.exe` | **`golaninios`** (user id 43418829) | OAuth callback on `localhost:7171`; `glab api user` → `golaninios`, commit email `drifter_87@live.com` |

Credentials live in the **OS keyring** (`gh`) and the keyring + `%LOCALAPPDATA%\glab-cli\config.yml`
(`glab`; verified path `C:\Users\ghazi\AppData\Local\glab-cli\config.yml`). Neither tool's token value appears in any file this project owns.

`glab` is the GitLab CLI — the direct counterpart of `gh`. `gh` → GitHub, `glab` → GitLab.

**PATH:** both installers registered their directory (`C:\Program Files\GitHub CLI\` in the Machine
PATH, `%LOCALAPPDATA%\Programs\glab` in the User PATH), so a **newly opened** terminal resolves both.
Any terminal or agent shell that was already running when they were installed keeps its old
environment block and will report `command not found` until it is restarted — that is a stale
environment, not a failed install.

**Deliberately left alone:** the stale `ghaziomairi93` entry inside `gh` (invalid keyring token,
`active: false`). Nothing was signed out of any client; removing it is the owner's call.

**Known side effect of leaving it:** `gh auth status` **exits 1** while that broken entry exists,
even though `Drifter1987` is logged in and active — the non-zero code comes from the stale account.
Anything scripting `gh auth status` as a health check must read the output (look for
`Logged in to github.com account Drifter1987`, `Active account: true`) rather than trusting the exit
code. It returns 0 again once the stale entry is removed. Verified 2026-10-16: exit 1, cause
`Failed to log in to github.com account ghaziomairi93`. `glab auth status` exits 0 normally.

**Note on GitLab:** GitLab could not be reached earlier because nothing was configured locally. The
new `golaninios` account was created 2026-10-15 and its commit email is already
`drifter_87@live.com`, so GitLab-side attribution works today — unlike GitHub, which still needs
item 1.

**A port note, learned the hard way:** `glab auth login --web` starts a **local callback server on
`localhost:7171`**. If a previous attempt is still alive, the next one dies with
`listen tcp :7171: bind: Only one usage of each socket address`. Find and stop that one PID
(`netstat -ano | grep :7171`, then `taskkill //PID <pid> //F`) rather than retrying blindly.

## GitHub Desktop — inspected and set up, 2026-10-16

Running build: **3.6.5**, from `%LOCALAPPDATA%\GitHubDesktop\app-3.6.5\GitHubDesktop.exe` (read from the
live process, not from the installer directory).

Driven through the **Windows UI Automation tree**, not blind clicks. `orca` (the computer-use skill's
CLI) is **not installed on this machine**, so the fallback was a PowerShell UIA helper at
`%LOCALAPPDATA%\Temp\gd_uia.ps1` — it focuses the window, walks the accessibility tree, reads values
(`ValuePattern`), selects tabs (`SelectionItemPattern`) and types with real keystrokes (`SendKeys`).
Chromium only exposes the tree after a UIA client asks, so the first walk is repeated until it
resolves.

**Verified state — read from the app itself, not assumed:**

| Surface | Value | Where it was read |
|---|---|---|
| Accounts signed in | **exactly one: `Drifter1987`** (`Avatar for Drifter1987`) | Options → Accounts |
| Git author name | `golani` | Options → Git → Author |
| Git author email | `Drifter_87@live.com` | Options → Git → Author |
| Default branch for new repos | `main` | Options → Git → Default branch |
| **Current repository** | **was `desktop-tutorial`** → now **`personal_dashboard`** on branch `main` | toolbar |
| Account token | in the OS keyring as `GitHub - https://api.github.com/Drifter1987` | Credential Manager (names only) |

**The one real problem, fixed:** the app was sitting on the GitHub **tutorial** repository
(`desktop-tutorial`), not on any real project. It now has
`C:\Users\ghazi\Documents\AI_Workspace\02_Projects\Ghazi_Tools\personal_dashboard` added and selected,
so the working directory Desktop opens is inside **`AI_Workspace\02_Projects\Ghazi_Tools`** as
requested. Confirmed independently: the History tab listed commit `554321c` — now `1cbac67`, after the
pre-publication redaction — authored by `GMO`, together with its file list, and `git status`/`HEAD`/
branch in the working copy were unchanged — Desktop did not touch the tree.

**It persists across a restart** — proven without closing the running app: the repository list lives in
IndexedDB (`%APPDATA%\GitHub Desktop\IndexedDB\file__0.indexeddb.leveldb`), and that store was
rewritten the moment the repository was added, now containing
`...\02_Projects\Ghazi_Tools\personal_dashboard`. `last-selected-repository-id` also advanced (2 → 5).

**Deliberately not done:**

- **Nothing was signed out.** The pane showed only `Drifter1987` anyway, so the earlier plan to sign
  other identities out of Desktop turned out to be unnecessary — `ghaziomairi93` and `len-golani`
  appear only as *previously seen* logins in the app's cache, with no live session.
- **Options was closed with Cancel** — inspected, nothing saved, no preference changed.
- **`desktop-tutorial` was left in place** (removing it deletes a local folder: destructive).
- **Nothing published.** `Publish repository` is available and would create a GitHub repo under
  `Drifter1987` — that is a write to the account and needs the owner's explicit go-ahead.

## ⚠️ Flagged — surfaces still pointing at a legacy identity

| Surface | Currently resolves to | Why it matters | Recommendation |
|---|---|---|---|
| **gh CLI** (`%APPDATA%\GitHub CLI\hosts.yml`) | ~~`ghaziomairi93`~~ → now **`Drifter1987`, active**; the old entry remains but is inactive with an invalid token | Repo creation and pushes now go to `Drifter1987`. | **Resolved 2026-10-16.** The stale `ghaziomairi93` entry can be removed with `gh auth logout -h github.com -u ghaziomairi93` when the owner wants — not done, because signing out was not authorised. |
| **GitHub Desktop** storage | held several identities at one point — `Drifter_87@live.com`, one belonging to the legacy client account, and one former address (addresses not reproduced here) | Multiple identities in one client is exactly why "which account am I on" keeps feeling unclear. | Set `drifter1987` as the default account in GitHub Desktop and sign the others out. |
| **SSH keys** (`~/.ssh/`) | two keypairs for `github.com` (`github_ed25519`, `github_rsa`), `User git`, `IdentitiesOnly yes` | Two identities can be offered to GitHub; whichever key is authorised decides which account a push acts as. | Find which key is authorised on `Drifter1987`; add the other as a second remote identity only if a second account is genuinely wanted. |
| **GitLab** | ~~nothing installed or configured locally~~ → `glab` 1.123.0 installed, signed in as **`golaninios`** | Push, MRs and repo creation now work against GitLab. | **Resolved 2026-10-16.** Verify the GIT protocol choice (`https` here) still matches how you authenticate remotes. |

### The identity drifted twice during this mission — evidence, not recollection

| When | Global `user.email` | Evidence |
|---|---|---|
| Start of the mission | a former address (not reproduced here) | commit `1cbac67` (then `554321c`) is authored with that address |
| Mid-mission | the legacy client account's address | `git config --list --show-origin` → `file:C:/Users/ghazi/.gitconfig` |
| Now (set by this mission, on request) | `Drifter_87@live.com` | `git var GIT_AUTHOR_IDENT` → `golani <Drifter_87@live.com>` |

The first change happened **outside** this mission — nothing here ran `git config --global` before the
final step. The lesson is the reason this section exists: **on this machine the git identity is not
stable, so read it before trusting it**:

```bash
git config --list --show-origin | grep user.      # where does the identity actually come from?
```

The system-level config only sets git-lfs filters; the global file is the single source of truth for
the author identity.

**Caution, still live:** the identity is set, but `Drifter_87@live.com` is only *useful* once it is a
verified email on `github.com/Drifter1987`. Until then, commits are authored under an address GitHub
cannot attach to that account — the setting is correct and the attribution is pending item 1 above.

## Nothing else is signed in

Checked and absent: `~/.git-credentials`, `~/.netrc` / `_netrc`, `~/.npmrc`, `~/.gitlab`, and any
GitHub/GitLab credential elsewhere in the Windows Credential Manager listing.

Now **present** (added 2026-10-16, expected): `%LOCALAPPDATA%\glab-cli\config.yml` (non-secret
config — host, API endpoint, git protocol) plus keyring entries for both `gh` and `glab`. No token value was read from either; both were confirmed through their own
`auth status` / API identity calls, which report identity but never the secret.

## Not account-related, but part of the setup

- AI agent rules are installed machine-wide (canonical copy `~/.agents/AGENTS.md`, mirrored into each
  agent's own global file). They carry the browser-visibility rules, the credentials rules, the
  three-account table and the **ask-which-account-before-every-deploy** rule.
- This project's own rules are in [`../AGENTS.md`](../AGENTS.md); deployment steps are in
  [`../DEPLOY.md`](../DEPLOY.md).

## The one habit that prevents every wrong-account mistake

```bash
wrangler whoami        # state the resolved account out loud before publishing
```

A Worker deploy is pinned by `wrangler.toml`, but a **Pages deploy carries no account binding in
config at all** — the credential alone decides where the page lands. And wrangler can *assert* an
account rather than derive it (see [DEPLOY.md](../DEPLOY.md)); when it does, it will happily send a
request for one account while authenticated as another, and only the API rejects it. So pass the
account explicitly for anything that writes:

```bash
CLOUDFLARE_ACCOUNT_ID=8660293d… wrangler deploy
```
