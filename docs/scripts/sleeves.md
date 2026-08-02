# sleeves

**Location:** `src/managers/sleeves.js`

## What it does

Fully autonomous duplicate-sleeve manager for BN10/SF10. Each tick it assigns
every sleeve its highest-priority task from a fixed ladder (sync → shock
recovery → karma → faction → gym → crime), spends under the shared
`MECH_SPEND_FRAC` cap on new sleeves/memory/augs, and logs machine-checkable
evidence. Sleeves never contend for player focus — they run in parallel with
pilot and gang, coordinating only through two read-only status peeks (gang's
karma phase, pilot's worked faction) and one intra-tick rule (one sleeve per
faction). Publishes status on port 11 (`STATUS_PORT_SLEEVES`).

**Launch & gate.** Launched by the controller (booster early-game, orbiter once
Formulas.exe is owned) via its `sleeveGate`: SF10 owned OR currently in BN10. The
manager itself no-ops a tick when `ns.sleeve.getNumSleeves() === 0` (gate races).
It is ordered **before gang** in the controller's manager list: sleeves farm the
karma that forms the gang (row 3), so they're the higher-priority karma producer.
A closed gate no longer blocks the chain — the controller skips an unavailable
manager and launches the ones behind it (see `launchManagers` in booster/orbiter).

## How it works

**Per-sleeve independent loop**, not one global mode: `main` ticks every
`SLEEVE_LOOP_SLEEP` (20 s — no `nextUpdate()` equivalent in this API, and per
the RAM model, tick rate never saves RAM, so the interval is chosen purely for
responsiveness), and inside one tick, every sleeve index runs the ladder
against its own stats. Different sleeves land on different rows in the same
tick — one recovering shock, one grinding pilot's faction, the rest on
crime — the only cross-sleeve rule is the faction claim (row 4).

**The ladder (`chooseTask`, pure function, first applicable row wins):**

| # | Row | Applicable when | Why |
|---|-----|------------------|-----|
| 1 | `sync` | `sleeve.sync < SLEEVE_SYNC_MIN` (95) | Sync scales exp transfer to the player and other sleeves **linearly** (`sync/100`, confirmed in game source `Sleeve/Work/Work.ts applySleeveGains`) — every other row's gains are multiplied by it, so it's raised before anything else is worth doing |
| 2 | `recovery` | `sleeve.shock > SLEEVE_SHOCK_MAX` (90) | Shock also multiplies down gains; only actively recovered when high — low shock is left to decay passively while the sleeve does useful work instead of babysitting it to zero |
| 3 | `karma` | `ctx.gangKarmaPhase` (gang status `phase === "karma"`) | Sleeves are gang formation's primary karma grinders while the gang plan waits out its karma requirement (crime chosen by the ladder below, not always Homicide) |
| 4 | `faction` | `ctx.pilotFaction` set and not yet in `ctx.claimedFactions` | Stacks rep on pilot's current grind target — the single biggest sleeve payoff, since it's the same rep gate gating the run's next aug |
| 5 | `gym` | any combat stat `< SLEEVE_STAT_FLOOR` (100), lowest stat first | Feeds crime success chance and karma speed for the rows below |
| 6 | `crime` | fallback | Money — crime chosen by the ladder below |

`chooseTask(sleeve, ctx)` takes `ctx = { gangKarmaPhase, pilotFaction,
claimedFactions }` and returns `{ row, crime?, faction?, stat? }`. It is pure
(no `ns` calls), which is what makes it independently unit-testable in
`sleeve-selftest.js` without booting the game.

**Chance-aware crime laddering (rows 3 and 6).** `chooseTask` only names the
*row*; the concrete crime is resolved by the ns-aware `decide()` → `resolveCrime()`
step in the tick loop (so `chooseTask` stays pure). Candidates are limited to
**Mug → Traffick Arms → Homicide** — the three crimes that grant XP in all four
combat stats, so laddering also trains the sleeve evenly toward the next crime up.
The pure `scoreCrimes(candidates, minChance)` core filters to crimes whose success
chance ≥ `SLEEVE_CRIME_MIN_CHANCE` (0.5) **first**, then picks the highest expected
value-per-second (`value × chance / time`, where `value` is karma for row 3, money
for row 6). If *nothing* clears the chance floor, it returns `{train}` and the sleeve
diverts to gym on the weakest combat stat — re-evaluated every tick, so it hands
back to crime as soon as a crime becomes reliable. This is why a fresh low-stat
sleeve trains or Mugs instead of diving into a 2%-success Homicide. `decide()` is
applied to both the initial pick and the post-faction-failure re-pick, so neither
path bypasses laddering. Smart laddering needs **SF4** (`getCrimeStats`) and
**Formulas.exe** (`crimeSuccessChance`); without both, `resolveCrime` falls back to
plain Homicide (karma) / Heist (money).

**Why sync goes first, ahead of shock/karma/faction:** sync is a multiplier on
every downstream gain (exp shared to the player and to other sleeves), so a
sleeve sitting at low sync is wasting a fraction of whatever else it's doing.
Raising it to near-max once and letting it stay there (95 floor, not 100 —
avoids thrashing back into sync mode for the last few points) pays for itself
across the rest of the sleeve's lifetime. Shock, by contrast, only needs
active attention when it's *high* — the design deliberately doesn't add a
"maintain shock at 0" row, since low shock decays on its own while the sleeve
earns.

**One-sleeve-per-faction rule and fallthrough.** `pilotFaction` names a single
target (pilot works one faction at a time), so absent coordination every idle
sleeve would try to grind the same faction, wasting all but one sleeve's rep
(the game doesn't stack multiple sleeves' rep gains on one target usefully
beyond the first). The loop tracks `claimedFactions` as a `Set` built fresh
each tick; the first sleeve to reach row 4 claims the faction, every
subsequent sleeve's `chooseTask` sees it already claimed and falls through to
row 5/6. If the *claiming* sleeve's `setToFactionWork` call itself fails
(returns falsy — `undefined` when the faction doesn't offer that work type),
the loop still adds the faction to `claimedFactions` before re-choosing for
that same sleeve, so a failed claim can't be retried forever by the same
sleeve or picked up speculatively by a later one; the sleeve falls through to
whatever row applies next. `applyTask`'s faction case itself tries
`["field", "hacking", "security"]` work types in order until one is accepted,
so a "failure" only happens when a faction offers none of the three.

**Thrash guard (`matchesCurrent`).** Before applying any decision, the loop
compares it against `ns.sleeve.getTask(i)`. If the sleeve is already doing
exactly what the ladder would assign (matching `type` and, per row, the
relevant field — `crimeType`, `factionName`, or `classType`), it's a no-op:
no reassignment call, no reset of in-progress task state. This mirrors the
same pattern in gang.js and pilot.js — an unconditional reassign every tick
would restart timed tasks (gym classes, crimes) from zero forever.

**Spending (`spendTick`, Mechanic capex class, shared `MECH_SPEND_FRAC` = 0.25
cap).** One shared budget per tick, `money × MECH_SPEND_FRAC`, drawn down as
each purchase fires — later purchases see less budget, so nothing can
overspend the cap in a single tick even across three different purchase
kinds. Three paths, tried cheapest-first within a purchase kind and in this
fixed order:

1. **Buy a sleeve** (`purchaseSleeve()`, BN10 only) — `getSleeveCost()`
   checked against remaining budget; the call is a no-op (returns falsy, no
   throw) outside BN10, so no separate BN-check is needed.
2. **Cheapest memory upgrade** across all sleeves — one point of
   `upgradeMemory(i, 1)` on whichever sleeve has the lowest
   `getMemoryUpgradeCost(i, 1)`. Memory persists across resets, making it the
   best long-term ROI in BN10.
3. **Cheapest affordable aug** across sleeves at `shock === 0` (a purchase
   requirement of `getSleevePurchasableAugs`) — one aug per tick, re-reading
   prices live rather than committing to a stale plan, so the batch
   effectively assembles itself over several ticks without extra bookkeeping.

Cheapest-first at every step is deliberate: a single big-ticket item (a new
sleeve, or an expensive aug) could otherwise consume the whole tick's budget
and starve several smaller, equally valuable wins. Augs reset a sleeve's raw
stats to 0 on purchase (its multipliers apply immediately, per the spec) —
expect a sleeve to drop right back into the sync/gym rows the tick after an
aug buy; this is expected ladder behavior, not a bug.

**Cross-manager context (`gatherContext`).** A single read-only peek per
tick at two other managers' status ports (`STATUS_PORT_GANG`,
`STATUS_PORT_PILOT`) — no sleeve code ever writes to another manager's state,
and no other manager reads sleeves' faction claims. `pilotFaction` is only
derived when pilot reports `working === true`, else `null` (nothing to
mirror). This keeps sleeves entirely decoupled: if gang or pilot aren't
running yet, `readStatus` simply returns nothing and every sleeve falls
through the karma/faction rows to gym/crime.

**Status (port 11):** `{ ts, count, avgShock, avgSync, tasks: {sync,
recovery, karma, faction, gym, crime}, spentThisRun }` — `tasks` counts how
many sleeves landed on each row this tick (for the dashboard), `spentThisRun`
accumulates across the whole run (not reset per tick) for a running spend
total.

### Log-based verification (`SLEEVE_DEBUG` → `/data/sleeve-log.txt`)

The design treats eyeballing the dashboard as insufficient verification for a
per-sleeve ladder with cross-sleeve coordination — instead every meaningful
event is logged as a `key=value` line via the shared `lib/debug-log.js`
helper (rolling file, last ~400 lines, 0-GB — `ns.read`/`ns.write` add no
static RAM), gated on the `SLEEVE_DEBUG` constant so logging can be silenced
without touching call sites:

| `ev` | When | Purpose |
|------|------|---------|
| `tick` | once per loop | row counts + spend total, for a time-series view |
| `assign` | a sleeve's task actually changes | `from`/`to`/`reason`, so a specific reassignment (and why) is traceable |
| `claim` | a faction claim succeeds or fails | proves the one-per-faction rule and fallthrough are actually firing |
| `buy` | any purchase | kind, sleeve, cost, running total — proves the cap is respected |

The rule that only data already in hand each tick gets logged (no extra
`ns.sleeve.*` call purely to log) matters under this project's RAM model:
logging must be free, or it silently taxes the manager's own RAM budget.

**In-game self-test:** `run /dev/sleeve-selftest.js` exercises the pure
`chooseTask`/`matchesCurrent`/`lowestCombatStat` functions directly (imported
from `sleeves.js`, no `ns.sleeve.*` calls involved) — ladder ordering
(including "sync beats recovery," "karma beats faction," fallthrough when a
faction is already claimed), and thrash-guard matching for every row. It
prints PASS/FAIL per case to the terminal and appends to
`/data/sleeve-selftest.txt`, following the same pattern as the project's
other `validate-*`/self-test scripts — a quick regression check for the
decision core without needing a live sleeve to exist.

## Why it's built this way

- **A pure decision core (`chooseTask`) separate from the `ns`-calling
  loop:** the ladder is the part most likely to need tuning (thresholds,
  row order) and the part most valuable to test without a live game session.
  Keeping it free of `ns` calls is what makes `sleeve-selftest.js` possible
  and keeps the loop itself a thin "read state → decide → apply → log" shell.
- **Sync strictly first:** because it's a multiplier on every other row's
  gains, deferring it (e.g. interleaving it with shock recovery by whichever
  is "worse") would let a sleeve spend time in a low-sync state doing
  otherwise-useful work at a discount. A hard first-place row avoids that
  trade-off entirely rather than trying to balance it.
- **Read-only cross-manager coordination, no shared write channel:** sleeves
  only *read* gang's and pilot's status ports — there's no new coordination
  primitive, no risk of sleeves' faction claim leaking into another
  manager's state, and no ordering dependency on which manager starts first
  (a missing status simply means "nothing to mirror yet").
- **Cheapest-first spending, one item per kind per tick:** mirrors gang.js's
  spend-cap pattern (shared `MECH_SPEND_FRAC`) rather than inventing a
  sleeve-specific budget model — keeps the Mechanic capex class consistent
  across managers, and a modest budget still lands cheap augs/memory before
  an expensive one could monopolize a tick.
- **Log-based verification over dashboard eyeballing:** with multiple
  sleeves independently landing on different rows plus one cross-sleeve rule,
  a snapshot dashboard view can't prove the fallthrough or thrash-guard logic
  actually fired correctly over time; a grep-able event log can.

## Dropped rows (deliberately out of scope for this build)

Two rows from the original plan (`docs/plans/sleeves.md`) were cut when the
design was finalized, because the managers they'd coordinate with don't
publish anything to mirror yet:

- **Bladeburner** (was row 5) — no Bladeburner manager exists to publish a
  `sleeveRequest`. Reminder left in `docs/plans/bladeburner.md`: when that
  manager is built, re-add a Bladeburner row reading its status port and
  calling `setToBladeburnerAction` on idle sleeves.
- **Company work** (was row 6) — pilot's status object exposes only
  `augs.workTarget.faction`, no company target for sleeves to mirror.
  Reminder left in `docs/plans/faction-prereqs-training.md`: once pilot
  publishes a company target, add a company-work row (below faction, above
  gym) with the same one-sleeve-per-company claim as the faction row.

Both are structural gaps (nothing to read), not correctness or performance
concerns — the ladder's shape doesn't need to change when they're added, just
a new row slotted in and a new status field read.

## Alternatives considered

- **One global mode for all sleeves** (e.g. "all sync," then "all crime")
  instead of per-sleeve independent ladders — rejected: it wastes sleeves
  that don't need what the group-wide phase says (e.g. holding a
  fully-synced sleeve in "sync mode" while a low-sync sleeve elsewhere still
  needs it), and it can't express "one sleeve on the bottleneck faction, the
  rest on crime" at all, which is the single biggest payoff row.
- **Maintaining shock at 0 continuously** instead of only recovering above a
  threshold — rejected: shock decays passively at low levels, so actively
  fighting it there wastes ladder priority that could go to karma/faction/
  crime; the 90 ceiling only intervenes once it's actually hurting gains.
- **Batching aug purchases into one multi-aug transaction per tick** —
  rejected in favor of one cheapest-affordable aug per tick: simpler spend
  accounting under the shared cap, and re-reading live prices each tick
  avoids committing to a stale multi-item plan if money or aug lists change
  mid-batch.
