# Implementation Plan: Virtual wallet — money reservations via the flag port

Status: **IMPLEMENTED 2026-07-13** (same day as written; not yet RAM-measured in-game). Written 2026-07-13 against Netscript v3.0.1 defs.
Implementation order: **2nd of the six-change batch** (after game-mechanics.md; before
donation-sizing, home-ram, faction-prereqs-training — they all read the generalized
floor this plan introduces).

## Goal

When an augmentation becomes acquirable (rep met AND money saved), that money is
currently unprotected: pserver, hacknet, pilot's own donations/programs, and the
future home-RAM phase can all spend it, un-readying the aug. Add a **reservation
ledger** so money earmarked for the reset aug batch is invisible to every other
spender — without touching any existing manager's buy path.

## Key insight

Every spending manager already computes
`money = max(0, homeMoney - moneyFloor(ns))` (arbitration.md Decision 2.2). So if
`moneyFloor()` is generalized to **frozen floor + live reservations**, all existing
spenders respect reservations with **zero changes to their code**.

## API facts (verified — all 0 GB)

- `ns.peek`, `ns.writePort`, `ns.clearPort` — port ops are free, so `lib/flags.js`
  stays a 0-GB import (game-mechanics.md rule 1).
- Ports are wiped on any reset (game-mechanics.md rule 2) → reservations are
  automatically per-run; no cross-run staleness possible.

## Architecture

Extend `src/lib/flags.js` in place — no new port, no new lib. A `reservations`
flag (on the existing flag port 1) holds a map:

```js
reservations: {
  augBatch: { amount: 3.2e12, owner: "pilot", reason: "acquirable augs", ts: 1760000000000 },
  // future keys: gangEquip, sleeveAugs, ... — one writer per key (see rules)
}
```

New functions in `lib/flags.js`:

```js
export function setReservation(ns, key, amount, owner, reason)  // upsert, stamps ts = Date.now()
export function clearReservation(ns, key)
export function reservationsTotal(ns)  // Σ amount over entries with ts newer than RESERVATION_TTL_MS
export function moneyFloor(ns)         // CHANGED: getFlag("moneyFloor", 0) + reservationsTotal(ns)
```

Constants (`config/constants.js`):

```js
export const RESERVATION_TTL_MS = 5 * 60_000; // stale entries stop counting (read-side; no pruner)
```

### Rules (amend arbitration.md Decision 2)

1. **Single writer per key.** Only one script ever writes a given reservation key
   (pilot owns `augBatch`). Writers refresh the entry every tick, so `ts` stays
   fresh; per-key read-modify-write via `getFlag`/`setFlag` is atomic under
   cooperative scheduling (no `await` inside — existing flags.js contract).
2. **TTL is enforced read-side** in `reservationsTotal`: if the writer dies, its
   reservation silently stops counting after `RESERVATION_TTL_MS`. No cleanup
   process needed.
3. **No raiding.** No spender may knowingly spend into a reservation — including
   the home-RAM phase (user decision 2026-07-13: home RAM buys from unreserved
   money only).
4. `moneyFloor = Infinity` (lifecycle's pre-reset freeze) still dominates
   everything; reservations are additive on top of the frozen floor.

## Writer: pilot `phaseAugs`

`countAcquirable(augs, money)` (pilot.js) already simulates the batch buy —
most-expensive-first with the ×1.9 ramp. Change it to also return the **cumulative
simulated cost** of the augs it counted:

```js
// countAcquirable returns { bought, cost }   (cost = Σ ramped prices of counted augs)
```

Then in `phaseAugs`, each tick:

```js
if (cost > 0) setReservation(ns, "augBatch", cost, "pilot", "acquirable augs");
else clearReservation(ns, "augBatch");
```

**Ordering caveat:** pilot's own `gatherState` snapshot subtracts `moneyFloor` —
which after this change includes pilot's own `augBatch` reservation. That is
correct for phases spending on *other* things (programs, donations, travel), but
`countAcquirable` itself must be fed **raw money minus only the frozen floor**
(the reservation IS that money) or the reservation would shrink itself to zero in
a feedback loop. Concretely: snapshot gains a second field,
`moneyForAugs = max(0, moneyRaw - getFlag("moneyFloor", 0))`, used only by
phaseAugs/countAcquirable/countReadyNeuroflux; everything else keeps using the
fully-floored `money`.

The same applies to lifecycle's `computeDecision`: it only *reads* pilot's
`acquirableNow`, so no change; `batchBuyAugs` runs under the checklist freeze with
the reservation cleared (below) and checks raw `getServerMoneyAvailable("home")`,
so it can spend the reserved money — as intended.

## Consumer/release: lifecycle checklist step 0

In `liquidateAndFreeze`, alongside `setFlag("moneyFloor", Infinity)`:

```js
clearReservation(ns, "augBatch"); // ledger honesty; Infinity floor dominates anyway
```

Port wipe at install handles everything else.

## Status/observability

- Pilot publishes `reservedForAugs` (the cost it wrote) on port 7.
- Dashboard: show `reserved` next to money (sum via `reservationsTotal` — free).

## Testing checklist

1. With ≥1 acquirable aug, confirm the flag port shows the `augBatch` entry and
   that pserver/hacknet stop buying when free money < their next purchase cost
   even though raw money would cover it.
2. Kill pilot; after `RESERVATION_TTL_MS`, confirm spenders resume (TTL works).
3. Confirm `acquirableNow` does not oscillate after the change (the
   `moneyForAugs` feed prevents the self-shrink loop).
4. Confirm lifecycle's batch buy still spends the full amount at reset.

## Documentation deliverables

- Amend `docs/plans/arbitration.md` Decision 2 (done alongside this plan).
- `/devlog` update for `docs/scripts/flags.md` and `docs/scripts/pilot.md` when
  implemented.
