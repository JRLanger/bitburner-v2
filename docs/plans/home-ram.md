# Implementation Plan: Perpetual home-RAM upgrading (pilot phase)

Status: **IMPLEMENTED 2026-07-13** (same day as written; not yet RAM-measured in-game). Written 2026-07-13 against Netscript v3.0.1 defs.
Implementation order: **4th of the six-change batch** (after wallet-reservations —
the spend gate reads the generalized moneyFloor).

## Goal

Home RAM is currently upgraded only at bootstrap (`utils/boot-grind.js`
`mugToTarget()`, to `BOOT_TARGET_HOME_GB = 32`) and never again. But home RAM keeps
paying off all run (bigger batching pool, room for more managers), and its cost
curve often makes it the best available purchase mid-run. Add continuous home-RAM
upgrading that competes for money with other spenders under the existing
moneyFloor/reservation discipline.

## API facts (verified in docs/reference/NetscriptDefinitions.d.ts — re-verify before coding)

- `ns.singularity.upgradeHomeRam(): boolean` (L2113)
- `ns.singularity.getUpgradeHomeRamCost(): number` (L2140)
- Deferred (v1 excludes them, same gate would apply): `upgradeHomeCores` (L2128),
  `getUpgradeHomeCoresCost` (L2152).

## Owner: a new pilot phase, NOT a standalone manager

Per the static-RAM rule (game-mechanics.md rule 1), the cost of these two
singularity functions is charged to whichever *script* references them. A
standalone manager would pay a whole manager's base RAM + launch plumbing + a
MANAGERS-list slot for two function calls; pilot already carries the singularity
surface, so the marginal cost there is just the two functions (×16/×4/×1 by SF4
level). `boot-grind.js` keeps the bootstrap path unchanged (pilot isn't running
that early); `phaseHomeRam` takes over from 32 GB up.

## Decision rule — a gate, not a score

Arbitration Decision 4 forbids cross-domain computed ROI scores, so this is a
fraction gate like every other spender — and per user decision (2026-07-13) it
**never raids the aug-batch reservation**: it buys strictly from unreserved money.

```js
function phaseHomeRam(ns, snap) {
    if (snap.homeRam >= HOME_RAM_MAX_GB) return;
    const cost = ns.singularity.getUpgradeHomeRamCost();
    // snap.money is already max(0, raw - moneyFloor()) — floor + reservations,
    // so acquirable-aug money is invisible here by construction.
    if (cost > snap.money * HOME_RAM_SPEND_FRAC) return;
    if (ns.singularity.upgradeHomeRam()) snap.homeRam = ns.getServerMaxRam("home");
    // at most one upgrade per tick — keeps each buy observable, and the doubling
    // cost curve makes the frac gate self-limiting anyway
}
```

Constants (`config/constants.js`):

```js
export const HOME_RAM_SPEND_FRAC = 0.5;      // same class as pilot's other progression spends
export const HOME_RAM_MAX_GB = Infinity;     // escape hatch; game caps it anyway
```

Why the user's "augs cost 100t, RAM costs 50t → buy the RAM" example still works:
the aug-batch reservation only covers augs that are *already affordable*
(`countAcquirable`). Money being saved toward not-yet-affordable augs is
unreserved, so a cheap RAM upgrade wins it via this gate — while money that would
un-ready an already-ready aug is protected.

## Placement & data flow

- Phase order in pilot's tick: after `phaseTor`, before `phaseAugs` — so the aug
  readiness report sees post-purchase money the same tick.
- Snapshot: `gatherState` already reads `homeRam`; no change.
- Status (port 7): add `homeRamGB`, `nextHomeRamCost`, and count `homeRamBought`
  (per-process counter) for the dashboard; render one line in `renderStatus`.

## Interactions

- **Bootstrap ladder row 1** (`homeRam < 32 GB` → crime): unchanged; phaseHomeRam
  simply also runs then and will do the upgrading as money appears, which
  naturally clears row 1.
- **Lifecycle freeze**: `snap.money` is 0 under `moneyFloor = Infinity` → phase is
  inert during the checklist. Home RAM persists through installs, so anything
  bought is never wasted.
- **MANAGER_HOME_RAM_FRAC / launchManagers**: more home RAM enables deferred
  manager launches — no coupling needed, gates re-check each tick.

## RAM checklist

Adding 2 singularity functions to pilot: re-measure with `mem managers/pilot.js`
and update `PILOT_MANAGER_RAM` (constants.js — already flagged STALE; fix both at
once).

## Testing checklist

1. Fresh tick with plenty of money: confirm exactly one upgrade per tick until
   `cost > money × HOME_RAM_SPEND_FRAC`, and dashboard shows the new fields.
2. With an `augBatch` reservation active: confirm no upgrade happens when
   `raw money - reservation` can't cover the gate (reservation respected).
3. During a (dry-run) checklist freeze: confirm the phase goes inert.
4. `mem` re-measured; `PILOT_MANAGER_RAM` updated; booster still launches pilot.

## Documentation deliverables

- Amend `docs/plans/pilot-singularity.md` (new phase) — done alongside this plan.
- `/devlog` update for `docs/scripts/pilot.md` when implemented.
- Amendment note for v2: `upgradeHomeCores` under the same gate.
