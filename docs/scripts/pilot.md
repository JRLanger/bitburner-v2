# pilot

**Location:** `src/managers/pilot.js`

## What it does

Automates the Singularity-API progression loop the player otherwise does by hand:
buys the TOR router and darkweb port-opener/program `.exe`s, installs backdoors on
the story-faction servers, accepts "safe" faction invitations, buys augmentations
(rep/money/prereq permitting), and — per `docs/plans/arbitration.md` — is the
**single broker of player focus**: it decides what the player-character is doing
(faction work, crime, or idle) each tick via a priority ladder, and no other
manager is allowed to call `workForFaction`/`commitCrime`/etc.

It is an independent persistent loop, launched on `home` by booster/orbiter
(`launchManagers`) once the SF4 gate passes — see `docs/plans/pilot-singularity.md`
for the full spec this implements.

Explicitly out of scope: deciding *when* to install augmentations and reset (the
not-yet-built `lifecycle` script owns that, reading pilot's status to decide) and
dumping NeuroFlux Governor levels pre-reset (pilot only reports how many levels are
currently affordable).

## How it works

### Launch gate

`pilotGate(servers, ns)` in both controllers checks
`ns.getResetInfo().ownedSF.get(4) > 0 || ns.getResetInfo().currentNode === 4` — SF4
owned (any level) or currently playing BitNode 4, where Singularity is free
regardless of SF level. `getResetInfo()` is a plain top-level NS call (0.? GB, not
under `ns.singularity`), so probing it every tick while pilot is still pending
costs nothing extra. If the gate can never pass this run, pilot just stays
"pending" forever in the manager list — `launchManagers` logs `gate=closed` once
per tick and later managers behind it (hacknet) still launch normally.

`ownedSF` is confirmed as `Map<number, number>` in
`docs/reference/NetscriptDefinitions.d.ts` (keyed by SF number, valued by active
level) — this is why the gate reads it with `.get(4)` rather than array/object
indexing.

### Main loop (every `PILOT_LOOP_SLEEP` = 30s)

```
gatherState()        // one place that calls the expensive singularity getters
phaseTor()            // 1. programs
await phaseBackdoors() // 2. backdoors (async)
phaseFactions()       // 3. invites
phaseAugs()           // 4. buy augs
phaseWork()           // 5. arbitration ladder (player activity)
publishStatus(port 7)
sleep 30s
```

`gatherState` reads network topology from `/data/servers.json` (written by
booster/orbiter each tick) instead of scanning the network itself — pilot never
calls `ns.scan`.

**Phase 1 — programs (`phaseTor`).** Buys TOR (`purchaseTor()`) when its $200k
cost fits under `PILOT_SPEND_FRAC` (0.5) of current money. Once TOR is owned,
buys every darkweb program not already on `home` (`getDarkwebPrograms()` minus
`ns.ls('home', '.exe')`), cheapest-first, so a modest budget lands the port-opener
`.exe`s before big-ticket ones like `Formulas.exe` (whose *presence* is what
triggers the controllers' booster→orbiter handoff — pilot needs no special-case
code for it).

**Home-RAM phase (`phaseHomeRam`)** (docs/plans/home-ram.md), runs right after
`phaseTor` and before `phaseAugs` so the aug-readiness report sees post-purchase money the
same tick. Perpetual home-RAM upgrading: at most one `upgradeHomeRam()` buy per tick, gated
on `cost <= snap.money * HOME_RAM_SPEND_FRAC` (0.5, same class as pilot's other progression
spends — a fraction gate, not a cross-domain score, per arbitration.md Decision 4) and on
`snap.homeRam < HOME_RAM_MAX_GB` (an escape hatch, effectively `Infinity`). One buy per tick
keeps each purchase individually observable; the doubling cost curve makes the fraction gate
self-limiting on its own. It **never raids the `augBatch` reservation** by construction:
`snap.money` is already `max(0, raw - moneyFloor(ns))`, and `moneyFloor()` folds in the live
reservation total, so acquirable-aug money is invisible to this phase's gate the same way
it's invisible to pserver/hacknet — no special-case check needed here. Bootstrap ladder row 1
(`homeRam < 32 GB` → crime) is unaffected; this phase simply also runs during that window and
naturally clears the row as home RAM grows.

**Phase 2 — backdoors (`phaseBackdoors`).** For each host in `BACKDOOR_TARGETS`
(`CSEC`, `avmnite-02h`, `I.I.I.I`, `run4theh111z`, `fulcrumassets` —
`w0r1d_d43m0n` is deliberately excluded, it's a win-condition action owned by
`lifecycle`) not yet backdoored, rooted, and within hacking level: looks up its
path via `lib/netpath.js`'s `findPath(servers, host)`, which walks the `parent`
field the controllers now stamp onto every `servers.json` entry (see "Topology
extension" below), `connect()`s hop-by-hop, `await installBackdoor()`s, then
`connect('home')` in a `finally` so pilot's terminal position always resets even
if a hop or the backdoor itself fails. Does **at most one backdoor per tick** —
keeps ticks short and each install individually observable in the tail/dashboard.

**Phase 3 — faction invites (`phaseFactions`).** `checkFactionInvitations()`;
auto-joins any invite with an empty `getFactionEnemies()` list (CyberSec, the
hacking groups, the gang factions like Slum Snakes, …) and not on
`PILOT_JOIN_BLOCKLIST`. **Policy (user decision 2026-07-13): enemy-free invites
are joined UNCONDITIONALLY the tick they appear — even when the faction offers no
wanted augs.** Joining costs nothing and blocks nothing (no enemies), and
membership is pure upside (a rep channel, intelligence leveling). Only factions
with enemies (the city rivals below) are ever gated on aug value. A `joinFaction`
call that returns false lands in `pendingInvites` so a failed join is visible on
the dashboard instead of silently dropped.

**City factions** (`Sector-12, Aevum, Volhaven, Chongqing, New Tokyo, Ishima` —
mutually exclusive, faction name == city name) are auto-managed: pilot joins one
when its invite is present **and** no rival is already joined **and** it still
offers a wanted priority aug (`cityHasWantedAug`). `pursueCityFaction` travels
(`travelToCity`, gated on affording the $200k fare and on not interrupting manual
work) to the highest-wanted-aug candidate city to trigger the invite, then **stays
put** once in a candidate city (waiting on the invite / money requirement) so it
never oscillates between rivals. Per `getFactionEnemies`, a run can join one
compatible group — {Sector-12, Aevum}, {Chongqing, New Tokyo, Ishima}, or Volhaven
solo; across runs, once a city's wanted augs are owned it drops out and a rival
becomes eligible, so the cities are exhausted one group per run. The pursued city
shows as `cityTarget` in status. Once no city candidates remain, `pursueCityFaction`
travels the player **back to Sector-12** (only if pilot was the one who left —
tracked by `state.travel.awayForCity`, so a manually chosen city is left alone) so
the crime row's Sector-12 gym is reachable again.

Non-city enemy-having factions (Silhouette, etc.) are still left un-joined and
surfaced in `pendingInvites` for the player. Joined-faction membership comes from
`ns.getPlayer().factions` — the authoritative list.

**Faction-prereq planner** (docs/plans/faction-prereqs-training.md, `computeFactionPlans`,
called at the end of `phaseFactions`). No Netscript API enumerates every faction name
(`FactionName` is a closed enum type in `NetscriptDefinitions.d.ts`, not something a getter
returns as a list), so pilot works from a hand-curated list, `PLANNED_FACTIONS` — classic
requirement-gated factions worth pursuing (CyberSec, NiteSec, the megacorps, Illuminati,
The Covenant, Daedalus, etc.), kept separate from `CITY_FACTIONS`' own travel-driven logic.
For each unjoined, non-blocklisted, enemy-free planned faction that still offers an unowned
priority aug, it reads `getFactionInviteRequirements(faction)` and classifies every unmet
`PlayerRequirement`:

- **`skills`** → a training demand (`{stat, target}`), but only for stats the training row
  can actually raise — `TRAINABLE_STATS` (the four combat stats, charisma, hacking). A demand
  for an untrainable stat (e.g. intelligence) stays report-only; making it a real demand would
  keep the training row applicable with nothing for `startTraining` to start, and pilot would
  idle on it forever.
- **`backdoorInstalled`** → the host is added to `state.plans.backdoors`, which
  `phaseBackdoors` reads and **prepends** to its static `BACKDOOR_TARGETS` scan (deduped via
  `Set`), so a faction-gating host jumps the queue ahead of the default list.
- **`companyReputation` / `employedBy`** → **report-only** company demands
  (`state.plans.company`): no cheap NS call under this file's RAM budget can check or act on
  company rep, so these are surfaced for the player/a future row rather than acted on.
- **`not`** → also report-only, and deliberately so: satisfying a `not` means making its inner
  condition *fail* (e.g. "not employed by CIA"), so generating a demand that would *satisfy*
  the inner condition is exactly backwards — pilot has no "un-doing" actions anyway.
- **`someCondition`** → only its single **cheapest unmet branch** is turned into a demand
  (`reqCheapness`: skills < backdoor < company), since satisfying any one branch clears the
  whole condition — there's no point training AND backdooring when either alone would do.
  `everyCondition` instead demands every one of its unmet branches (all must be satisfied).
- Everything else (`money`, `city`, `karma`, `numAugmentations`, `sourceFile`, hacknet/file/
  location/kill-count requirements, …) has no actionable demand pilot can produce and is
  either satisfied elsewhere (gang, resets) or accrues on its own — report-only.

Results land in `state.plans` (`{training, backdoors, company, byFaction}`), not `snap` —
`phaseBackdoors` runs **before** `phaseFactions` in the tick loop, so it always reads *last
tick's* plans; one tick of staleness is harmless here and avoids restructuring the phase order.

**Stat-training ladder row** (`stat-training`, between `company-work` and `faction-work`).
Applicable whenever `nextTrainingDemand` finds an unmet demand from `state.plans.training` —
the largest-deficit stat still below `target × TRAIN_STAT_BUFFER` (1.05; trains 5% past the
raw requirement so a stat drained by some other mechanic later doesn't immediately re-flap the
row). "Largest deficit" (not smallest) is an arbitrary but deterministic tie-break so demands
never oscillate. `startTraining` routes combat stats to the gym (`gymWorkout`, `GYM_LOCATION`
= Powerhouse Gym) and charisma/hacking to the university (`universityCourse`,
`UNIVERSITY_LOCATION` = Rothman University, course from `UNIVERSITY_COURSE_BY_STAT` — Leadership
for charisma, Algorithms for hacking); either call can fail if the player isn't in the right
city, in which case v1 just retries next tick rather than adding dedicated travel (mirrors the
crime row's `gymWorkout` fallback). `maintainTraining` hands off (`reassert()`) whenever the
demand is satisfied or the running class no longer matches the current demand's stat — classes
never end on their own, the same reason `maintainCrime`'s gym branch exists. The row's `eta()`
(`trainingEta`) is gap-to-buffered-target ÷ an empirical stat-gain rate (`updateTrainRate`,
sampled the same way as `updateRepEstimate`), in ms; `null` when there's no demand or no rate
sample yet, which `pickWinner` treats as `GRIND_ETA_SKIP_MS` (eligible, not favored).

**Phase 4 — augmentations (`phaseAugs`, REPORT-ONLY).** Pilot does **not buy augs
during the run** (arbitration.md Decision 5): purchased augs are inert until
install, so buying early only pays the ~1.9× price ramp for no benefit — lifecycle
batch-buys the whole set at reset. Phase 4 reports two counts over the **ready set** —
the augs `batchBuyAugs` would buy now: **priority-tier** rep-met augs
(`config/aug-priority.js` — category Hacking/Special or a `faction_rep` bonus) always,
**plus** non-priority rep-met augs **once no priority aug is rep-locked** (priority
tier exhausted — mirroring the buy cascade, so rep-met non-priority augs can still
fire an install instead of being stuck at readyCount 0):
- `repUnlocked` — augs in the ready set whose rep requirement is met;
- `acquirableNow` — how many of those the reset batch could actually **afford right
  now**, via `countAcquirable`, which simulates the batch (most-expensive-first,
  each purchase multiplying remaining prices by `AUG_PRICE_RAMP` = 1.9) against
  current money using base prices from `aug-priority.js`.

`acquirableNow` is the real "ready" metric and drives lifecycle's install decision:
an aug isn't ready until **both** its rep is met **and** the money to buy it exists,
so the count grows from rep grinding OR money saving and stalls only when the
binding constraint stalls. This is what stops a gang's rep windfall (which unlocks
nearly every aug at once) from firing an install before the money to buy them has
been saved.

**Wallet reservation (`augBatch`)** (docs/plans/wallet-reservations.md). `countAcquirable`
now also returns the cumulative simulated cost of the augs it counted; `phaseAugs` writes
that cost every tick as the `augBatch` entry in the flag port's reservation ledger
(`setReservation`/`clearReservation`, `lib/flags.js`) — cleared when nothing is acquirable.
Since `moneyFloor(ns)` folds the live reservation total into every spender's money read,
this money becomes invisible to pserver, hacknet, and pilot's own programs/donations/home-RAM
with no changes to their code — an already-acquirable aug can no longer be un-readied by
another manager's purchase. pilot is the ledger's sole writer for this key (single-writer
rule); lifecycle clears it in `liquidateAndFreeze` when it spends the batch for real.

The snapshot carries a second money field, **`moneyForAugs`** (`gatherState`) — raw money
minus only the *frozen* floor flag, never the live reservation total. `phaseAugs`,
`countAcquirable`, and `countReadyNeuroflux` are its only readers. This exists to avoid a
**self-shrink feedback loop**: `snap.money` (used by every other phase) is net of
`moneyFloor()`, which after this change already includes pilot's own `augBatch` reservation
— feeding that fully-floored figure back into the aug simulation would make the reservation
count against itself every tick, shrinking `acquirableNow` toward zero. `moneyForAugs` breaks
the cycle by only ever subtracting the frozen floor the simulation doesn't itself write.

**NeuroFlux as the terminal "real" aug.** Once **every** non-NF aug at the joined
factions is owned (`anyUnownedReal` is false), `acquirableNow` switches to
`countReadyNeuroflux` — how many NeuroFlux levels are **rep-met AND affordable** right
now, simulating successive buys where price and rep-req each grow by `NF_LEVEL_MULT`
(1.14). NeuroFlux is treated **exactly like a real-aug batch** in this state: grinding
its rep grows the ready count (keeping the run open), and — crucially — its cost is
**reserved** the same way real augs are. `countReadyNeuroflux` returns `{ levels, cost }`,
and `phaseAugs` writes `cost` as the `augBatch` reservation just as the real-aug branch
does. Without this, `phaseHomeRam`/hacknet/pservers freely drained the money the ready NF
levels depend on, so `acquirableNow` collapsed to 0 and lifecycle's install triggers (all
needing `readyCount >= 1`) never fired — pilot ground NeuroFlux forever. The reservation
is released at reset by lifecycle's `liquidateAndFreeze` (clears `augBatch`), so
`dumpNeuroflux` still buys freely under the freeze; during the run it only keeps the count
stable. When rep is the binding constraint (the next NF level's rep requirement exceeds the
faction's current rep), the ready count is legitimately 0 and pilot keeps grinding — a real
"nothing installable yet" state, not the old starvation bug. The NF grind also **works for
rep only, never donates money** (`startFactionWork`). `repUnlocked` and `nfAffordableLevels`
report the same NF count in this state.

**Phase 5 — player-activity arbitration ladder (`phaseWork`).** Implements
`choosePlayerActivity()` from `docs/plans/arbitration.md`: an ordered array of
`{name, cls, applicable, start, stop, eta?}` rows. This build ships rows 1
(bootstrap-crime), 5 (stat-training), 6 (faction-work), 8 (crime-fallback), 9 (idle) as real;
rows 2–4 and 7 are inert placeholders (`applicable: () => false`) reserved for mechanic
managers (gang, Bladeburner, company-work servicing) that don't exist yet — future plans only
need to fill in a row's functions, never restructure the ladder.

| # | Row | cls | Applicable when (this build) |
|---|---|---|---|
| 1 | `bootstrap-crime` | gate | `home` RAM < 32 GB (nothing else works without base RAM) — chance-aware crime (see row 8) |
| 2 | `karma-grind` | grind | placeholder — always false (needs gang manager) |
| 3 | `bladeburner-bn67` | gate | placeholder — always false |
| 4 | `company-work` | grind | placeholder — always false (`state.plans.company` publishes the demand; servicing it is a follow-up) |
| 5 | `stat-training` | grind | a training demand exists (faction-prereqs-training.md) |
| 6 | `faction-work` | grind | a rep-locked PRIORITY aug exists at a joined faction, or the fallback target (non-priority → NeuroFlux) applies |
| 7 | `bladeburner-passive` | (unset) | placeholder — always false |
| 8 | `crime-fallback` | grind | money still wanted — port-4 snapshot fresh, i.e. pserver manager alive and still buying (once the fleet is maxed, idle beats heisting) |
| 9 | `idle` | gate | always true (terminal fallback) |

**Weighted-ETA grind selection** (arbitration.md, amended 2026-07-13). Ladder rows are tagged
`cls: "gate" | "grind"`. `pickWinner` (replacing a plain top-to-bottom "first applicable
wins") walks the ladder in order: the first applicable **gate** row still wins outright, same
as before — gates (bootstrap-crime, the bladeburner-BN67 stub, idle) preempt absolutely.
But the first applicable **grind** row instead triggers a comparison across *every* applicable
grind row from that point on (karma-grind, company-work, stat-training, faction-work,
crime-fallback): each exposes `eta()` (ms, or `null` when no rate sample exists yet — treated
as exactly `GRIND_ETA_SKIP_MS`, i.e. eligible but not favored). A grind whose raw ETA exceeds
`GRIND_ETA_SKIP_MS` (default 8 h) is excluded whenever at least one *other* applicable grind is
at or under that threshold — a days-long rep grind yields focus to a faster karma/training
win. Among the eligible set, the winner is the lowest `eta / GRIND_WEIGHTS[name]` (hand-tunable
per-row bias, e.g. `karma-grind: 1.5` biases toward gang formation, `crime-fallback: 0.5` is a
last resort); strict `<` breaks exact ties by ladder order. This is a **sanctioned narrow
exception** to arbitration.md Decision 4 ("no cross-domain score"): the unit (time-to-milestone)
*is* comparable within the grind class, and the weights are hand-tuned ordinal bias, not a
computed cross-domain money-ROI formula — money-ROI comparisons between domains remain
forbidden. `FOCUS_STABLE_TICKS` hysteresis (below) is applied on top of `pickWinner`'s result
unchanged, damping ETA noise the same way it damps any other borderline switch.

`snap.workSource`/`snap.grindTarget` (lifecycle's plateau/install signal) are computed
**before** `pickWinner` runs and are unaffected by which grind row actually wins focus — e.g.
if `stat-training` wins the tick, `workSource` still correctly reports whether pilot has a real
aug left to grind, independent of what's currently occupying the player.

Rows 1 and 8 are **chance-aware** (`bestCrime`/`startCrimeOrTrain`/`maintainCrime`):
each (re)start picks the best expected-$/sec crime — `money × successChance ÷ time`
over the full CrimeType catalog, all live reads, so a level-1 character starts at
Shoplift/Mug and graduates to Heist as stats grow. When even the best option's
chance is below `PILOT_CRIME_MIN_CHANCE` (0.4), pilot instead trains the lowest
combat stat at the gym (`Powerhouse Gym` — the GymLocationName enum *value*, not
the key); the row's `maintain()` hook (called every tick the row stays assigned)
restarts finished crimes and stops gym training the moment the chance clears the
bar, since a gym session never ends on its own.

Row 6 (`faction-work`) grinds rep toward the next-best **priority** aug by **ETA**
(`bestGrindTarget`): among priority-tier augs (`config/aug-priority.js`) still
rep-locked at a joined faction, it picks the lowest `ETA = max(moneyTime, repTime)`
— whichever grind (affording the price or grinding the rep) takes longer:
- `repTime = repGap / repRate`. `repRate` is exact via
  `ns.formulas.work.factionGains(...).reputation × 5` (200 ms cycle → /sec) when
  Formulas.exe is owned, else an empirical `Δrep/Δt` estimate measured while
  working (`updateRepEstimate`); with neither, it falls back to ordering by raw
  rep-gap.
- `moneyTime = (basePrice − money) / income`, where `income` is the **all-sources**
  rate (`getMoneySources().sinceInstall` deltas, EMA-smoothed via
  `PILOT_INCOME_EMA_ALPHA` — captures crime/gang/corp/stock, not just hacking), and
  `basePrice` is the aug's base price from `aug-priority.js` (a cheap proxy that
  avoids a live `getAugmentationPrice` call).

For each aug it grinds the joined faction where current rep is highest (closest to
unlock). Work uses `hacking` type when offered, else the faction's first, via
`workForFaction(faction, type, false)` — **`focus` always `false`**. Factions whose
`getFactionWorkTypes` is empty are skipped as work targets: the player's **gang
faction** earns rep only through gang respect, not `workForFaction`, so `pickWorkType`
returns `null` for it and both the ETA selector and the NeuroFlux grind exclude it
(otherwise the gang faction — often the highest-rep one — would be handed to
`workForFaction` with an `undefined` work type and throw). When no priority aug
is rep-locked (all owned or rep-met, awaiting the reset batch buy), the row stays
applicable via the fallback target below (non-priority aug → NeuroFlux) rather than going
idle.

**Sized donations, not a drip** (docs/plans/donation-sizing.md, `startFactionWork`). Once
favor ≥ `ns.getFavorToDonate()` (150 fallback) and the target isn't NeuroFlux, pilot
computes the current target's remaining rep gap
(`getAugmentationRepReq(target.aug) - getFactionRep(target.faction)`) and donates
`min(snap.money * PILOT_SPEND_FRAC, donationForRep(ns, gap) * DONATE_SLOP)` — sized to close
exactly that gap (`donationForRep` binary-searches `ns.formulas.reputation.repFromDonation`
when Formulas.exe is owned, else uses the closed-form inverse; `DONATE_SLOP` = 1.001 absorbs
rounding so one donation reliably clears the requirement), still capped per tick by
`PILOT_SPEND_FRAC` so a huge gap closes over several ticks rather than one wallet-emptying
donation. Once the gap hits 0 it falls straight through to `workForFaction` — no more
donations for a target that's already unlocked. The **old code donated
`money * PILOT_SPEND_FRAC` every single tick**, unconditionally, for as long as favor
cleared the threshold — burning money long after the target's rep was already met, with no
relationship between the amount donated and what was actually needed. NeuroFlux targets are
still never donated to here: that cash is reserved for `dumpNeuroflux`'s own
donate-exact-then-buy loop at reset (lifecycle.md); donating for NF's rep in-run would spend
the very money the reset dump needs.

The row has a **`maintain()`** (`maintainFactionWork`) because the ladder tracks
rows by *name*: when the lowest-ETA aug shifts to a **different faction**, the
winner is still `faction-work` (same name) and faction work stays `isBusy`, so
neither the switch path nor the generic idle re-assert would fire — pilot would
grind the old faction forever (you'd have to stop the work by hand). `maintain()`
compares the running `getCurrentWork()` faction/workType against the current
`grindTarget` each tick and re-asserts `workForFaction` when they diverge (also
covers the idle gap after a donate tick).

Priorities are a single global order for all BitNodes;
`aug-priority.js` is hand-editable and is the documented hook for per-BN tuning.

**Pilot never idles while any rep can still be earned.** When no priority aug is
rep-locked (`bestGrindTarget` → null), the `faction-work` row grinds a **fallback**
target (`fallbackGrindTarget`) instead of going idle:
1. the lowest-ETA **non-priority** rep-locked aug (raises favor/rep that becomes
   NeuroFlux at reset), then
2. if no aug is left at all, **NeuroFlux** — grind the highest-current-rep joined
   faction (the one `dumpNeuroflux` buys from), endlessly. There's no reason to stop.

Pilot publishes `workSource` (`priority` / `non-priority` / `neuroflux` / `none`) —
which grind tier it's on. Lifecycle's **plateau** install decision keys on this: it
treats `priority` and `non-priority` as "still grinding a real aug" (don't cut the run
short) and only lets the plateau fire once `workSource` descends to `neuroflux`/`none`
(both aug tiers exhausted). So the fallback keeps the player busy through the whole
priority → non-priority → NeuroFlux cascade **without** prematurely blocking or firing
resets. Two targets are also tracked for display/work: `snap.grindTarget`
(**priority-only**, for reference) and `snap.workTarget` (the effective grind =
priority ?? fallback), which the `faction-work` row and the dashboard use.

Pilot also publishes `redPillReady` (**The Red Pill** is rep-met and unbought), which
lifecycle installs on ASAP to claim it — see `lifecycle.md`.

**Anti-thrash hysteresis.** A new ladder winner must beat the *currently assigned*
row for `FOCUS_STABLE_TICKS` (4) consecutive ticks before pilot actually switches
— mirrors the controllers' REANCHOR/ramp-down stable-tick guards, and exists for
the same reason: a borderline condition (e.g. a rep gap that flickers above/below
another faction's) must not flap the player's activity every 30 seconds. The
"challenger" and its streak live in **plain closures in `main`**, not the flag
port — they only need to survive within this process's lifetime, and a restart
starting fresh (challenger cleared) is the conservative, safe default.

**Manual-override respect.** If `isBusy()` is true and the current work does not
match what pilot itself last started (a work *signature* — the faction/crime/type
shape recorded in the `pilotWorkSig` runtime flag immediately after each start),
`phaseWork` does nothing at all — it doesn't even touch the ladder bookkeeping.
A presence-only flag check is not enough: the flag survives across ticks, so once
pilot had started anything, work the player began manually later would be
misattributed to pilot and stomped. Comparing signatures fixes that.

**`focusOwner` flag.** Each tick, `phaseWork` writes the winning row's name to the
`focusOwner` flag (via `lib/flags.js`) and returns it in the
status snapshot — this is the arbitration protocol's advertised "who has focus"
signal other mechanic managers and the dashboard read.

### Debug log (`PILOT_DEBUG` → `/data/pilot-debug.txt`)

When `PILOT_DEBUG` (constants.js) is true, each tick appends a rolling `key=value`
line (last 400 kept) via `lib/debug-log.js` capturing the whole grind/work decision:
`row` (assigned ladder row) and `over` (manual-override), `busy`/`cur` (is the player
actually working, and at what), `src` (priority / non-priority / neuroflux / none),
`tgt` + `act` (**`work` vs `donate($…)`** — this is how you tell "grinding X" apart
from "donating 0 and doing nothing"), `favor`/`rep`/`repReq` of the target faction,
`prioGrind` (priority-only target), the aug inventory counts **`pL`/`pU`/`rL`/`rU`**
(priority/rest × rep-locked/rep-met, NeuroFlux & owned excluded — `rU>0` while `src=neuroflux`
means non-priority augs are unlocked-but-unbought), `moneyRaw`/`floor`/`money` (a
stuck `floor` = Infinity zeroes `money`, so donations become $0), and `income`. View
with `nano /data/pilot-debug.txt`; newest last. read/write are 0-GB. Set false to silence.

### Topology extension (booster.js / orbiter.js)

`discoverAndRoot`'s existing BFS (`ns.scan` from `home`) already visits every host
exactly once; it now also records each host's immediate predecessor in a
`parentOf` map as it's discovered, and `gatherInfo` stamps one new field onto
every `servers.json` entry: `parent` (the predecessor hostname, `null` for `home`).
Both controllers already pay for this scan every tick — the change adds no new NS
calls. Backdoor state is deliberately NOT stamped: `ns.getServer` would add ~2 GB
to booster's footprint, so pilot checks its handful of `BACKDOOR_TARGETS` itself
(pilot is home-only and its RAM budget already absorbs far larger singularity costs).

### `lib/netpath.js` (new, 0-GB, pure)

Extracted from `utils/backdoor-guide.js`'s local BFS. Two exports:
- `findPath(servers, target)` — walks `parent` pointers from `target` back to
  `home`, returning `["home", ..., target]`, or `null` if the topology doesn't
  reach `home` (malformed/partial data guarded against, not just trusted).
- `buildConnectCommand(path)` — the `"home; connect X; connect Y; backdoor"`
  string `backdoor-guide.js` prints.

Calls zero NS functions, so importing it costs nothing — the same "pure data
structure" idiom `lib/flags.js`'s port helpers use for 0-GB port ops.

`backdoor-guide.js` now builds its own `{hostname, parent}` list via a **fresh
live `ns.scan` BFS** (it's a manual one-shot terminal tool — the extra scan cost
doesn't matter) and calls the shared `findPath`/`buildConnectCommand`. Pilot
instead reads the `parent` field already sitting in `servers.json`, avoiding a
duplicate scan inside a persistent, RAM-metered script.

### Status (port 7 — `STATUS_PORT_PILOT`)

```js
{
  ts, phase: 'work'|'idle',
  programs: { owned, total },
  backdoors: { done: [...], pending: [...] },
  factions: n,
  pendingInvites: [...],
  working: { faction, type } | { crime } | null,
  focusOwner: 'faction-work' | 'bootstrap-crime' | ...,
  augs: { purchased, affordableNow, nextUnlock: {aug, faction, repNeeded} },
  nfAffordableLevels: n,
  action: "...",
}
```

Dashboard (`src/dashboard.js`) and the tail renderer (`src/lib/tail-ui.js`) each
add one `pilot` manager row (programs, backdoors, factions, ladder) following the
existing port-3/4/5 pattern, plus a dedicated alert line when `pendingInvites` is
non-empty (`"Faction invite needs decision: ..."`) — invites with enemies need a
human call the automation deliberately won't make.

## Why it's built this way

**Separate, slow-ticking script — never imported into booster/orbiter.** Every
`ns.singularity.*` call's RAM cost is multiplied ×16 at SF4 level 1 (×4 at level
2, ×1 at level 3) — see `docs/plans/pilot-singularity.md`'s API facts. Importing
even one singularity call into the controllers would tax booster/orbiter's own
RAM (already tight in early game) by that same multiplier, forever, even for
players who barely progress the mechanic. Isolating it to its own process means
only pilot pays that cost, and only for as long as it's running. A 30s tick
(`PILOT_LOOP_SLEEP`) matches how slowly progression state actually changes
(faction rep, invites, aug affordability) and amortizes the high per-call RAM
cost over a longer window — there is no benefit to ticking faster.

**One place gathers all singularity state per tick (`gatherState`).** Several of
the getters used across phases (`getCurrentWork`, `isBusy`, owned programs) would
otherwise be called from multiple phases; consolidating the reads keeps the
"minimal distinct singularity function calls" rule (spec requirement, since SF4.1
multiplies every one of them ×16) easy to audit in one function instead of
scattered across five.

**Pilot is the sole focus broker (arbitration.md Decision 1).** Before any second
mechanic manager (gang, Bladeburner, grafting) exists, establishing "only pilot
ever calls `workForFaction`/`commitCrime`/`stopAction`/etc." as a hard rule now —
rather than after a second manager is already fighting over focus — eliminates an
entire class of race condition by construction. Mechanic managers that need player
actions (Bladeburner actions, grafting) will publish a `focusRequest` in their own
status snapshot; pilot reads it (no new channel) and, if a ladder row assigns it,
calls the 1–2 cheapest functions on the mechanic's behalf. This build has no such
managers yet, so those ladder rows are stub placeholders — but the *shape* (ordered
array of `{name, applicable, start, stop}`) is already the one every future
mechanic plan is written against.

**`focus: false`, always.** `setFocus`/`workForFaction`'s focus argument is never
`true` — pilot must never steal the game window away from whatever the player is
looking at. This costs some efficiency (unfocused work/crime is worse than
focused) but is a non-negotiable UX rule from the spec: a fully-automated player
character should never visibly wrestle the player for their own screen.

**Manual-override tracked by work signature.** Right after starting any work,
pilot records `describeWork(getCurrentWork())` in the `pilotWorkSig` flag; a busy
state whose current-work signature doesn't match that record is treated as the
player acting manually and left strictly alone. (A coincidental match — player
manually starting the exact faction+worktype pilot had chosen — is harmless:
pilot would maintain the same work.)

**Anti-thrash hysteresis in closures, not the flag port.** The flag port
(`lib/flags.js`) is specifically for state that must survive a reset (it's wiped
on aug/soft reset by design) or be shared cross-process. The ladder's
challenger/streak bookkeeping needs neither — it only exists to smooth this
*same process's* tick-to-tick decisions, so a plain module-level closure avoids
polluting the shared flag namespace and needing no reset-clearing logic at all
(a fresh pilot process, post-reset, starts the hysteresis state cleanly by
construction).

**`parent` added to servers.json instead of pilot re-scanning the network.** The spec is explicit that pilot must not call `ns.scan` itself
(topology comes from the controllers' `/data/servers.json`, already produced every
tick). Since `discoverAndRoot`'s BFS already visits each host from exactly one
predecessor, capturing that predecessor is a zero-extra-scan, one-line change;
threading it through `gatherInfo`'s existing per-host object keeps the diff
minimal and touches no other controller logic.

**`lib/netpath.js` extracted rather than duplicated.** Both `backdoor-guide.js`
(manual terminal tool) and `pilot.js` (automated) need the same "reconstruct a
path to a target from topology data" logic. A shared pure module means a
correctness fix (e.g. the cycle guard in `findPath`) benefits both call sites
automatically, and keeps the BFS itself framework-agnostic — it operates on any
`{hostname, parent}` array regardless of whether that array came from a live scan
or a JSON file.

## Alternatives considered

- **RAM-fallback split into per-phase one-shot scripts**
  (`pilot/{programs,backdoors,factions,augs,work}.js` execed sequentially by a
  cheap coordinator): the spec's documented fallback if `mem managers/pilot.js`
  shows the combined script too large under SF4.1's ×16 multiplier. **Not built
  preemptively** — the plan explicitly says to measure first; this is recorded as
  the next step if RAM verification (see "Unverified" below) fails.
- **Tracking joined factions in a pilot-maintained flag (`pilotJoinedFactions`):**
  rejected — it misses factions joined manually or before pilot started.
  `ns.getPlayer().factions` is the authoritative list and costs one cheap call.
- **A central money ledger for all managers' spending:** rejected at the
  arbitration-design level (`docs/plans/arbitration.md` Decision 2) as
  over-engineering while money regenerates in seconds; pilot instead uses its own
  decentralized `PILOT_SPEND_FRAC` cap, same pattern as pserver's spend fractions.
- **Detecting "is this pilot's work?" by a presence-only flag** (busy + pilot has
  a recorded row ⇒ assume pilot's): rejected — the flag outlives individual works,
  so anything the player started manually after pilot's first action would be
  misattributed to pilot and replaced. The recorded-signature comparison keeps
  the check cheap while actually detecting manual work.

## Unverified / open items

- **RAM cost: ~77 GB at SF4.3** — booster reads the live cost via
  `ns.getScriptRam` when reserving home headroom, so no constant to maintain (~61 GB of it
  singularity functions, biggest single items 5 GB each: getOwnedAugmentations,
  getAugmentationsFromFaction, getAugmentationPrereq, purchaseAugmentation,
  commitCrime, donateToFaction). Because singularity RAM scales ×16/×4/×1 with
  SF4 level, the same script needs ~249 GB at SF4.2 and ~981 GB at SF4.1 — pilot
  as a single script is **only viable at SF4.3**; below that, the spec's RAM
  fallback (per-phase one-shot scripts) must be built before pilot can launch.
- **NeuroFlux Governor's per-purchase inflation constant** isn't exposed via a
  documented getter here, so `countAffordableNeuroflux`'s simulated loop assumes
  `getAugmentationPrice(PILOT_NEUROFLUX)` already reflects the next level's live
  price and stops after a fixed iteration cap (200) as a safety valve rather than
  a game-accurate "no more levels" condition — informational display only, no
  purchase depends on it.
- **`getFavorToDonate()`** is called with a defensive `ns.getFavorToDonate ? ... :
  150` fallback since it's a top-level NS function (verified in the type defs) but
  wasn't re-confirmed against a live game session in this pass.
