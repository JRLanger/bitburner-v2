# Implementation Plan: `gang` — gang manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md`, `docs/plans/sleeves.md` (karma grind
is shared work). Requires BN2 (in-node) or SF2 (karma path) — see
`docs/plans/bitnode-strategy.md`.

## Goal

`src/managers/gang.js`: form a gang, recruit/train/ascend members, buy equipment,
run territory warfare safely, and route income tasks. Never-exit manager, port 10.

## API (verified, `ns.gang.*`)

`createGang(faction)`, `inGang()`, `getGangInformation()`, `getMemberNames()`,
`getMemberInformation(name)`, `canRecruitMember()`, `recruitMember(name)`,
`respectForNextRecruit()`, `getTaskNames()`, `setMemberTask(name, task)`,
`getTaskStats(task)`, `getEquipmentNames()`, `getEquipmentCost/Stats/Type(equip)`,
`purchaseEquipment(member, equip)`, `ascendMember(name)`,
`getAscensionResult(name)`, `setTerritoryWarfare(bool)`,
`getChanceToWinClash(gang)`, `getAllGangInformation()`, `await nextUpdate()`.
Karma: `ns.getPlayer().karma` (needs −54,000 to create a gang outside BN2).

## Phase 0 — formation (before `inGang()`)

- In BN2: karma requirement is waived — `createGang(GANG_FACTION)` as soon as the
  faction is joined (pilot handles joining; gang manager publishes
  `focusRequest: none`, just waits).
- Outside BN2 (SF2 owned): karma must reach −54,000. **Sleeves are the primary
  grinders** (sleeve manager assigns Homicide when gang manager publishes
  `karmaNeeded` in status); the player assists via arbitration ladder row 2 only
  when sleeves alone won't get there within `KARMA_PLAYER_ASSIST_HORIZON_MS`.
- `GANG_FACTION = 'Slum Snakes'` (easiest combat-gang invite). Recorded decision:
  **combat gang, not hacker gang** — combat gangs earn more and don't compete with
  the controllers' hacking-skill focus. Override constant if the player prefers.

## Phase 1 — running the gang (the standard proven policy, recorded)

Per `await nextUpdate()` tick (with 30 s race guard):

1. **Recruit** whenever `canRecruitMember()` — names `g0`, `g1`, ... (never reuse
   NS-function names).
2. **Per-member task assignment:**
   - Compute member "readiness" = average of combat stats.
   - Below `GANG_TRAIN_THRESHOLD` (e.g. avg stat < 200 post-ascension-multiplier):
     `Train Combat`.
   - Ready members: split by `GANG_VIGILANTE_BALANCE` — if
     `getGangInformation().wantedPenalty < GANG_WANTED_PENALTY_FLOOR` (0.95),
     assign enough members to `Vigilante Justice` to push penalty back up;
     the rest run the **best money task** the member can do (iterate
     `getTaskNames()`, score with `getTaskStats` vs member stats, pick highest
     expected $/sec; early members: `Mug People`, scaling to
     `Human Trafficking`).
   - Respect vs money: while `respectForNextRecruit()` is reachable within
     `GANG_RESPECT_PUSH_MS`, bias task scoring toward respect gain (more members
     compounds harder than more $/sec).
3. **Ascension:** ascend a member when `getAscensionResult(name)` multiplier gain
   ≥ `GANG_ASCEND_MULT` (1.5×) AND doing so won't drop wanted-penalty coverage.
   Classic threshold policy — simple and near-optimal.
4. **Equipment:** buy cheapest-first for ready members while cost <
   `MECH_SPEND_FRAC` cap and cost < `GANG_EQUIP_BUDGET_FRAC` (0.1) × money.
   Skip Augmentation-type equipment (persistent, expensive) until late run
   (money > `GANG_AUG_EQUIP_MONEY`).
5. **Territory warfare:** enable `setTerritoryWarfare(true)` only when min
   `getChanceToWinClash(other)` over all rival gangs ≥ `GANG_CLASH_MIN_CHANCE`
   (0.55); disable immediately when any rival drops us below it. Assign
   `Territory Warfare` task to members only while enabled and penalty is healthy.

## Status (port 10)

`{ ts, phase: 'karma'|'running', karmaNeeded, members, avgStats, respect,
wantedPenalty, income, territory, warfare: bool, focusRequest }`
`focusRequest` = `{action:'karma-homicide'}` during phase 0 shortfall, else null.

## Gate

`MECHANIC_ENABLE[bn].gang` && (`ns.gang.inGang()` || BN2 || SF2 owned).
Launch position: after lifecycle (see arbitration launch order). RAM: gang API is
cheap (~few GB) — verify with `mem` and fit the 25% home budget.

## Constants (add with implementation)

```js
export const STATUS_PORT_GANG = 10;
export const GANG_FACTION = 'Slum Snakes';
export const GANG_TRAIN_THRESHOLD = 200;
export const GANG_WANTED_PENALTY_FLOOR = 0.95;
export const GANG_ASCEND_MULT = 1.5;
export const GANG_EQUIP_BUDGET_FRAC = 0.1;
export const GANG_AUG_EQUIP_MONEY = 100e9;
export const GANG_CLASH_MIN_CHANCE = 0.55;
export const GANG_RESPECT_PUSH_MS = 30 * 60_000;
```

## Testing

1. BN2 fresh: gang forms as soon as Slum Snakes joined; members recruit/train.
2. Wanted spiral: force money tasks on weak members, confirm vigilante rebalance
   pulls penalty back above floor.
3. Ascension: verify no ascend-loop (multiplier threshold prevents thrashing).
4. Warfare: with a losing matchup, confirm warfare stays off.
5. Reset survival: manager relaunches into `inGang()==true` and resumes cleanly
   (all state derived from API, none in-memory-only).

## Docs

`docs/scripts/gang.md` + devlog stage (record combat-vs-hacker and threshold
decisions).
