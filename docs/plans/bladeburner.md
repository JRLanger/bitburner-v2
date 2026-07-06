# Implementation Plan: `bladeburner` — Bladeburner manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md` (focus brokerage — this manager is the
main consumer of it). Relevant in BN6/BN7 (win condition) and, with SF6/7, as a
side-channel elsewhere. Note: in BN7 the API is available natively; elsewhere API
access needs SF7.

## Division of labor (the key design decision, recorded)

Bladeburner actions occupy the **player** (they conflict with faction/company
work), so per arbitration Decision 1 this manager **never calls `startAction`
itself for the player**. It:

1. Does all the thinking (city, stamina, skill points, action choice).
2. Publishes `focusRequest: {action: {type, name}, urgency}` on its status port.
3. Pilot's ladder (row 3 in BN6/7, row 7 elsewhere) executes
   `ns.bladeburner.startAction(type, name)` when bladeburner owns focus, and
   `stopBladeburnerAction()` when focus is reassigned.

Exception that needs no focus: **sleeve support** — it publishes
`sleeveRequest: {action}` for the sleeve manager (sleeves ladder row 5), since
`setToBladeburnerAction` runs on sleeves, not the player.

Everything that is NOT a player action, the manager does directly each tick:
`upgradeSkill`, `switchCity`, `setActionAutolevel`, team sizing.

## API (verified, `ns.bladeburner.*`)

Join: `joinBladeburnerDivision()`, `inBladeburner()`, `joinBladeburnerFaction()`.
Actions: `getContractNames()`, `getOperationNames()`, `getGeneralActionNames()`,
`getNextBlackOp()` (name + rank required), `startAction(type, name)`,
`stopBladeburnerAction()`, `getCurrentAction()`,
`getActionEstimatedSuccessChance(type, name)` (returns range `[lo, hi]` — verify),
`getActionCountRemaining`, `getActionTime`. Skills: `getSkillPoints()`,
`getSkillNames()`, `getSkillLevel/UpgradeCost`, `upgradeSkill(name, count)`.
Intel: `getCityEstimatedPopulation/Communities/Chaos(city)`, `getCity()`,
`switchCity(city)`. Stamina: `getStamina()` → `[cur, max]`. Rank: `getRank()`,
`getBlackOpRank(name)`. Tick: `await nextUpdate()` (race-guarded, arbitration
exception 4).

## Policy (standard proven loop, recorded)

Per tick, compute the desired action:

1. **Join**: if not `inBladeburner()`, `joinBladeburnerDivision()` (requires
   combat stats ≥100 — publish a `focusRequest {action:'train-combat'}` until
   join succeeds in BN6/7; elsewhere just wait). Also `joinBladeburnerFaction()`
   when rank ≥ 25 (unlocks the faction's augs for pilot).
2. **Stamina gate**: if `cur/max < BB_STAMINA_FLOOR` (0.5) → desired =
   `General/Hyperbolic Regeneration Chamber` until `> BB_STAMINA_RESUME` (0.9).
   (Low stamina tanks success chance; hysteresis prevents flapping.)
3. **Uncertainty gate**: if success-chance estimate range width >
   `BB_CHANCE_WIDTH_MAX` (0.15) → desired = `General/Field Analysis` (narrows
   the estimate).
4. **Chaos gate**: if `getCityChaos(city) > BB_CHAOS_MAX` (50) → desired =
   `General/Diplomacy`.
5. **City selection**: switch to the city with max estimated population if the
   current city's population < `BB_CITY_MIN_POP` (1e9) (population drives
   success; switching is free).
6. **BlackOps**: if `getNextBlackOp()` rank met and success chance lo ≥
   `BB_BLACKOP_MIN_CHANCE` (0.95) → desired = that BlackOp. The final BlackOp
   ("Operation Daedalus") **completes the BitNode** — gate it behind the same
   player-consent rule as w0r1d_d43m0n: require runtime flag `bbFinishOk`
   (one-shot util `utils/finish-bb.js`), per lifecycle plan Part C philosophy.
7. **Otherwise**: highest-tier Operation, else Contract, with
   `chance lo ≥ BB_ACTION_MIN_CHANCE` (0.7) and count remaining > 0; tie-break by
   rank-gain/sec. Set autolevel on.
8. **Skills**: spend all skill points every tick, priority order (recorded):
   `Blade's Intuition > Digital Observer > Reaper > Evasive System > Cloak >
   Short-Circuit > rest cheapest-first`.
9. Publish `focusRequest` (desired action) + `sleeveRequest`
   (`Field Analysis` early, `Infiltrate Synthoids` once shock is handled —
   sleeve infiltration boosts everything) + status.

## Status (port 12)

`{ ts, rank, stamina: [cur,max], city, chaos, skillPoints, nextBlackOp,
blackOpReady: bool, focusRequest, sleeveRequest }`

## Gate & constants

Gate: `MECHANIC_ENABLE[bn].bladeburner` && (BN6 || BN7 || SF7 owned).

```js
export const STATUS_PORT_BLADEBURNER = 12;
export const BB_STAMINA_FLOOR = 0.5;
export const BB_STAMINA_RESUME = 0.9;
export const BB_CHANCE_WIDTH_MAX = 0.15;
export const BB_CHAOS_MAX = 50;
export const BB_CITY_MIN_POP = 1e9;
export const BB_ACTION_MIN_CHANCE = 0.7;
export const BB_BLACKOP_MIN_CHANCE = 0.95;
```

## Testing

1. Focus handshake: manager requests → pilot starts action → reassign focus →
   pilot stops action; no direct startAction from the manager (grep the file).
2. Stamina hysteresis: drain stamina, watch regen at 0.5, resume at 0.9, no flap.
3. BlackOp consent: rank+chance met without `bbFinishOk` → alert only, no action.
4. Skill spend: points hit 0 each tick in priority order.
5. RAM: bladeburner calls are cheap; verify `mem` fits home budget.

## Docs

`docs/scripts/bladeburner.md` + devlog stage (record the focus-brokerage split and
policy thresholds).
