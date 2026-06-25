# flags

**Location:** `src/lib/flags.js`

## What it does

A tiny shared helper for **runtime flags** that any script can read or write, backed by a
single Netscript port (`FLAG_PORT`, see `config/constants.js`). The port holds one plain
object; helpers read/merge/write individual keys.

Current flags stored here:
- `managersSeen` (booster) — list of manager filenames seen running this run, used to
  suppress relaunching a stopped/self-completed manager.
- `shareOff` (booster + `/utils/share-off.js` / `share-on.js`) — manual pause of RAM-sharing.

## How it works

`readFlags(ns)` peeks the port and returns the stored object (or `{}` when empty).
`writeFlags(ns, obj)` clears then writes, keeping the port a single slot. `getFlag` /
`setFlag` are key-level convenience wrappers (`setFlag` does a read-merge-write so it
preserves other keys).

All port ops (`peek` / `writePort` / `clearPort`) cost **0 GB**, so importing this module
adds no RAM to the importer — unlike a shared module that calls metered NS functions, which
would tax every importer for the full cost (see the import note in the booster devlog).

`writePort` clones with `structuredClone()`, so a plain object round-trips directly; **no
`JSON.stringify` is needed**. Each helper's read-modify-write is synchronous (no `await`),
so it is atomic against other scripts under Netscript's cooperative scheduling.

## Why it's built this way

**Ports are wiped on game restart AND on aug/soft reset** (verified in-game). That makes
a port the ideal home for any *per-run* flag: it
survives across ticks and across separate scripts, but clears the instant the run resets —
no reset detection required. This replaced booster's in-memory `launchedManagers` set, which
wrongly persisted (suppressing all managers) when the booster process survived a reset, and
let an interim hacking-level reset-detector be deleted. See `docs/devlog/02-booster.md`
("Manual-stop detection and self-kill").

A single shared object on one port (rather than one port per flag) keeps all runtime flags
discoverable in one place and leaves the rest of the port-number space free.

## Alternatives considered

- **In-memory module state** (a `Set`/`Map` per script): rejected — it doesn't clear on a
  reset that the script survives, which was the original manager-suppression bug.
- **A file flag** (`ns.write`/`ns.read`): files *persist* across resets and reloads, the
  opposite of what per-run flags want. (The `shareOff` flag was a file before this; moving
  it here means a manual pause lifts on a fresh run — the chosen behavior.)
- **One port per flag**: more port bookkeeping for no benefit; a shared object is simpler.
- **`JSON.stringify` round-trip**: unnecessary — `structuredClone` already handles plain
  objects through `writePort`.
