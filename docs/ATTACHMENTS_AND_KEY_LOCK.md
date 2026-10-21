# Attachments and the provider key, at rest

Two things in the dashboard are worth more than the rest of it: the bytes of a file attached to a
card, and the metals provider key (BYOK) in Settings → Data sources. This page says exactly what a
passphrase does to them, what it does not do, and what happens if it is forgotten.

## What sits where

| What | Where it lives | With no passphrase | With a passphrase |
|---|---|---|---|
| File bytes | IndexedDB `pd_files` → store `files` | a `blob` field | an `enc` field: `{iv, ct}` — AES-GCM ciphertext |
| File name, type, size | the task record (in `pd_tasks`, and in an export) | plain | plain — **not** sealed |
| Provider key | localStorage `pd_metals_key` | the key itself | `pd_metals_key_enc`, ciphertext, and the plaintext key removed |
| The passphrase | nowhere | — | a random salt and an encrypted check value in `pd_lock` |

The key that does the sealing is derived from the passphrase with PBKDF2-SHA256 (310,000
iterations, 16-byte salt) and lives in memory for as long as the page is open. It is not written to
localStorage, IndexedDB, a cookie, the service worker or any export file, and there is no server in
this path — the Worker never sees an attachment, and neither does anything else.

## Setting it, using it, removing it

Settings → **Passphrase for what is stored**:

- **Set a passphrase** (eight characters or more): the salt and check value are written, then
  whatever is already stored is sealed in place — every file record, and the provider key.
- **Unlock**: asked for the first time you open a sealed file or the app needs the provider key.
  The unlock lasts for the session; a relaunch locks again.
- **Remove protection**: asks for the passphrase, puts every file back as a Blob and the key back
  in localStorage, then deletes the lock record.

Unlocking is asked where it is needed — the file viewer, a download, the provider-key field, the
Settings card — never at boot, so the rest of the dashboard opens without one.

## Editing a photo in place

The viewer opens an image at its own resolution and offers zoom, Fit, five colour looks, a crop, and
a copy. An edit is written **over the card's attachment**, not beside it: same `id`, same name, new
bytes, sealed again on the way in when a passphrase is set. A JPEG stays a JPEG; a format the canvas
cannot encode becomes a PNG and the name follows the bytes. **Undo** writes the uploaded bytes back
over the same record, so the original is one tap away until the viewer is closed. **Apply look**
bakes the chosen colour into the whole file the same way.

The crop rectangle is drawn on the screen and mapped back through the image's natural width, so a
fitted 4000 px photo still crops at 4000 px; the box shows the pixel size the result will have, not
the size on screen — and that figure is the figure the saved file gets, because the box is clipped
to the picture itself. The stage around a fitted photo is wider than the photo, and a drag that
starts in that grey used to keep its full width once the left edge reached the picture, which put a
shifted, wider crop in the file; the stroke now stops at the picture's edge.

An armed box is the edit, not a preview. **Apply**, **Save & replace**, **Save a copy** and **Copy**
all ask the same question — the whole file, or the box that has been dragged — so a crop is never
lost by pressing the footer's Save instead of the bar's Apply. Only **Download** takes the file as
it stands. **Fit** zooms to whatever percentage the whole picture needs, so a 3024 px phone photo
is visible in a phone-sized window rather than sitting wider than the screen at a 25 % floor.

## Recovery: there is no reset

There is no recovery code, no reset link and no support path. That is not an omission; it is what
"not stored anywhere" means. The passphrase is the only key to those bytes.

- **Export before you lock.** An export JSON (`Data` → Export JSON) carries the task records and
  the attachment *names*, and the file bytes can be saved one by one from the viewer. Anything you
  cannot afford to lose should be exported before a passphrase is set, or while the app is
  unlocked.
- **Forgotten passphrase.** The sealed records cannot be read by this app or any other. The
  honest recovery is: wipe the app's site data (Settings → Data → Wipe all data, or the browser's
  "clear site data") and start again — the tasks, cards and settings go with it. The sealed bytes
  go with it too, unreadable either way.
- **A browser that cannot derive a key** (no WebCrypto, e.g. a page opened from `file://`): the
  passphrase cannot be set at all, and the app says so rather than pretending to lock.
- **Losing the device** and restoring a browser backup elsewhere: the sealed records come with it,
  the passphrase does not. Without it they stay sealed.

## What is *not* covered

- Attachment **names** and the size/type in the task record are not sealed — they are part of the
  task list, they appear in exports and in search.
- The dashboard's own data (tasks, notes, events, habits, settings) is not encrypted at rest. The
  passphrase covers the file bytes and the provider key, which is what was asked for; treating it
  as full-database encryption would be wrong.
- While the app is unlocked, anything running in the page can read the decrypted bytes. The lock
  is about what is left on the device between sessions, not about a live session.

## The cloud copy

When cloud backup is on, every attachment is sent too, sealed by the cloud passphrase and split
into chunks (see [CLOUD_BACKUP.md](CLOUD_BACKUP.md)). A file the lock still seals is sent as its
sealed envelope, so backing up never needs the lock unlocked, and the lock record comes back with
the rest of the copy. Restoring a locked copy asks for the lock passphrase again, as it always does:
the restore clears this session's unlocked key rather than reusing it.

## Where the checks live

- `_ui.test.py` → *a passphrase seals the files and the provider key at rest*: seals a real record,
  asserts the stored record holds no Blob and no marker text, that the passphrase is not in storage,
  that a relaunch reads nothing until the passphrase is given, that the wrong passphrase is refused,
  that the right one returns the bytes unchanged, and that removing the lock puts both back.
- `_check.mjs` → the source-level invariants: where the key is derived, that the plaintext key is
  written only in the un-locked path, and that this file exists.
