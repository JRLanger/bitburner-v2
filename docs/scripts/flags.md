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
- `moneyFloor` (lifecycle sets it; pserver/hacknet/pilot honor it) — money every spending
  manager must leave untouched. Lifecycle sets it to `Infinity` in its pre-reset checklist to
  freeze all spending; the `moneyFloor(ns)` helper returns it (0 when unset). `structuredClone`
  in `writePort` preserves `Infinity` through the port.
- `reservations` (docs/plans/wallet-reservations.md, added 2026-07-13) — a map of
  `key -> {amount, owner, reason, ts}` earmarking money for a specific future purchase
  (currently one key: pilot's `augBatch`, the simulated cost of the augs the reset batch
  could currently afford). `moneyFloor(ns)` now returns the frozen floor flag **plus** the
  live sum of fresh reservations, so every spender that already computes
  `money = raw - moneyFloor(ns)` treats reserved money as untouchable with zero code
  changes of its own.
- `liquidate` (lifecycle → stocks) — reserved liquidation-ack handshake (arbitration Decision 2);
  no-op until the stocks manager exists.
- `autoInstall` (`/utils/auto-install-on.js` / `auto-install-off.js`) — arms lifecycle's
  automatic aug install (OR'd with the `LIFECYCLE_AUTO_INSTALL` constant).
- `focusOwner` / `pilotWorkSig` (pilot) — the ladder row currently owning player focus
  (arbitration focus protocol) and a signature of the work pilot itself started (so it can
  tell its own work from work the player began manually).

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

**Reservation ledger** (docs/plans/wallet-reservations.md). `setReservation(ns, key, amount,
owner, reason)` upserts one entry under `flags.reservations[key]`, stamping `ts = Date.now()`;
`clearReservation(ns, key)` removes one entry outright (a no-op if absent); `reservationsTotal(ns)`
sums every entry whose `ts` is still within `RESERVATION_TTL_MS` (5 min, `config/constants.js`) of
now, silently treating older entries as 0 without deleting them. `moneyFloor(ns)` is now
`getFlag(ns, "moneyFloor", 0) + reservationsTotal(ns)` — the frozen floor and the live
reservation total are additive, and `Infinity` in the frozen floor still dominates everything
regardless of what's reserved.

**Single writer per key.** Only one script ever writes a given reservation key — pilot owns
`augBatch` — so two scripts never race the same entry, and a writer must refresh its own entry
every tick it wants the reservation to keep counting (a dead writer's entry simply ages out, see
below). Because each key has exactly one writer, the read-modify-write in `setReservation`/
`clearReservation` needs no cross-script locking beyond the existing atomic-per-call guarantee.

This is why every existing spender (pserver, hacknet, pilot's own programs/donations/home-RAM)
respects reservations with **zero changes to its own code**: each already computes
`money = raw - moneyFloor(ns)` (arbitration.md Decision 2), and `moneyFloor` now folds the
reservation total in transparently.

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

**TTL enforced read-side, not by a pruning process.** `reservationsTotal` simply ignores
stale entries rather than deleting them, so a writer that dies (crashes, gets killed, or is
just a stale pilot process after a restart) has its reservation silently stop counting after
`RESERVATION_TTL_MS` with no separate cleanup pass to keep in sync with writers — the same
"no reset detection required" philosophy as the port-wipe design above, applied to a
shorter, in-run timescale. **Cross-run staleness is a non-issue by construction**: the whole
flag port — reservations included — is wiped on every reset (same as `managersSeen`), so a
reservation can never survive from one run into the next; the TTL only ever has to catch a
dead writer *within* a run.

## Alternatives considered

- **In-memory module state** (a `Set`/`Map` per script): rejected — it doesn't clear on a
  reset that the script survives, which was the original manager-suppression bug.
- **A file flag** (`ns.write`/`ns.read`): files *persist* across resets and reloads, the
  opposite of what per-run flags want. (The `shareOff` flag was a file before this; moving
  it here means a manual pause lifts on a fresh run — the chosen behavior.)
- **One port per flag**: more port bookkeeping for no benefit; a shared object is simpler.
- **`JSON.stringify` round-trip**: unnecessary — `structuredClone` already handles plain
  objects through `writePort`.
