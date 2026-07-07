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
hacking groups, …) and not on `PILOT_JOIN_BLOCKLIST`.

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
shows as `cityTarget` in status. (Note: while abroad, the Sector-12 gym used by the
crime row is unreachable, so that row falls back to committing crime — harmless.)

Non-city enemy-having factions (Silhouette, etc.) are still left un-joined and
surfaced in `pendingInvites` for the player. Joined-faction membership comes from
`ns.getPlayer().factions` — the authoritative list.

**Phase 4 — augmentations (`phaseAugs`, REPORT-ONLY).** Pilot does **not buy augs
during the run** (arbitration.md Decision 5): purchased augs are inert until
install, so buying early only pays the ~1.9× price ramp for no benefit — lifecycle
batch-buys the whole set at reset. Phase 4 reports two counts over the **priority
tier** (`config/aug-priority.js` — category Hacking/Special or a `faction_rep`
bonus):
- `repUnlocked` — augs whose rep requirement is met (grinding progress);
- `acquirableNow` — how many of those the reset batch could actually **afford right
  now**, via `countAcquirable`, which simulates the batch (most-expensive-first,
  each purchase multiplying remaining prices by `AUG_PRICE_RAMP` = 1.9) against
  current money using base prices from `aug-priority.js`.

`acquirableNow` is the real "ready" metric and drives lifecycle's install decision:
an aug isn't ready until **both** its rep is met **and** the money to buy it exists,
so the count grows from rep grinding OR money saving and stalls only when the
binding constraint stalls. This is what stops a gang's rep windfall (which unlocks
nearly every aug at once) from firing an install before the money to buy them has
been saved. Also reports `nfAffordableLevels` (NF is lifecycle's pre-reset dump,
never bought here).

**Phase 5 — player-activity arbitration ladder (`phaseWork`).** Implements
`choosePlayerActivity()` from `docs/plans/arbitration.md`: an ordered array of
`{name, applicable, start, stop}` rows, evaluated top-to-bottom each tick — the
first applicable row wins. This build ships the **skeleton**: rows 1, 6, 8, 9 are
real; rows 2–5 and 7 are inert placeholders (`applicable: () => false`) reserved
for mechanic managers (gang, Bladeburner, grafting) that don't exist yet — future
plans only need to fill in a row's three functions, never restructure the ladder.

| # | Row | Applicable when (this build) |
|---|---|---|
| 1 | `bootstrap-crime` | `home` RAM < 32 GB (nothing else works without base RAM) — chance-aware crime (see row 8) |
| 2 | `karma-grind` | placeholder — always false (needs gang manager) |
| 3 | `bladeburner-bn67` | placeholder — always false |
| 4 | `company-work` | placeholder — always false |
| 5 | `grafting` | placeholder — always false |
| 6 | `faction-work` | a rep-locked PRIORITY aug exists at a joined faction (grind toward the lowest-ETA one) |
| 7 | `bladeburner-passive` | placeholder — always false |
| 8 | `crime-fallback` | money still wanted — port-4 snapshot fresh, i.e. pserver manager alive and still buying (once the fleet is maxed, idle beats heisting) |
| 9 | `idle` | always true (terminal fallback) |

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
`workForFaction(faction, type, false)` — **`focus` always `false`**. Once favor ≥
`ns.getFavorToDonate()` (150 fallback) it donates money for rep instead of working
(same spend cap). When no priority aug is locked (all unlocked, awaiting the reset
batch buy), the row is inapplicable and the ladder falls through to crime to
accumulate money. Priorities are a single global order for all BitNodes;
`aug-priority.js` is hand-editable and is the documented hook for per-BN tuning.

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

- **`PILOT_MANAGER_RAM`: 65.65 GB measured at SF4.3, +12 GB computed for the chance-aware crime fallback (getCrimeStats, getCrimeChance, gymWorkout) = 77.65 GB — re-measure with `mem`** (~61 GB of it
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
