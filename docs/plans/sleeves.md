# Implementation Plan: `sleeves` — sleeve manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md`. Requires BN10 (grants sleeves) or
SF10 (persists them). Sleeves are "extra players" that work in parallel — they
never contend for player focus, only for money (Mechanic capex class).

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
nextUpdate() in this API). Each tick, for each sleeve index, assign the top
applicable task:

| # | Task | Applicable when | Why |
|---|---|---|---|
| 1 | Shock recovery | `shock > SLEEVE_SHOCK_MAX` (highest first; 96+ sleeves are useless) | Shock gates all sleeve effectiveness |
| 2 | Synchronize | `sync < SLEEVE_SYNC_MIN` (e.g. 80) | Sync scales stat gain transfer |
| 3 | Karma homicide | gang manager status shows `phase:'karma'` | Primary karma grinders (see gang plan phase 0) |
| 4 | Faction work | pilot status shows a working faction; sleeve works the **same faction** it can (different work type allowed) | Stacks rep on the bottleneck faction — the single biggest sleeve payoff |
| 5 | Bladeburner contracts | bladeburner manager active and requests sleeve support (status field `sleeveRequest`) | Sleeves generate contract successes/rank in BN6/7 |
| 6 | Company work | pilot ladder row 4 active (company-rep grind) — same company | Stacks company rep |
| 7 | Gym (lowest combat stat) | early run, stats below `SLEEVE_STAT_FLOOR` | Feeds crime success + karma speed later |
| 8 | Crime: Heist | fallback | Money + modest stats, no downside |

One task change per sleeve per tick max; skip reassignment when current task
already matches (avoid resetting task progress).

**Caveat to verify at implementation:** multiple sleeves working the same faction —
the game may forbid duplicate faction work across sleeves (returns false). Handle
by falling through to the next ladder row on a false return (general rule: every
`setTo*` false → try next row).

## Spending (Mechanic capex class, MECH_SPEND_FRAC cap)

- **Buy sleeves** (`purchaseSleeve()`, BN10 only) whenever
  `getSleeveCost() < MECH_SPEND_FRAC × money`.
- **Memory upgrades**: `upgradeMemory(i, 1)` cheapest-sleeve-first under the same
  cap; memory persists across resets → best long-term ROI in BN10.
- **Sleeve augs** (`getSleevePurchasableAugs`): buy only when `shock === 0`
  (augs reset shock progress is not the issue — augs are wiped on player install?
  **Verify at implementation**: sleeve augs persist until BitNode end, not until
  install — if so, buy freely under cap, cheapest first).

## Status (port 11)

`{ ts, count, avgShock, avgSync, tasks: {recovery:n, karma:n, faction:n, ...},
spentThisRun }`

## Gate & constants

Gate: `MECHANIC_ENABLE[bn].sleeves` && `ns.sleeve.getNumSleeves() > 0`.

```js
export const STATUS_PORT_SLEEVES = 11;
export const SLEEVE_LOOP_SLEEP = 20_000;
export const SLEEVE_SHOCK_MAX = 10;
export const SLEEVE_SYNC_MIN = 80;
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
