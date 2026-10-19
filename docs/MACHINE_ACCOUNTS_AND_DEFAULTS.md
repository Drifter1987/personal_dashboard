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

## GitHub repositories — backup tree and the disposition decision, 2026-10-16

Three GitHub accounts own **13 repositories** between them (1 + 6 + 6). What happens to each one is
decided below, next to where the offline copy of it lives.

### The backup tree

| What | Where |
|---|---|
| 13 working clones, full history | `Documents/AI_Workspace/02_Projects/Ghazi_Tools/Repo_Backups/<account>/<repo>/` |
| Manifest: accounts, per-repo size, commits, verified HEAD, refresh recipe | `Repo_Backups/_MANIFEST.md` |
| GitHub metadata (issues, PRs, releases, wikis, gists — what a clone cannot carry) | `Repo_Backups/_metadata/2026-10-16_0245/` |
| How to take the next capture and diff it | `Repo_Backups/_metadata/README.md` + `snapshot.sh` |

Measured 2026-10-16: **340 MB**, 14,340 files, of which 75 KB is the metadata. Nothing in this
project otherwise pointed at it, which is why it is recorded here.

**Content-complete, verified 2026-10-16 against the live remotes:** every branch and tag present
with matching SHAs in all 13 clones (`G-B` carries 5 branches, `MyDashboard` 1 tag), no submodules
anywhere, no Git-LFS pointers, every working tree clean. These are working clones, not bare mirrors
— the files are directly usable. Note where a non-default branch lives: in a working clone it sits
under `refs/remotes/origin/*`, which a plain `git clone` of the backup does not carry — see the
restore drill below for the recipe that does.

Deliberately **not** captured: release asset bytes, gist contents (a gist is a common place to park
a credential), Actions secrets and variables, branch protection, collaborators, packages, caches,
Dependabot/code-scanning alerts, discussions — plus most restore-relevant settings (merge options,
topics, webhooks, deploy keys, Pages config).

**Protected from git:** `AI_Workspace/.gitignore` carries `Repo_Backups/` and `**/Repo_Backups/`,
and the folder carries its own `.gitignore` (`*` plus `!.gitignore`), so a workspace `git add -A`
cannot swallow the clones or the snapshots. Before those rules existed, it staged **42 entries**
from that folder: 13 embedded-repo gitlinks (one per clone) plus the manifest, log and metadata
files.

### Restore drill, 2026-10-16

A backup is worth exactly what a restore proves, so one repository was restored from its local clone
into a fresh directory and compared against a **fresh clone from GitHub** — a reference independent
of the backup tree. `ghaziomairi93/G-B` was chosen because it is the only repository here with more
than one branch, which is where the interesting failure mode lives.

| Check | Result |
|---|---|
| Every branch and tag by SHA — `main`, `version-1-floral`, `version-2-dark`, `version-2-peach`, `version-3-lavender` | **identical to GitHub** |
| Whole reachable object graph of the restore vs GitHub | **identical — 128 objects** |
| The backup's own object graph vs GitHub | **identical — all history present** |
| `git fsck --full --strict` on the restored copy | clean (exit 0) |
| Per branch: tree listing (mode + blob SHA + path) | **MATCH** on all five |
| Per branch: sha256 of every checked-out file | **BYTE-IDENTICAL** — 43 + 7 + 4 + 4 + 4 files |
| Re-pointed `origin` at GitHub, then `fetch` | clean; `origin/main` matches |

**The trap it exposed.** In a working clone the non-default branches exist only as
`refs/remotes/origin/*`, and `git clone` transfers **local** branches only. The naive restore — a
plain clone of the backup — came back with **1 of the 5 branches** and 25 objects short, while the
backup itself held everything. Nothing was ever at risk; the restore *method* was incomplete. Tags
do not have this problem: `MyDashboard`'s `v2.2.0` arrives in a plain clone (verified).

**The recipe that passes,** for any of the 13:

```bash
B=~/Documents/AI_Workspace/02_Projects/Ghazi_Tools/Repo_Backups
R="<account>/<repo>"
git clone --no-hardlinks "$B/$R" /path/to/fresh          # default branch and tags arrive here
cd /path/to/fresh
for br in $(git -C "$B/$R" for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin | grep -v '^HEAD$'); do
  git rev-parse --verify -q "refs/heads/$br" >/dev/null || git fetch origin "refs/remotes/origin/$br:refs/heads/$br"
done
git remote set-url origin https://github.com/$R.git       # point the restore back at GitHub
```

Two details that are easy to get wrong: `--no-hardlinks` is what makes the copy self-contained (a
default local clone shares objects with the backup instead of copying them), and the loop skips
branches the clone already has because git refuses to fetch into the branch currently checked out.

**Estate-wide, 2026-10-16: 13 of 13 PASS.** The same drill was run on every backup: each restored
from its local clone and compared with a fresh GitHub clone (refs, object graph, `fsck --strict`,
tree listings, sha256 of every checked-out file). Every backup was checked unchanged before and after
its run. Checked ref and file counts:

| Repository | Ref checked | Files | Result |
|---|---|---|---|
| `Drifter1987/personal_dashboard` | `main` | 31 | PASS |
| `ghaziomairi93/Claude-Session` | `main` | 2 | PASS |
| `ghaziomairi93/G-B` | `version-3-lavender` (all 5 branches) | 4 | PASS |
| `ghaziomairi93/GO-Houdini` | `main` | 2 | PASS |
| `ghaziomairi93/MyDashboard` | `tag:v2.2.0` | 4 | PASS |
| `ghaziomairi93/houdini-tools` | `main` | 4 | PASS |
| `ghaziomairi93/desktop-tutorial` | `main` | 1 | PASS |
| `len-golani/AutoParts` | `main` | 53 | PASS |
| `len-golani/CarDNA` | `main` | 148 | PASS |
| `len-golani/CarPartsFinder` | `main` | 13,647 | PASS |
| `len-golani/New_Stuff` | `main` | 6 | PASS |
| `len-golani/len-golani` | `main` | 1 | PASS |
| `len-golani/mep` | `main` | 1 | PASS |

`desktop-tutorial` is private and owned by a different account from the active `gh` login. Its first
run aborted before comparing anything, because the harness's account switch did not carry that
account's credentials into the git calls. It was re-run with the owning account's token supplied
inline for that one command, and it passed. The active login was left unchanged, and no token was
written to disk.

The drill's scratch copies were deleted afterward. The recipe above is the procedure for re-running it.

### Guard against nested repositories, 2026-10-16

`AI_Workspace/tools/check-embedded-repos.sh` is a read-only checker, installed as that repository's
`pre-commit` hook, so a future clone cannot be forgotten. It fails when an embedded repository is
staged as a gitlink, already committed as one, untracked and unignored (exactly the set `git add -A`
turns into a gitlink), or when anything under a nested `.git/` is tracked — the last of those only
fires on state git itself refuses to create (`git add -f` and `git update-index` both reject such a
path on git 2.53), so it is a leak detector rather than a prevention.

Measured 2026-10-16: exit 0 on the current tree in 2.1 s, exit 1 on a planted nested repository in
both the worktree and lab forms, and the hook blocks while such a repository exists. The workspace
repository has no commits yet, so the hook first fires on its first commit.

### Disposition — the owner's decision, 2026-10-16

**Decided, not executed.** No repository has been archived, no visibility has been changed, nothing
deleted. Making these changes on GitHub is a separate write action and needs its own go-ahead.

| Account | Repository | Today | Decision | Note |
|---|---|---|---|---|
| Drifter1987 | `personal_dashboard` | public | **stays live** | the remote behind this working copy; deployed on the drifter Cloudflare account — see [CLOUDFLARE_ACCOUNTS.md](CLOUDFLARE_ACCOUNTS.md) |
| ghaziomairi93 | `Claude-Session` | public | **stays live** | kept for testing with Claude Code |
| ghaziomairi93 | `desktop-tutorial` | private | **stays live** | kept as a learning reference |
| ghaziomairi93 | `MyDashboard` | public | **archive + private** | holds the only open issue (`#1`) and the only release (v2.2.0) in the estate — archiving freezes them read-only |
| ghaziomairi93 | `houdini-tools` | public | **archive + private** | where the estate's 3 pull requests live |
| ghaziomairi93 | `GO-Houdini` | public | **archive + private** | |
| ghaziomairi93 | `G-B` | public | **archive + private** | |
| len-golani | `CarPartsFinder` | public | **archive + private** | 41 MB, 13,647 files |
| len-golani | `mep` | public | **archive + private** | |
| len-golani | `New_Stuff` | public | **archive + private** | |
| len-golani | `len-golani` | public | **archive + private** | profile-README repo — archiving removes that README from the account's profile page |
| len-golani | `CarDNA` | private | **archive + private** | 32 commits |
| len-golani | `AutoParts` | private | **archive + private** | 51 MB |

After this lands, **`len-golani` is entirely read-only** (all six archived), `ghaziomairi93` keeps
two live repositories, and `Drifter1987` keeps one.

The condition attached to the decision: the local copies had to be complete **before** anything is
frozen — they are, per the verification above, and the capture
`Repo_Backups/_metadata/2026-10-16_0245/` already holds the issue, PR, release and wiki state that
archiving would freeze. The phase after execution is to work through the local clones to understand
the archived projects and rebuild them cleanly.

**Deliberately not done:** nothing archived, nothing made private, no repository deleted, and nothing
re-downloaded (the clones were already complete).

### Two repositories exist only on this machine

Found 2026-10-16 while protecting the live clones from the workspace's `git add -A`. Neither is part
of the 13 above, because neither has a remote — they are local git repositories with **no copy
anywhere else**.

| Repository | State | Note |
|---|---|---|
| `AI_Workspace/02_Projects/Ghazi_Tools/main-ADE/nexus` | 1 commit (`73a39a3`, 2026-06-04, GMO), 8 files, clean | scaffold of a Nexus AI orchestration app (Electron + React + TypeScript) — never pushed |
| `AI_Workspace/big_merge/MyTools-Export-2026-09-18/02_Projects/windows11-replicate` | 0 commits (unborn HEAD), 15 top-level entries, none committed | a `git init` nothing was ever committed to; files present, history empty |

Both are now ignored by the workspace `.gitignore`, so a `git add -A` can no longer reference them
as gitlinks pointing at history that no clone of the workspace could resolve. Making them recoverable
is a small, separate step: a remote for `nexus`, a first commit for `windows11-replicate`.

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
