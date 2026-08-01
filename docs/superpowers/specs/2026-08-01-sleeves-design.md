# Design: `sleeves` — duplicate-sleeve manager

Status: **approved design, not started**. Written 2026-08-01 against Netscript
v3.0.1 defs. Supersedes the ladder in `docs/plans/sleeves.md` (this is that plan
minus the Bladeburner and Company rows — see Dropped rows below).

Prereq reading: `docs/plans/arbitration.md`, `docs/reference/sleeves-and-grafting.md`.
Requires BN10 (grants sleeves) or SF10 (persists them). Sleeves are "extra players"
that work in parallel — they never contend for player focus, only for money
(Mechanic capex class, shared `MECH_SPEND_FRAC` cap).

**Scope:** Duplicate Sleeves only. Grafting (`ns.grafting.*`) is a separate
main-character-only BN10 mechanic and gets its own plan/manager.

## Operating model

**Per-sleeve independent, not one global mode.** Each sleeve runs the ladder
independently every tick, so different sleeves land on different rows at the same
time (one recovers shock, one grinds the pilot's faction, the rest do crime). The
only cross-sleeve coordination is the one-per-faction claim in row 4.

## Module

`src/managers/sleeves.js`, status port 11, fixed tick `SLEEVE_LOOP_SLEEP = 20_000`
(no `nextUpdate()` in this API). Per this engine's RAM model, tick rate never saves
RAM — RAM is charged per distinct `ns` function referenced, so the tick rate is
chosen for responsiveness, not RAM.

Gate: `MECHANIC_ENABLE[bn].sleeves && ns.sleeve.getNumSleeves() > 0`.

## API (verified, `ns.sleeve.*`)

`getNumSleeves()`, `getSleeve(i)` (stats incl. `shock`, `sync`), `getTask(i)`,
`setToIdle(i)`, `setToShockRecovery(i)`, `setToSynchronize(i)`,
`setToCommitCrime(i, crime)`, `setToFactionWork(i, faction, workType)`,
`setToGymWorkout(i, gym, stat)`, `travel(i, city)`,
`getSleevePurchasableAugs(i)` (requires `shock===0`), `purchaseSleeveAug(i, aug)`,
`purchaseSleeve()`, `getSleeveCost()`, `upgradeMemory(i, amount)`,
`getMemoryUpgradeCost(i, amount)`.

## Priority ladder (per sleeve, first applicable wins)

| # | Task | Applicable when | Why |
|---|------|-----------------|-----|
| 1 | Synchronize | `sync < SLEEVE_SYNC_MIN` (95) | Sync scales exp transfer to player and other sleeves **linearly** (`sync/100`, confirmed in game source `Sleeve/Work/Work.ts applySleeveGains`). Raise early — multiplies every downstream gain |
| 2 | Shock recovery | `shock > SLEEVE_SHOCK_MAX` (90), highest-shock first | Shock multiplies down all gains. Only recover when high; low shock decays passively while the sleeve does useful work |
| 3 | Karma homicide | gang status `phase === "karma"` | Primary karma grinders (gang plan phase 0) |
| 4 | Faction work | pilot status `working === true` and `augs.workTarget.faction` set, **and no other sleeve already claimed that faction this tick** | Stacks rep on the bottleneck faction — the single biggest sleeve payoff |
| 5 | Gym (lowest combat stat) | any combat stat `< SLEEVE_STAT_FLOOR` (100); `travel(i, "Sector-12")` first (Powerhouse Gym) | Feeds crime success + karma speed later |
| 6 | Crime: Heist | fallback | Money + modest stats, no downside |

**Rules:**
- One task change per sleeve per tick max; skip reassignment when the current task
  already matches the target row (avoid resetting task progress / thrash).
- Every `setTo*` falsy return → fall through to the next row. `setToFactionWork`
  returns `boolean | undefined`; treat `undefined` as failure.
- **One sleeve per faction (hard rule).** Track the claimed faction within the tick.
  Pilot exposes only one target faction at a time, so in practice one sleeve grinds
  it and the rest fall through to gym/crime.

## Dropped rows (re-add later — reminders left in the source plans)

- **Bladeburner** (was row 5): no bladeburner manager exists to publish
  `sleeveRequest`. Reminder in `docs/plans/bladeburner.md`.
- **Company work** (was row 6): pilot publishes no company target to mirror.
  Reminder in `docs/plans/faction-prereqs-training.md`.

## Spending (Mechanic capex class, `MECH_SPEND_FRAC` cap = 0.25)

Each tick, under the shared cap:
- **Buy sleeves** (`purchaseSleeve()`, BN10 only) whenever
  `getSleeveCost() < MECH_SPEND_FRAC × money`.
- **Memory upgrades** (`upgradeMemory(i, 1)`) cheapest-sleeve-first; memory persists
  across resets → best long-term ROI in BN10.
- **Sleeve augs** (`getSleevePurchasableAugs`, requires `shock===0`): batch
  cheapest-first (wait until several are affordable) to cut overhead. Augs persist
  until BitNode end; mults apply immediately, raw stats reset to 0 on purchase — so
  expect the sleeve to drop back to sync/shock/gym rows right after a purchase.

## Status (port 11)

```
{ ts, count, avgShock, avgSync,
  tasks: { sync, recovery, karma, faction, gym, crime },  // counts per row
  spentThisRun }
```

## Constants (`src/config/constants.js`)

```js
export const STATUS_PORT_SLEEVES = 11;
export const SLEEVE_LOOP_SLEEP = 20_000;
export const SLEEVE_SHOCK_MAX = 90;   // only actively recover when shock is high; low shock decays passively
export const SLEEVE_SYNC_MIN = 95;    // sync scales exp transfer linearly (sync/100) — keep near max
export const SLEEVE_STAT_FLOOR = 100;
```

## Testing

1. Post-reset: sleeves with high shock → recovery first; watch ladder rows progress.
2. Karma coordination: gang in karma phase → sleeves flip to homicide; gang formed
   (phase leaves "karma") → they fall through to faction work.
3. Faction stacking: pilot works faction X (`working===true`,
   `augs.workTarget.faction===X`) → one sleeve joins X's rep grind; verify the
   one-per-faction claim and that the rest fall through.
4. No task thrash: identical assignment on consecutive ticks does not reset tasks.
5. Spending: with money above the cap, verify sleeve/memory/aug purchases fire
   cheapest-first and respect `MECH_SPEND_FRAC`.

## Docs

`docs/scripts/sleeves.md` (via `/devlog`) + devlog note in the arbitration stage
entry, when implemented.
