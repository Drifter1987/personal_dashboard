# The encrypted cloud copy

The device backup (see [DEPLOY.md](../DEPLOY.md#a-release-never-resets-a-readers-data)) keeps the
records when the browser drops localStorage. It lives in the same container as the data, so it
cannot survive the app's storage being deleted from the OS, a lost or replaced phone, or a full
reset. This page is the second copy.

It is **one copy per device**, deliberately. A dashboard opened on ten phones holds ten different
sets of tasks; a single shared record would make a restore on one phone replace another phone's
work, which is the thing this feature must never do.

## What it is

Settings → **Planner → Export / Import → Cloud backup (encrypted)**. Off until it is turned on, and
turning it on asks for a passphrase.

| What | Where it lives | What the Worker sees |
|---|---|---|
| This device's records (`pd_settings`, tasks, events, countdowns, notes, habits, location, the lock record, the sealed provider key) | sealed on the device | nothing readable |
| The key | derived from the passphrase, **memory only** | never sent |
| The account | PBKDF2 output, first 16 bytes | 32-character hex |
| This device's slot | a random 8-hex id in `pd_sync` | one key `bk:<account>:<dev>` per device |
| The list of slots | one KV entry per account, refreshed hourly | ids and timestamps only |

Sealing is AES-GCM-256 under a key derived with PBKDF2-SHA256 (310,000 iterations). One derivation
yields both halves: bytes 0–15 name the account, bytes 16–47 seal the slot. The server therefore
holds bytes it cannot decrypt, and no label a person typed — the list is ids and times only.

**Attachments are not included.** File bytes stay in the device's `pd_files` database; the copy is
the records only (limit 42 KB of text).

## Ten devices, ten copies

There are no accounts in the app sense. The phrase names a *group* of slots, and each device writes
only its own:

- a device that is already set up keeps its slot;
- a new device takes a fresh random id, so two phones that know the same phrase never overwrite
  each other;
- the Data card shows this device's short id (the last four characters) and when its slot was last
  saved;
- a restore is therefore per device: list the slots, recognise your own by id and time, pull it.

A pull replaces the records the copy holds; it does not merge. The card says that too.

**A deploy touches none of this.** Publishing a release replaces files, never storage, so a device
that is not backed up is still exactly as it was — the copy is what answers when the *device* loses
its data, not when a version changes.

## Recovering a wiped or new phone

1. Open the dashboard on the device.
2. Planner → Data → **Restore from cloud**, and type the passphrase.
3. If the phrase has more than one slot, pick the one this phone was using — the id is on that
   device's Data card. Nothing is deleted by reading.
4. The records are written, the page is rebuilt in place, and the phone continues that same slot.

The passphrase is asked again after every relaunch, on every device. That is deliberate: the one
thing that must never sit on disk is the key to everything the Worker holds. The account, device id
and dates stay in `pd_sync`, so the card still knows which slot is this device's while it waits to
be unlocked.

## Turning it off, deleting it

- **Turn off** stops this device syncing; this device's copy stays.
- **Delete cloud copy** asks for confirmation and removes **this device's** slot (and its entry in
  the list). Other devices keep theirs.

Neither action touches the records on the device.

## What this cannot do

- No recovery code and no reset. A forgotten phrase means unreadable copies — for everyone,
  including this app.
- No merge. Restoring is replacement.
- The newest 256 slots per account are listed; older ones stop appearing in the list (their records
  are not deleted, but a phone that lost its data cannot find them by id alone).
- Each save costs one KV write, and the slot list is refreshed at most hourly per device, because
  KV allows roughly a thousand writes a day on the free plan. A hundred devices that each save a
  few times a day fit; a device syncing on every keystroke does not, which is why the push is
  debounced by 15 seconds and skipped when nothing changed.
- The KV namespace is the one the reminders already use (`PUSH`), under the `bk:` prefix. If a
  dedicated `BACKUP` namespace is declared later, the Worker prefers it with no code change.
- End-to-end encryption means a compromised passphrase is a compromised copy; it does not protect
  against a device that is already unlocked and in someone else's hands.
