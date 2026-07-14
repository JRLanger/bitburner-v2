# Implementation Plan: `pilot` — Singularity progression manager (Roadmap 3.1)

Status: **planned, not started**. Written 2026-07-05 against Netscript v3.0.1 type defs.
This plan is written so a fresh session (or a cheaper model) can implement it without
extra context. Read `CLAUDE.md` and `docs/scripts/pserver.md` (as the pattern example)
first.

## Goal

A new manager script `src/managers/pilot.js` that automates the manual progression
loop the player currently does by hand:

1. Buy TOR router and darkweb port-opener programs as money allows.
2. Install backdoors on faction/story servers (replaces manually pasting output of
   `utils/backdoor-guide.js`).
3. Accept faction invitations (with a blocklist to avoid enemy-faction lockout).
4. Work for the "best" faction to earn rep toward augmentations.
5. Buy augmentations (rep+money permitting), including prereq ordering and the
   NeuroFlux Governor dump before reset.

Out of scope for this script: deciding *when* to install augs and resetting — that is
the `lifecycle` script (see `reset-lifecycle.md`), which reads pilot's status to decide.

## API facts (verified in docs/reference/NetscriptDefinitions.d.ts — re-verify before coding)

- All functions live on **`ns.singularity.*`**. Outside BN4 they require Source-File 4,
  and their RAM cost is multiplied **×16 with SF4.1, ×4 with SF4.2, ×1 with SF4.3**.
  Design consequence: pilot must be a **separate, slow-tick script**, never imported
  into booster/orbiter, and must call as few distinct singularity functions as needed.
- Key functions (exact names):
  - `purchaseTor()`, `getDarkwebPrograms()`, `getDarkwebProgramCost(name)`, `purchaseProgram(name)`
  - `connect(host)`, `installBackdoor()` (async — `await` it), `getCurrentServer()`, `manualHack()` (not needed)
  - `checkFactionInvitations()`, `joinFaction(name)`, `getFactionInviteRequirements(name)`, `getFactionEnemies(name)`
  - `workForFaction(name, workType, focus?)`, `getFactionWorkTypes(name)`, `getFactionRep(name)`, `getFactionFavor(name)`, `donateToFaction(name, amount)`
  - `getOwnedAugmentations(purchased?)`, `getAugmentationsFromFaction(name)`, `getAugmentationRepReq(name)`, `getAugmentationPrice(name)`, `getAugmentationPrereq(name)`, `purchaseAugmentation(faction, aug)`
  - `isBusy()`, `getCurrentWork()`, `stopAction()`, `setFocus(focus)`
  - `upgradeHomeRam()`, `getUpgradeHomeRamCost()`
- **RAM check is mandatory before finalizing the design**: after writing a first
  draft, run `mem managers/pilot.js` in game. If total RAM exceeds home headroom at
  SF4.1 (×16), split into phase sub-scripts (see "RAM fallback" below).
- Project rule: never name a variable/property after an NS function (RAM analyzer
  collision — see memory/CLAUDE.md).

## Architecture: follows the established manager pattern

Same shape as `src/managers/pserver.js` / `hacknet.js`:

- Independent loop, slow cadence: `PILOT_LOOP_SLEEP = 30_000` ms (progression state
  changes slowly; a slow tick also amortizes the high singularity RAM cost — the
  script holds its RAM constantly, but slow ticking minimizes CPU/log noise).
- Launched by booster/orbiter's `launchManagers()` with a **gate**:
  `pilotGate()` = player has SF4 (check `ns.getResetInfo().ownedSF` — a `Map` — or
  `ns.singularity.getOwnedSourceFiles()`; verify which is cheaper) **or** current
  BitNode is 4. If the gate can never pass this run, controller logs once and skips.
  Suppression via `managersSeen` flag port works unchanged.
- Publishes status every tick to a **new port: `STATUS_PORT_PILOT = 7`**
  (add to `src/config/constants.js`; port 6 is worker telemetry).
- Reads network topology from `/data/servers.json` (written by controller each tick)
  — do NOT rescan the network itself.
- Self-exits only if singularity is unavailable (gate raced wrong); otherwise runs
  forever — progression work never finishes until reset.

## Data / config to add to `src/config/constants.js`

```js
// --- pilot (singularity progression manager) ---
export const STATUS_PORT_PILOT = 7;
export const PILOT_LOOP_SLEEP = 30_000;
// Fraction of current money pilot may spend per tick on programs/augs.
// Keep pilot from starving pserver: pserver's spending is ROI-driven; pilot's is
// progression-driven, so cap it.
export const PILOT_SPEND_FRAC = 0.5;
// Never accept these factions automatically (city factions conflict with each other).
// Auto-join is only safe when getFactionEnemies(f) is empty.
export const PILOT_JOIN_BLOCKLIST = [];      // player can add names
// Priority list of "story" servers to backdoor, in order:
export const BACKDOOR_TARGETS = [
  'CSEC', 'avmnite-02h', 'I.I.I.I', 'run4theh111z', 'fulcrumassets',
];
// w0r1d_d43m0n handled by lifecycle, not pilot.
// Aug buying: skip augs whose price exceeds this multiple of current money (wait).
export const PILOT_AUG_PRICE_HORIZON = 1.0;  // buy only if affordable now
export const PILOT_NEUROFLUX = 'NeuroFlux Governor';
```

> **Amended 2026-07-13 — three follow-up plans extend pilot:**
> 1. **`phaseHomeRam`** (docs/plans/home-ram.md): perpetual home-RAM upgrading,
>    inserted between phaseTor and phaseAugs; fraction gate
>    `HOME_RAM_SPEND_FRAC`, buys from unreserved money only.
> 2. **Faction-prereq planner + stat-training row** (docs/plans/
>    faction-prereqs-training.md): `computeFactionPlans` inside phaseFactions
>    (via `getFactionInviteRequirements`) and ladder row 5 `stat-training`.
> 3. **Reservations** (docs/plans/wallet-reservations.md): phaseAugs writes the
>    `augBatch` reservation from `countAcquirable`'s simulated batch cost; the
>    snapshot gains a `moneyForAugs` field (frozen-floor-only) to avoid the
>    reservation shrinking itself.
> Each adds singularity functions → re-measure `mem managers/pilot.js` and update
> `PILOT_MANAGER_RAM` (already flagged STALE) after every one.

## Main loop pseudocode

```
main:
  disableLog ALL; open no tail (status goes to port 7 → dashboard)
  loop forever:
    snapshot = gatherState()        // one place that calls the expensive getters
    phaseTor(snapshot)              // 1. programs
    await phaseBackdoors(snapshot)  // 2. backdoors (async)
    phaseFactions(snapshot)         // 3. invites
    phaseAugs(snapshot)             // 4. buy augs
    phaseWork(snapshot)             // 5. choose/maintain faction work
    publishStatus(ns, STATUS_PORT_PILOT, buildStatus(...))
    sleep(PILOT_LOOP_SLEEP)
```

### Phase 1 — programs (`phaseTor`)
- If TOR not owned: `purchaseTor()` when money × PILOT_SPEND_FRAC covers $200k.
  (Detect ownership: `ns.hasTorRouter()` — verify this fn exists in v3 defs; if not,
  `purchaseTor()` returns true when already owned / just buy idempotently.)
- Then iterate `getDarkwebPrograms()`; for each not in `ns.ls('home', '.exe')`,
  buy in ascending cost order while affordable under the spend cap. Port openers
  first (BruteSSH → FTPCrack → relaySMTP → HTTPWorm → SQLInject); Formulas.exe is
  the big one — buying it triggers the controller's orbiter handoff automatically,
  no coordination needed.

### Phase 2 — backdoors (`phaseBackdoors`)
- For each host in BACKDOOR_TARGETS not yet backdoored and with root + hack level met:
  - Backdoor state: read from controller's `/data/servers.json` if it includes
    `backdoorInstalled`; **if it doesn't, extend the controller's topology dump to
    include that field** (one-line change in booster.js and orbiter.js where
    servers.json is written — it already has the `ns.getServer` object available).
  - Walk the path: reuse the BFS from `src/utils/backdoor-guide.js` — **extract that
    BFS into `src/lib/netpath.js`** (pure function over servers.json topology, 0 GB)
    and have both backdoor-guide and pilot import it. servers.json must include
    parent/edge info for this; if it currently stores a flat list, add a `path` or
    `parent` field at write time.
  - `connect()` hop-by-hop from home → target, `await installBackdoor()`, then
    `connect('home')` (always return home in a `finally`).
- One backdoor per tick max — keeps ticks short and behavior observable.

### Phase 3 — faction invites (`phaseFactions`)
- `checkFactionInvitations()`; join every invite where
  `getFactionEnemies(f).length === 0` and `f` not in PILOT_JOIN_BLOCKLIST.
- Invites WITH enemies (city factions, Silhouette etc.): do NOT auto-join; surface
  them in the status snapshot (`pendingInvites`) so the player decides. Dashboard
  shows them as an alert line.

### Phase 4 — augmentations (`phaseAugs`)

> **IMPLEMENTED 2026-07-06 (arbitration.md Decision 5 + ETA plan).** Purchased augs
> are inert until installed, so all aug buying moved to lifecycle's pre-reset batch.
> Pilot's phase 4 is now REPORT-ONLY (publishes `acquirableNow` + `lastAcquireTs`,
> buys nothing — not even prereqs; lifecycle's batch orders prereqs itself). Faction
> work grinds toward the lowest-ETA priority aug (`config/aug-priority.js`). See
> `docs/scripts/pilot.md` for the shipped behavior; the continuous-buy design below
> is retained only as history.
- Build the want-list once per tick:
  - For each joined faction: `getAugmentationsFromFaction(f)` minus
    `getOwnedAugmentations(true)` (true = include purchased-not-installed).
  - Keep augs where `getFactionRep(f) >= getAugmentationRepReq(aug)`.
  - Order by **price descending** (game raises all aug prices ×~1.9 per purchase, so
    buy expensive first).
  - Respect prereqs: `getAugmentationPrereq(aug)` must be a subset of owned+purchased;
    if not, defer.
- Buy while `price <= money * PILOT_SPEND_FRAC`. Recompute price after each buy.
- **NeuroFlux dumping is NOT done here** — it's a pre-reset action owned by
  `lifecycle` (buying NF early wastes the ×1.9 inflation). Pilot only reports
  `nfAffordableLevels` in status.

### Phase 5 — player activity (`phaseWork`)

> **Superseded/extended by `docs/plans/arbitration.md`:** phase 5 is now the
> arbitration ladder's `choosePlayerActivity()` — faction work (below) is ladder
> row 6, the default. Build the ladder skeleton (rows 1, 6, 8, 9) with pilot v1;
> other rows are added by the mechanic plans. The faction-work logic below is
> unchanged as row 6's implementation. Pilot also writes the `focusOwner` flag
> and reads other managers' `focusRequest` status fields per the arbitration doc.
- Skip entirely if `isBusy()` and `getCurrentWork()` shows the player manually
  started something that isn't pilot's own work (respect the player: only replace
  work pilot itself started — track `lastWorkStartedByPilot` {faction, workType} in
  a runtime flag via `src/lib/flags.js`).
- Target selection: among joined factions, pick the one with the highest-value
  **unmet** rep requirement: the cheapest aug still locked by rep (smallest
  `repReq - currentRep` > 0). Tie-break: faction with most locked augs.
- `workType`: pick from `getFactionWorkTypes(faction)` preferring `hacking`.
- `workForFaction(faction, type, false)` — **focus=false** (requires Neuroreceptor
  aug or accepts the unfocused penalty; never steal window focus).
- If favor ≥ donation threshold (150 favor — verify constant via
  `ns.getFavorToDonate()`), prefer `donateToFaction` to grind rep with money instead
  of time, still under the spend cap.

## Status snapshot (port 7)

```js
{
  ts, phase: 'work'|'idle',
  programs: { owned: n, total: n },
  backdoors: { done: [...], pending: [...] },
  factions: joined.length,
  pendingInvites: [...],          // needs player decision
  working: { faction, type } | null,
  augs: { purchased: n, affordableNow: n, nextUnlock: {aug, faction, repNeeded} },
  nfAffordableLevels: n,
}
```

Dashboard/tail: add one pilot row following the existing manager-row pattern in
`src/dashboard.js` and `src/lib/tail-ui.js` (see how port 4/5 rows are rendered).

## RAM fallback (only if `mem` shows the script too big at SF4.1 ×16)

Split into `pilot.js` (coordinator, cheap: flags/ports/status only) that execs
one-shot phase scripts `src/managers/pilot/{programs,backdoors,factions,augs,work}.js`
sequentially each tick. Each one-shot pays only its own phase's singularity RAM and
exits. Coordinator ↔ phases communicate via a scratch port or args. Do NOT build this
preemptively — measure first.

## Testing checklist

1. `mem managers/pilot.js` — record RAM at current SF4 level; confirm it fits home.
2. Fresh-ish save state: kill pilot, delete a darkweb program? (can't — instead test
   on a save that still lacks programs). Verify buy order and spend cap.
3. Backdoor test: pick a not-yet-backdoored target, watch one tick install it and
   return the terminal connection to home.
4. Invite test: trigger a city-faction invite; confirm it is NOT auto-joined and
   appears in dashboard alerts.
5. Work test: confirm pilot does not override manually started work; confirm it
   starts faction work when idle.
6. Aug test: with rep+money for ≥2 augs, confirm price-descending order and prereq
   deferral.
7. Regression: booster/orbiter tick times unchanged (pilot must not import anything
   that raises controller RAM).

## Documentation deliverables

- `docs/scripts/pilot.md` via `/devlog` skill (what/how/why/alternatives).
- Devlog stage entry in `docs/devlog/` when implementation lands.
- Update `docs/ROADMAP.md` item 3.1 status.
