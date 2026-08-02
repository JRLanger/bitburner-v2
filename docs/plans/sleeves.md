# Implementation Plan: `sleeves` — sleeve manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md` and research doc
`docs/reference/sleeves-and-grafting.md`. Requires BN10 (grants sleeves) or
SF10 (persists them). Sleeves are "extra players" that work in parallel — they
never contend for player focus, only for money (Mechanic capex class).

**Scope:** this plan is Duplicate Sleeves only. Grafting (`ns.grafting.*`) is a
separate BN10 mechanic — main-character-only, sequential, Entropy debuff — and
needs its own plan/manager (not yet written). See the research doc Part 2.

## API (verified, `ns.sleeve.*`)

`getNumSleeves()`, `getSleeve(i)` (stats incl. `shock`, `sync`), `getTask(i)`,
`setToIdle(i)`, `setToShockRecovery(i)`, `setToSynchronize(i)`,
`setToCommitCrime(i, crime)`, `setToFactionWork(i, faction, workType)`,
`setToCompanyWork(i, company)`, `setToGymWorkout(i, gym, stat)`,
`setToUniversityCourse(i, uni, course)`, `setToBladeburnerAction(i, ...)`,
`travel(i, city)`, `getSleevePurchasableAugs(i)`, `purchaseSleeveAug(i, aug)`,
`purchaseSleeve()`, `getSleeveCost()`, `upgradeMemory(i, amount)`,
`getMemoryUpgradeCost(i, amount)`.

## Design: priority ladder per sleeve (mirrors arbitration ladder, recorded)

`src/managers/sleeves.js`, port 11, fixed tick `SLEEVE_LOOP_SLEEP = 20_000` (no
nextUpdate() in this API). Community scripts run 1–5s ticks; 20s is fine here.
Note per this engine's RAM model, tick rate never saves RAM — RAM is charged per
distinct `ns` function referenced, so `getSleeve`/`getTask`/`setTo*` cost the same
whether the loop runs at 1s or 60s. Pick tick rate for responsiveness, not RAM.
Each tick, for each sleeve index, assign the top applicable task:

| # | Task | Applicable when | Why |
|---|---|---|---|
| 1 | Synchronize | `sync < SLEEVE_SYNC_MIN` (e.g. 95) | Sync scales exp transfer to player and to other sleeves **linearly** (`sync/100`, confirmed in game source `Sleeve/Work/Work.ts applySleeveGains`). Raise early — it multiplies every downstream gain |
| 2 | Shock recovery | `shock > SLEEVE_SHOCK_MAX` (highest first) | Shock multiplies down all gains. Only recover when shock is high; low shock decays passively while the sleeve does useful work |
| 3 | Karma homicide | gang manager status shows `phase:'karma'` | Primary karma grinders (see gang plan phase 0) |
| 4 | Faction work | pilot status shows a working faction, **and no other sleeve already works that faction** (one sleeve per faction — hard rule) | Stacks rep on the bottleneck faction — the single biggest sleeve payoff |
| 5 | Bladeburner contracts | bladeburner manager active and requests sleeve support (status field `sleeveRequest`) | Sleeves generate contract successes/rank in BN6/7 |
| 6 | Company work | pilot ladder row 4 active (company-rep grind), **and no other sleeve already works that company** (one sleeve per company — hard rule) | Stacks company rep |
| 7 | Gym (lowest combat stat) | early run, stats below `SLEEVE_STAT_FLOOR` | Feeds crime success + karma speed later |
| 8 | Crime: Heist | fallback | Money + modest stats, no downside |

One task change per sleeve per tick max; skip reassignment when current task
already matches (avoid resetting task progress).

**One sleeve per faction / per company (confirmed hard rule).** Rows 4 and 6 can
each be claimed by only one sleeve at a time — later sleeves fall through to the
next row. Track claimed faction/company within the tick. General rule still applies:
every `setTo*` falsy return → try next row (`setToFactionWork` returns
`boolean | undefined`; treat `undefined` as failure).

## Spending (Mechanic capex class, MECH_SPEND_FRAC cap)

- **Buy sleeves** (`purchaseSleeve()`, BN10 only) whenever
  `getSleeveCost() < MECH_SPEND_FRAC × money`.
- **Memory upgrades**: `upgradeMemory(i, 1)` cheapest-sleeve-first under the same
  cap; memory persists across resets → best long-term ROI in BN10.
- **Sleeve augs** (`getSleevePurchasableAugs`, requires `shock === 0`): augs persist
  until BitNode end (not wiped on player install); mults apply immediately, raw stats
  reset to 0 on purchase. So buy freely under the cap — **batch** cheapest-first (wait
  until several are affordable) to cut overhead. Expect the sleeve to drop back to the
  sync/shock/training rows right after a purchase (stat reset).

## Status (port 11)

`{ ts, count, avgShock, avgSync, tasks: {recovery:n, karma:n, faction:n, ...},
spentThisRun }`

## Gate & constants

Gate: `MECHANIC_ENABLE[bn].sleeves` && `ns.sleeve.getNumSleeves() > 0`.

```js
export const STATUS_PORT_SLEEVES = 11;
export const SLEEVE_LOOP_SLEEP = 20_000;
export const SLEEVE_SHOCK_MAX = 90;   // only actively recover when shock is high; low shock decays passively
export const SLEEVE_SYNC_MIN = 95;    // sync scales exp transfer linearly (sync/100) — keep it near max
export const SLEEVE_STAT_FLOOR = 100;
```

## Testing

1. Post-reset: sleeves with shock → recovery first; watch ladder progress rows.
2. Karma coordination: start gang manager in karma phase → sleeves flip to
   homicide; gang formed → they fall through to faction work.
3. Faction stacking: pilot works faction X → sleeves join X's rep grind; verify
   duplicate-work behavior and fallthrough.
4. No task thrash: identical assignment on consecutive ticks does not reset tasks.

## Docs

`docs/scripts/sleeves.md` + devlog note in the arbitration stage entry.
