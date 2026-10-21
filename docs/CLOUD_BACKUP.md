# The encrypted cloud copy

The device backup (see [DEPLOY.md](../DEPLOY.md#a-release-never-resets-a-readers-data)) keeps the
records when the browser drops localStorage. It lives in the same container as the data, so it
cannot survive the app's storage being deleted from the OS, a lost or replaced phone, or a full
reset. This page is the second copy.

It is **one copy per device**, deliberately. A dashboard opened on ten phones holds ten different
sets of tasks; a single shared record would make a restore on one phone replace another phone's
work, which is the thing this feature must never do.

## What it is

Settings → **Export / Import → Cloud backup (encrypted)**. Off until it is turned on, and turning it
on asks for a passphrase.

| What | Where it lives | What the Worker sees |
|---|---|---|
| This device's records (`pd_settings`, tasks, events, countdowns, notes, habits, location, focus history, the lock record, the provider key) | sealed on the device | nothing readable |
| This device's attachments, one sealed chunk at a time (`bf:<account>:<dev>:<file>:<n>`) | sealed on the device | nothing readable |
| The key | derived from the passphrase, **memory only** | never sent |
| The account | PBKDF2 output, first 16 bytes | 32-character hex |
| This device's slot | a random 8-hex id in `pd_sync` | one key `bk:<account>:<dev>` per device |
| The list of slots | one KV entry per account, refreshed hourly | ids and timestamps only |

Sealing is AES-GCM-256 under a key derived with PBKDF2-SHA256 (310,000 iterations). One derivation
yields both halves: bytes 0–15 name the account, bytes 16–47 seal the slot. The server therefore
holds bytes it cannot decrypt, and no label a person typed — the list is ids and times only.

**Attachments are included.** Each file is sent as its own sealed chunk, so a wiped phone gets its
files back as well as its records. A file is sent once per version: an edit, a crop or a look
change is a new version and is sent again; an unchanged file is never re-sent. A file still sealed
by the passphrase lock travels as its envelope, so the cloud copy never needs the lock unlocked.
The snapshot names each attachment (id, name, type, size, version, chunk count); the bytes are
fetched only after every one of them has come down, so a restore that cannot reach a file changes
nothing on the device.

The chunks are 8 MiB of plaintext at most, so a 25 MB attachment is four of them; KV tops out at
25 MiB per value, and smaller chunks keep a failed upload cheap to retry. Each chunk's seal is bound to its file, version, position and
count, so a chunk moved to another file or two chunks swapped fail to open.

The records limit is 4 MB of plaintext per snapshot. Past it the save is refused with a message
rather than silently dropping records.

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

## Listing the devices

Settings → **Export / Import** → **Cloud backup** ends with **Devices with a cloud copy**: one row per
slot under the phrase, newest first, with the same short id and save time that device's own Data
card shows, `this device` on the row that is the phone you are holding, and **Forget** on every row.

- Opening the Data card asks the Worker for the list (a read, not a write).
- **Forget** deletes that device's uploaded copy and its entry in the list. The device it came from
  keeps its own records; forgetting is how a lost phone's slot stops being offered at a restore,
  not a way to reach into another phone.
- With the switch off, or after a relaunch while the key is memory-only, the panel offers
  **Show devices**: it asks for the phrase and lists the slots without enabling anything, which is
  exactly how a wiped phone recognises its own row before restoring.

## Recovering a wiped or new phone

1. Open the dashboard on the device.
2. Settings → **Export / Import** → **Restore from cloud**, and type the passphrase.
3. If the phrase has more than one slot, pick the one this phone was using — the id is on that
   device's Data card, and the Devices panel lists the same ids with their save times. Nothing is
   deleted by reading.
4. The records are written, the page is rebuilt in place, and the phone continues that same slot.

The passphrase is asked again after every relaunch, on every device. That is deliberate: the one
thing that must never sit on disk is the key to everything the Worker holds. The account, device id
and dates stay in `pd_sync`, so the card still knows which slot is this device's while it waits to
be unlocked.

## Turning it off, deleting it

- **Turn off** stops this device syncing; this device's copy stays.
- **Delete cloud copy** asks for confirmation and removes **this device's** slot, its attachment
  chunks and its entry in the list. Other devices keep theirs.

Neither action touches the records on the device.

## What this cannot do

- No recovery code and no reset. A forgotten phrase means unreadable copies — for everyone,
  including this app.
- No merge. Restoring is replacement.
- The newest 256 slots per account are listed; older ones stop appearing in the list (their records
  are not deleted, but a phone that lost its data cannot find them by id alone, and the Devices
  panel cannot show them to forget).
- Each snapshot save costs one KV write, and each attachment version costs one write per chunk.
  The free plan allows 1,000 writes a day for the whole account, so a device stops its automatic
  saves at 300; a tapped save still runs. A file is only written when its version changes, and a
  snapshot only when the payload changes; both are debounced by 8 seconds.
- Deleting a slot or a forgotten attachment lists its chunks under the prefix and deletes them. A
  list is paid only on that rare action, never on a save or a read.
- The backup lives in its own `BACKUP` KV namespace, separate from the `PUSH` namespace the
  reminders use, so exhausting the backup write quota cannot stop a reminder.
- End-to-end encryption means a compromised passphrase is a compromised copy; it does not protect
  against a device that is already unlocked and in someone else's hands.
