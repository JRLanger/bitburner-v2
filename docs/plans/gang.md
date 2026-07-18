# Implementation Plan: `gang` — gang manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
**Amended 2026-07-17** after review against the source-verified mechanics in
`docs/reference/advanced/gang-guide.md`: added the RECRUIT→POWER→CLASH→DONE phase
model (the old design deadlocked — win chance never grows unless members are
assigned to the Territory Warfare *task*, which the old design only did after
warfare was already on), dynamic clash entry instead of a fixed 55% threshold,
and reversed the equipment policy (augmentations survive ascension; other gear
is wiped by it).
**Amended again 2026-07-17** after comparing with the previous playthrough's
`gangSF4.js` (ideas only — no code copied, per project rules). The two designs
independently converged on the same phase model and dynamic clash entry; adopted
its battle-tested refinements: absolute-gain ascension rule (A/B-tested in-game),
sequential arming with ascension locks, vigilante hysteresis, and the
rep→money gate in the DONE phase.
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
Also available in v3: `getRecruitsAvailable()` (recruit slots open now) and
`getInstallResult(name)` (post-install multiplier preview).
Karma: `ns.getPlayer().karma` (needs −54,000 to create a gang outside BN2).

## Phase 0 — formation (before `inGang()`)

> **Amended 2026-07-13 (arbitration Decision 1/4 amendments):** the player-assist
> karma grind (ladder row 2) no longer waits for faction-work to have nothing to
> do — grind rows compete by **weighted ETA** (`effectiveEta = ETA /
> GRIND_WEIGHTS[row]`; karma weight 1.5 favors it). The gang manager must publish
> its **karma ETA** with its `focusRequest` (remaining karma ÷ measured player
> karma rate, sleeves' share subtracted) and be **progress-tolerant**: focus
> arrives in stretches interleaved with other grinds, so keep publishing the
> request until `inGang()`. Homicide-chance training (train combat stats until
> `getCrimeChance("Homicide") >= KARMA_HOMICIDE_MIN_CHANCE`) is handled INSIDE
> pilot's row 2, mirroring its crime-row train-or-commit pattern — not by the
> stat-training row (see docs/plans/faction-prereqs-training.md).

- In BN2: karma requirement is effectively waived (old-project notes suggest a
  tiny −2 threshold may apply — one crime's worth; verify in-game). Attempt
  `createGang(GANG_FACTION)` every tick once the faction is joined — it returns
  false until eligible, true on success, so no separate eligibility check is
  needed. (Pilot handles joining; gang manager publishes `focusRequest: none`,
  just waits.)
- Outside BN2 (SF2 owned): karma must reach −54,000. **Sleeves are the primary
  grinders** (sleeve manager assigns Homicide when gang manager publishes
  `karmaNeeded` in status); the player assists via arbitration ladder row 2 only
  when sleeves alone won't get there within `KARMA_PLAYER_ASSIST_HORIZON_MS`.
- `GANG_FACTION = 'Slum Snakes'` (easiest combat-gang invite). Recorded decision:
  **combat gang, not hacker gang** — combat gangs earn more and don't compete with
  the controllers' hacking-skill focus. Override constant if the player prefers.

## Phase 1 — running the gang (phase model, per gang-guide.md)

Lifecycle: **RECRUIT → POWER → CLASH → DONE**, derived fresh each tick from API
state (member count, min win chance, territory) — nothing in-memory-only.
Per `await nextUpdate()` tick (with 30 s race guard):

1. **Recruit** whenever `canRecruitMember()` — names `g0`, `g1`, ...: pick the
   lowest index not present in `getMemberNames()` (death-safe — clash losses can
   *kill* members, so derive the roster from the API every tick and never assume
   a member still exists). Never reuse NS-function names.
2. **RECRUIT phase** (fewer than 12 members): respect first, not $/sec. Getting
   to 12 members is the biggest lever (power scales linearly with roster size).
   Strongest 1–2 members: `Terrorism` (highest respect, unlocks slots fastest);
   everyone below `GANG_TRAIN_THRESHOLD` (avg combat stat < 200): `Train Combat`.
   Money is secondary here — equipment is bought with player money, not gang income.
3. **POWER phase** (12 members, min win chance still growing): all ready members
   on the `Territory Warfare` **task** with `setTerritoryWarfare(false)` (clashes
   OFF). Power — and hence win chance — grows ONLY from members assigned to this
   task; there is no other way to raise it. Trainees keep training.
4. **CLASH phase** — dynamic entry, not a fixed threshold. Track min win chance
   (over ALL rivals — clashes hit every rival at once) in a rolling window; enter
   when ALL of: min chance ≥ `GANG_CLASH_MIN_CHANCE` (0.55, safety floor), growth
   over the window < `GANG_CLASH_GROWTH_MIN` (near the W_max ceiling — entering
   at bare 55% is ~6× slower to 100% territory), and members are equipped. Then
   `setTerritoryWarfare(true)` and **keep everyone on the Territory Warfare task**
   so power keeps growing while NPC power decays. Income drops to ~0 during CLASH
   — this is an accepted trade-off (record in status so pilot doesn't treat the
   income collapse as a fault). CLASH is **sticky**: once entered, only the min
   chance falling below the floor reverts to POWER — growth un-flattening does
   not. On a CLASH→POWER revert, clear the win-chance history (stale CLASH
   values would read as falsely-flat growth and re-trigger entry immediately).
5. **DONE phase** (territory ≥ 0.99): `setTerritoryWarfare(false)`. **Rep→money
   gate:** faction reputation for the gang's faction accrues in proportion to
   respect (engine: Gang.ts), so earners stay on `Terrorism` (respect) until
   `ns.singularity.getFactionRep(faction)` ≥ the highest
   `getAugmentationRepReq()` among `getAugmentationsFromFaction(faction)`
   (excluding NeuroFlux Governor and already-owned augs — target computed once
   at startup), then switch to the best money task (iterate `getTaskNames()`,
   score with `getTaskStats` vs member stats, pick highest expected $/sec; early
   members `Mug People`, scaling to `Human Trafficking`). Publish the current
   focus (`respect`/`money`) in status. Singularity names verified in v3 defs.
6. **Wanted penalty** (all phases) — count hysteresis: keep an integer
   `vigilanteTarget`; +1 when `wantedPenalty < GANG_WANTED_PENALTY_FLOOR` (0.95)
   AND `wantedLevelGainRate > 0`; −1 when `wantedLevelGainRate <= 0`. Assign that
   many (weakest) earners to `Vigilante Justice` (pulling from TW if needed).
7. **Ascension — absolute-gain rule** (A/B-tested in the old playthrough; beats
   a fixed ratio, which becomes unreachable at high multipliers and over-fires
   at low ones): ascend when `(ratio − 1) × currentMult ≥ GANG_ASCEND_ABS_GAIN`
   (0.70), where `ratio` is from `getAscensionResult(name)` (it returns the
   new/old **ratio**, not the new value) averaged over the four combat stats,
   and `currentMult` is the member's average combat `*_asc_mult`. Ascension
   resets the member's XP, **wipes purchased non-aug gear, and lowers gang
   respect** — the lock in step 8 protects gear; skip ascending if it would lose
   the next recruit slot during RECRUIT.
8. **Equipment — sequential arming + ascension locks** (resolves the
   gear-vs-ascend tension): augs **survive ascension** — buy for any member,
   any phase after RECRUIT, when money ≥ `GANG_AUG_SAFETY_MULT` (5) × cost.
   Non-aug gear (wiped by ascension; skip Rootkits — combat gang) is bought for
   ONE member at a time — the strongest unequipped member, cheapest item first —
   tracked in an `equipped` set. Ascension locking: in POWER, `equipped` members
   + the current equip target are locked; unequipped members ascend freely
   (nothing to lose). In CLASH, only the equip target is locked; anyone else who
   ascends is dropped from `equipped` and re-armed on later ticks. No equipment
   purchases during RECRUIT (full roster first). DONE phase: buy income-relevant
   gear (non-Rootkit) for everyone. Budget: also respect the `MECH_SPEND_FRAC`
   cap and `GANG_EQUIP_BUDGET_FRAC` (0.1) × money.

## Status (port 10)

`{ ts, phase: 'karma'|'recruit'|'power'|'clash'|'done', karmaNeeded, members, avgStats, respect,
wantedPenalty, income, territory, warfare: bool, focus: 'respect'|'money'|null, focusRequest }`
`focusRequest` = `{action:'karma-homicide'}` during phase 0 shortfall, else null.
`focus` = DONE-phase rep→money gate state (null outside DONE). Income gotcha:
`getGangInformation().moneyGainRate` is per 200 ms game cycle — multiply by 5
for real $/sec before publishing.

## Gate

`MECHANIC_ENABLE[bn].gang` && (`ns.gang.inGang()` || BN2 || SF2 owned).
Launch position: after lifecycle (see arbitration launch order). RAM: the gang
API itself runs ~30+ GB with the full feature set (clash/ascend/equipment/tasks),
plus ~8.5 GB for the rep-gate Singularity calls (`getAugmentationsFromFaction`,
`getAugmentationRepReq`, `getFactionRep`) — accepted cost. Verify with `mem`
and fit the 25% home budget.

## Constants (add with implementation)

```js
export const STATUS_PORT_GANG = 10;
export const GANG_FACTION = 'Slum Snakes';
export const GANG_TRAIN_THRESHOLD = 200;    // old run used 300 — tune in-game
export const GANG_WANTED_PENALTY_FLOOR = 0.95;
export const GANG_ASCEND_ABS_GAIN = 0.70;   // absolute mult gain, not a ratio
export const GANG_AUG_SAFETY_MULT = 5;      // buy aug only when money ≥ 5× cost
export const GANG_EQUIP_BUDGET_FRAC = 0.1;
export const GANG_CLASH_MIN_CHANCE = 0.55;   // safety floor, not the entry trigger
export const GANG_CLASH_GROWTH_MIN = 0.005;  // enter CLASH when win Δ < this over the window
export const GANG_WIN_HISTORY_MS = 180_000;  // rolling win-chance window (~3 min)
```

## Testing

1. BN2 fresh: gang forms as soon as Slum Snakes joined; members recruit/train.
2. Wanted spiral: force money tasks on weak members, confirm vigilante rebalance
   pulls penalty back above floor.
3. Ascension: verify no ascend-loop (absolute-gain threshold prevents
   thrashing), locked members never ascend, and an ascended member is dropped
   from the `equipped` set and re-armed.
3b. Rep gate: in DONE, earners stay on Terrorism until faction rep covers the
   highest gang-faction aug requirement, then flip to money tasks (status
   `focus` reflects the switch).
4. Warfare: confirm POWER phase puts members on the Territory Warfare task with
   clashes off and win chance actually climbs; confirm CLASH entry waits for
   growth to flatten, and reverts to POWER if min chance drops below the floor.
5. Member death during CLASH: kill scenario — manager re-derives roster from
   `getMemberNames()` and recruits a replacement without name collisions.
6. Reset survival: manager relaunches into `inGang()==true` and resumes cleanly
   (all state derived from API, none in-memory-only; the win-chance history
   window simply refills after a restart — worst case CLASH entry is delayed one
   window length).

## Docs

`docs/scripts/gang.md` + devlog stage (record combat-vs-hacker and threshold
decisions).
