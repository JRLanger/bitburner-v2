# Devlog 02 — `booster`: The Early-Game Bootstrap Controller

**Date:** 2026-06-15 (design); 2026-06-16 (implementation in progress)
**Status:** Core hacking engine built and validated in-game; managers + Formulas
handoff pending.

## Implementation status

Built in stages, each verified in-game (test save with rooted network + large
home RAM). Source: `src/booster.js`, workers in `src/workers/`, tunables in
`src/config/constants.js`.

| Stage | Scope | Status |
|-------|-------|--------|
| 1 | Discovery, rooting, worker provisioning, topology JSON | ✅ done |
| 2 | Hack-% tables, target scoring, ranking | ✅ done |
| 3a | Control loop, RAM pool, thread placement, prep | ✅ done |
| 3b | Rolling HWGW grid batcher + enter/stay hysteresis | ✅ done |
| 3c | Recovery grow (climb drifted targets back to max) | ✅ done |
| 3d | Stabilization: RAM-budgeted admission, plan locking, fire cap, recovery rate-limit, drift tuning | ✅ done |
| 3e | Bootstrap fix (easiest-earner-first prep) + target-count cap for lag | ✅ done |
| 3f | Live status table (tail window) | ✅ done |
| 4 | Manager orchestration: pserver + hacknet managers, gated launch in booster | ✅ done |
| 4 (cont.) | Contracts solver manager (`managers/contracts.js`), launched order-1 by booster | ✅ done |
| 5 | `sharePhase` in booster: feed idle pool residual to `ns.share()` (on by default, opt-out via `/utils/share-off.js`) | ✅ done |
| 6 | Formulas.exe handoff | ⬜ **deliberately disabled** — loop is `while(true)` so it can be tested on a save that already owns Formulas.exe. Restore the `while(!fileExists(FORMULAS_EXE))` exit when moving to a fresh BN. |

Key lessons captured during implementation: the NS-property RAM collision (see
section below), the hysteresis fix for false-drift churn, and the recovery-grow
insight (a pure HWGW batch *maintains* money but has no surplus to *recover* it,
so low-growth targets settle below max without a top-up).

## What it is

`booster` is the first controller that runs at the start of every BitNode
cycle (see `progression-cycles.md` and `01-bn-reset-checklist.md`), **before
Formulas.exe is available**. It is the cheap "first stage" of the controller
lineage — it gets hacking income off the ground, then is jettisoned and
replaced by a more capable, Formulas-based controller once Formulas.exe is
detected.

Naming theme (rocket staging): **booster** (early) → orbiter (mid) →
station (late), reflecting the "powerful first stage, discarded once you're
moving" lifecycle.

## Responsibilities

1. **Discover, root, and provision the network** — BFS from `home` via
   `scan`, open ports with whatever crack programs are owned, `nuke`, and
   `scp` the three worker scripts to each newly-rooted server. This logic is
   **integrated into the controller** (not a separate script) to save the
   1.6 GB base cost of a second script.
2. **Maintain a topology JSON** (`/data/servers.json`, free `ns.write`) of
   static/topology data for other managers to consume without re-scanning.
3. **Rank targets** by profitability using a per-target hack-percentage
   table (see "Targeting model" below).
4. **Run a rolling HWGW batch** against the best targets, with thread counts
   computed from plain NS getters and hardcoded security constants — no
   Formulas.exe.
5. **Prep weak/poor targets** (security → minimum, money → maximum) before
   they become batch-eligible, since pre-Formulas thread math is only
   accurate at baseline.
6. **Auto-launch managers** (pserver buyer/upgrader, hacknet buyer/upgrader,
   contracts solver, later gang/bladeburner) on `home` in a fixed dependency
   order, once each is affordable and its prerequisites are met.
7. **Display a live status table** (tail window, free `ns.ui`/`ns.print`).
8. **Detect Formulas.exe** (`fileExists`) and hand off to the advanced
   controller.

## Prerequisites (checked at startup)

Three worker scripts must already exist on `home`: a hack worker, a grow
worker, and a weaken worker. If any is missing, `booster` prints an error to
the terminal and exits immediately — it does **not** create them. (Workers
planned separately.)

Also assumes the manual BN-reset grind (see `01-bn-reset-checklist.md`) has
been done to bring home RAM to ~32GB.

## RAM budget — 8.20 GB

Deliberately kept low so `booster` runs usefully on a small early home
server. Total is dominated by the three 1 GB analysis functions; everything
else is cheap getters.

| Function | RAM | Purpose |
|----------|-----|---------|
| Base | 1.60 | every script |
| `exec` | 1.30 | launch workers, managers |
| `ps` | 0.20 | thread accounting per host |
| `getServerMoneyAvailable` | 0.10 | real-time money |
| `getServerSecurityLevel` | 0.10 | real-time security |
| `getServerUsedRam` | 0.05 | free RAM per host |
| `getServerMaxRam` | 0.05 | capacity (home grows when upgraded) |
| `getWeakenTime` | 0.05 | batch timing |
| `getGrowTime` | 0.05 | batch timing |
| `getHackTime` | 0.05 | batch timing |
| `hackAnalyze` | 1.00 | money fraction per hack thread |
| `growthAnalyze` | 1.00 | grow threads for a target multiplier |
| `hackAnalyzeChance` | 1.00 | success chance (ranking + filtering) |
| `fileExists` | 0.10 | detect Formulas.exe |
| `scan` | 0.20 | topology BFS |
| `hasRootAccess` | 0.05 | root status |
| `getServerNumPortsRequired` | 0.10 | nuke requirement |
| `getServerRequiredHackingLevel` | 0.10 | viability |
| `getServerMaxMoney` | 0.10 | target value |
| `getServerMinSecurityLevel` | 0.10 | weaken floor |
| `brutessh`/`ftpcrack`/`relaysmtp`/`httpworm`/`sqlinject` | 0.25 | port openers |
| `nuke` | 0.05 | root |
| `scp` | 0.60 | provision workers to rooted servers |
| **Total** | **8.20 GB** | |

Free (0 GB): `ns.read`/`ns.write` (topology JSON), `ns.ui.*`/`ns.print`
(status table).

### Hardcoded constants (avoid 3 GB of analysis functions)

Security deltas are fixed single-core constants, so we hardcode them instead
of calling `weakenAnalyze` / `growthAnalyzeSecurity` / `hackAnalyzeSecurity`
(1 GB each = 3 GB saved):

- weaken: **−0.05** security per thread
- grow: **+0.004** security per thread
- hack: **+0.002** security per thread

## Targeting model

### Optimal hack % varies per server

Diminishing returns come from the **grow** side: restoring fraction `f` needs
a grow multiplier of `1/(1-f)`, whose thread cost scales like
`ln(1/(1-f))` — superlinear — while money gained is linear in `f`. So a peak
RAM-efficiency `f` exists. Its location depends on two server-specific
quantities: `hackAnalyze` (fraction stolen per hack thread) and the server's
growth rate (what `growthAnalyze` encodes). High-growth servers peak at a
higher `f`; low-growth/high-money servers peak lower. **It is not a universal
constant** — but we never have to guess it, because the formula below finds
each server's peak from free arithmetic.

### Per-target thread table (1%–99%)

For each prepped target, precompute a table over `f = 0.01 … 0.99` (1% steps):

```
h(f)  = ceil(f / hackAnalyze(target))                 // hack threads
g(f)  = ceil(growthAnalyze(target, 1 / (1 - f)))      // grow threads
w1(f) = ceil(h(f) * 0.002 / 0.05)                     // weaken for hack sec
w2(f) = ceil(g(f) * 0.004 / 0.05)                     // weaken for grow sec
ramPerBatch(f) = h*hackRAM + g*growRAM + (w1+w2)*weakenRAM
moneyPerCycle(f) = maxMoney * f * hackAnalyzeChance(target)
score(f) = moneyPerCycle(f) / (weakenTime(target) * ramPerBatch(f))
```

The table is built from free calls (`hackAnalyze`/`growthAnalyze`/
`hackAnalyzeChance` are already in the RAM budget). Rebuild only when the
player's **hacking level** changes (the only thing that shifts the curve for
an already-prepped target), not every tick.

Metric is **$ per GB per second**, because RAM — not time — is the scarce
resource (many batches pipeline within one `weakenTime`).

### Allocation (per controller tick)

1. Filter candidates: `hasRoot`, `maxMoney > 0`,
   `hackAnalyzeChance ≥ CHANCE_FILTER`.
2. Split into **prepped** (security ≤ minSecurity × (1 + `SEC_MARGIN`) and
   money ≥ maxMoney × (1 − `MONEY_EPSILON`)) and **needs-prep**.
3. Rank prepped targets by their table's best `score` (the optimal %).
4. Greedily allocate RAM down the ranked list, each target at its **optimal
   %** (pipelined — see caveat), spending leftover RAM on the next-best
   target rather than under-running the best one.
5. Only the marginal target at the bottom of the pool uses the **step-down
   fallback**: if its optimal-% pipeline doesn't fit, walk the table down to
   the highest % that fits (floor 1%); skip if even 1% doesn't fit.
6. Any still-leftover RAM → prep the next-best needs-prep target (weaken to
   min, then grow to max).

So "lower the hack %" is a last-resort squeeze for one marginal target, not
the primary mechanism — most targets run at their true optimum.

### Critical caveat: pipeline RAM, not single-batch RAM

A rolling HWGW runs `weakenTime / batchSpacing` batches concurrently. The RAM
a target consumes at steady state is `ramPerBatch × concurrentBatches`. The
"fits the pool" checks above must compare the **pipeline** cost, not one
batch, or we'll badly over-commit. This is the central constraint for the
(still to be designed) batch scheduler.

## Tunable constants (to calibrate empirically)

| Constant | Suggested start | Meaning |
|----------|-----------------|---------|
| `CHANCE_FILTER` | 0.5 | min `hackAnalyzeChance` to consider a target |
| `CHANCE_BATCH` | 0.8 | min chance before a prepped target is batch-eligible |
| `SEC_MARGIN` | 0.05 | "prepped" if security ≤ minSecurity × (1 + this), i.e. within 5% above minimum |
| `MONEY_EPSILON` | 0.01 | "prepped" if money within 1% of max |
| grid step | 0.01 | hack-% table resolution |
| `D_GAP` | 100 ms (was 200) | gap between consecutive HWGW landings (tuned down to cut overlap jitter) |
| `BATCH_PERIOD` | `4 × D_GAP` (400 ms) | interval between batch launches into the pipeline |
| `HOME_RESERVE` | (TBD) | RAM kept free on `home` for `booster` (8.2 GB) + managers |
| `BATCH_BUDGET_FRAC` | 0.80 | fraction of total pool usable for batch pipelines (rest reserved for prep) |
| `MAX_FIRES_PER_TICK` | 2 | cap on batches one target may launch per tick (anti-burst) |
| `THREAD_MARGIN` | 1.05 | over-provision factor for grow/weaken threads (drift absorption) |
| `MAX_BATCH_TARGETS` | 999 (≈ off) | late-game cap on concurrently batched targets (dial down for lag) |
| `PREP_LOOKAHEAD` | 2 | servers prepped beyond the batch cap as a lookahead buffer |

## Validation plan

Before trusting the model, the standalone tool `src/validate-model.js`
measures **predicted vs. actual** money and security per operation and logs to
`/data/validation-log.txt`. Each op auto-establishes its precondition (prep /
drain / raise-security) so no manual setup is needed.

### Validation results (2026-06-15, target `phantasy`, T=100, game v3.0.0)

| Model claim | Measured ratio | Verdict |
|-------------|----------------|---------|
| hack stolen = `money × hackAnalyze × T` | 1.0000 | ✅ exact |
| hack security = `0.002 × T` | 1.0000 | ✅ exact |
| grow security = `0.004 × T` | 1.0000 | ✅ exact |
| weaken security = `0.05 × T` | 1.0000 | ✅ exact |
| `growthAnalyze` thread count | 1.0400 | ⚠️ overestimates ~4% |

**Two engine behaviors confirmed — both matter for `booster`:**

1. **`growthAnalyze` overestimates grow threads by ~4%.** It errs in the
   *safe* direction: `booster` will provision slightly too many grow threads,
   so money always fully recovers (minor RAM waste, never an under-grow). No
   correction applied in v1 — we accept the ~4% over-provision as a safety
   margin. Revisit only if RAM pressure makes the waste matter.

2. **Grow's security increase is proportional to money actually grown** (game
   v2.3.0+ behavior). Growing a server already at max money adds ~0 security.
   This does **not** affect normal HWGW batching (grow there always runs on a
   hacked-down server and does real growth → full `0.004 × T`), but it means
   any code that assumes "grow always adds `0.004 × T`" is wrong when the
   server is at/near max money. (This is why the validation tool raises
   security via hack, not grow.)

## Manager orchestration

`booster` auto-launches the manager scripts on `home`, but only *orchestrates*
them — each manager is an independent script with its own internal spending
logic. This costs `booster` **zero extra RAM**: launching needs only `exec`,
`ps`, and `getServerMoneyAvailable`, all already in the budget.

### Fixed dependency order

`booster` holds an **ordered** list of managers, each with a `gate()`. Each
tick it launches the **first not-yet-running** manager whose gate passes — and
**will not launch a later manager until all earlier ones are already
running**. That ordering is what makes the sequence "fixed."

| Order | Manager | Gate | Rationale |
|-------|---------|------|-----------|
| 1 | contracts solver | none (network rooted) → immediate | free money/rep, trivial cost |
| 2 | pserver buyer/upgrader | `money ≥ cost of smallest useful server` | highest compounding ROI — purchased servers feed the batch RAM pool |
| 3 | hacknet buyer/upgrader | pserver fleet **fully built**: 25 servers each with `maxRam ≥ 32 TB` (32768 GB) | weak early ROI; defer until the synergistic RAM investment is exhausted |
| 4 | gang (future) | BN/karma-gated | deferred |
| 5 | bladeburner (future) | unlock-gated | deferred |

Affordability/launch decisions live in `booster`; **spending** decisions live
inside each manager. `booster` does not micromanage.

**Implementation note (stage 4).** The two RAM-pool-growth managers shipped first:
the pserver buyer/upgrader (`src/managers/pserver.js`) and the hacknet
buyer/upgrader (`src/managers/hacknet.js`). See `docs/scripts/pserver.md` and
`docs/scripts/hacknet.md`. The **contracts solver (order 1 above) closed out Stage 4**
(`src/managers/contracts.js`, see `docs/scripts/contracts.md`) — it had been deferred
as "contract-solving logic, not RAM growth," but was folded back in to complete the
stage. The launch order is now the full contracts → pserver → hacknet (contracts'
gate is always true, so it leads). It finds `.cct` files across the network (host
list from the topology JSON booster already writes) and solves them from a pure-function
solver registry keyed by contract type — solve-all, skip-unknown.

**Two spending models.** The **pserver** manager uses the two-arm payback/reinvest rule
described below. The **hacknet** manager was later switched to a different rule —
**ROI over the remaining-BitNode horizon** (buy a step only if it pays back before the
BN is expected to end; horizon = 8 h on a fresh BN, then the last recorded BN duration).
See `docs/scripts/hacknet.md`. Both managers now also **drain every worthwhile step per
tick** (not one — `MANAGER_MAX_BUYS_PER_TICK`) and **self-exit once there's nothing left
worth buying** (freeing their `home` RAM; see "Manual-stop detection and self-kill"). The
two-arm model below is the pserver spending policy.

**pserver spending — two arms: payback OR reinvestment fraction.** The pserver manager
buys the cheapest next step (gated by affordability) when EITHER it *pays back within `X`
seconds of current income* (`getTotalScriptIncome`, the PAYBACK arm) OR its cost ≤ a
*reinvestment fraction of current cash* (the REINVEST arm). The payback arm lets
large purchases through once income justifies them and makes upgrades halt
automatically where servers get expensive ("not worth it after a point", emergent).
The reinvest arm is income-independent and **breaks the fresh-save chicken-and-egg**:
at the start income is ~0 *because* RAM is the bottleneck, so payback can never fire;
the reinvest arm spends accumulating cash down to a self-scaling buffer
(~`cost/frac`) and pours the rest into RAM.

**The reinvest fraction decays as infrastructure is built**, so it doesn't
permanently neuter payback. A constant reinvest arm would override payback forever
(once cash-rich/income-poor, `money × frac` almost always covers the cheapest step,
so the "worth it?" check never binds). Instead `effFrac` decays linearly from
`PSERVER_REINVEST_FRAC` (0.25) down to `PSERVER_REINVEST_FLOOR` (0.01) as fleet **RAM**
grows toward `PSERVER_BOOTSTRAP_RAM_GB` (25 × 32 = 800 GB). RAM is the signal because
it's BitNode-independent (unlike a dollar income threshold). During bootstrap the
reinvest arm fills the fleet; past the target it sits at the 1% floor and payback governs
upgrades, the floor acting as a slow-trickle relief valve (a stalled fleet still creeps
on a large cash pile). Tunables: `PSERVER_PAYBACK_SECONDS`, `PSERVER_REINVEST_FRAC`,
`PSERVER_REINVEST_FLOOR`, `PSERVER_BOOTSTRAP_RAM_GB`.

*Known consequence:* if pserver upgrades stall below the hacknet gate (32 TB × 25)
because they stop being worth it, hacknet launches late or not at all. The reinvest
arm lets a fleet keep growing as cash accumulates; gating hacknet on "pserver reports
no affordable step" instead of a fixed RAM target is a noted future refinement.

The hacknet gate is computed from existing scan data — `booster` counts
topology entries whose hostname starts with the shared `PSERVER_PREFIX` and
whose `maxRam ≥ 32 TB`. No new NS calls; `PSERVER_PREFIX` lives in
`config/constants.js` so the pserver manager and `booster` agree on the name.

### Avoiding double-launch

Managers are persistent loops. Before `exec`-ing one, `booster` checks
`ns.ps("home")` for that script's filename, so a `booster` restart never spawns
duplicates (in-memory tracking alone is insufficient — `booster` itself can be
restarted).

### Manual-stop detection and self-kill (don't relaunch a stopped/done manager)

Two cases must NOT trigger a relaunch: the user manually kills a manager, and a manager
that has nothing worth buying exits on its own. The plain "not running → relaunch" rule
would re-exec both immediately. A single in-memory mechanism handles both:

- **In-memory `launchedManagers` set.** `booster` records every manager it has seen
  running this run. A manager that was seen running and is now gone — whether the user
  killed it or it self-exited — is not relaunched for the rest of this `booster` run.
  Treated as "accounted for" in the fixed-order scan, so it doesn't block later managers
  (e.g. hacknet still launches after pserver finishes); `nextManagerReserve` skips it too,
  so no `home` RAM is reserved for a manager that won't relaunch.

A fresh `booster` start clears the set and relaunches everything. That's exactly right for
self-completed managers, because **an aug install (soft reset) wipes purchased servers and
hacknet nodes** — so each run the managers must rebuild from scratch. A persistent "done"
marker would be *wrong* here: it would stop a manager that genuinely needs to rebuild. The
trade-off is that a manual stop only lasts until you restart `booster` (kill a manager and
it stays dead; reload/restart resumes it) — the agreed, low-friction behavior. The cost of
the in-memory approach is a brief relaunch-then-exit on a `booster` restart for a manager
that's already maxed (e.g. a page reload mid-run with the fleet full) — harmless.

The pserver and hacknet managers self-exit when there's nothing left worth buying (pserver:
fleet fully maxed; hacknet: maxed, or no upgrade pays back within the fixed run horizon —
see `docs/scripts/hacknet.md`), freeing their `home` RAM. The `contracts` manager has no
self-exit — contracts keep spawning, so it runs forever.

### RAM interaction

Managers run on `home` and consume its RAM, which automatically shrinks the
worker pool (`booster` reads real free RAM via `getServerUsedRam` each tick).
Running managers therefore need no special accounting — they show up in
`getServerUsedRam`.

The key choice is **gated launch, not run-idle**: a manager launched early but
blocked on an internal gate would sit in a loop holding its full RAM while
doing nothing — wasting it for the whole deferred period (and *forever* for
gang/bladeburner if that BN never unlocks them). Gating the launch instead
keeps that RAM in the hacking pool — earning money — until the manager is
genuinely wanted.

Crucially, `booster` does **not** pre-reserve the whole manager suite. It
reserves only `booster` itself (8.2 GB) plus headroom for the **next** pending
manager (so it can `exec` when its gate trips, reclaiming RAM from marginal
workers if needed). Far-future managers (hacknet, gang, bladeburner) reserve
nothing until they're next in line — their RAM stays available to workers
meanwhile. This is strictly more RAM-efficient than launching managers idle.

(For contracts and pservers the distinction is moot — their gates trip almost
immediately, so they start working right away either way. The gate earns its
keep on the deferred managers.)

## Worker scripts

Three single-shot workers live in `src/workers/` (in-game `/workers/hack.js`,
`/workers/grow.js`, `/workers/weaken.js`). `booster`'s startup prerequisite
check looks for these three paths and exits with a terminal error if any is
missing.

**Arg contract (all three identical):**

| Arg | Meaning |
|-----|---------|
| `[0] target` | hostname to act on |
| `[1] delay` | additional ms the **engine** waits before the op lands, passed as `{ additionalMsec: delay }`. Aligns batch landing order. |
| `[2] batchId` | throwaway disambiguator so otherwise-identical concurrent workers are distinguishable to `ps`/`kill`. Not read by the worker. |

**RAM (load-bearing — every batch's cost is built from these):**

| Worker | RAM | = base + op |
|--------|-----|-------------|
| `hack.js` | 1.70 GB | 1.60 + 0.10 |
| `grow.js` | 1.75 GB | 1.60 + 0.15 |
| `weaken.js` | 1.75 GB | 1.60 + 0.15 |

Workers are kept deliberately minimal — **no logging, no port writes** — because
any extra NS call raises the per-thread cost and bloats every batch. The
`additionalMsec` delay and arg parsing are free.

**Why `additionalMsec` instead of `ns.sleep`:** the engine handles the wait
internally, landing the op far more precisely than a JS `sleep` (which is
subject to event-loop jitter — exactly what desyncs batches). Side effect: a
worker's total runtime is `opTime + delay`, which the scheduler accounts for
when reasoning about when a worker frees its RAM.

**Why single-shot:** a worker does exactly one op and exits, so RAM is freed
the moment its operation lands. This is what makes precise pipelined batch
timing possible (vs. a persistent looping worker that holds RAM indefinitely).

## HWGW scheduler

### Timing model

Times come from `getHackTime` / `getGrowTime` / `getWeakenTime` per target
(in budget, 0.05 GB each; recomputed each tick so they track hacking-level
changes). The four ops of a batch are launched **simultaneously** but given
different `additionalMsec` delays so they **land** in staggered order, `D_GAP`
apart, with W1 landing at the natural `weakenTime`:

```
op   lands at            additionalMsec (= landTime − opTime)
H    weakenTime − D      (weakenTime − D)   − hackTime
W1   weakenTime          0
G    weakenTime + D      (weakenTime + D)   − growTime
W2   weakenTime + 2D     2D
```

All delays are non-negative because `weakenTime ≫ hackTime` and
`weakenTime > growTime`. Landing order H→W1→G→W2 means: hack steals, W1 repairs
hack's security, grow restores money, W2 repairs grow's security — leaving the
target back at baseline (min security, max money) after each batch.

### Pipelining

A new batch is launched every `BATCH_PERIOD = 4 × D_GAP`, so at steady state
landings form a continuous stream spaced `D_GAP` apart
(…H W1 G W2 H W1 G W2…). The number of batches in flight for a target is:

```
concurrentBatches = ceil(weakenTime / BATCH_PERIOD)
pipelineRAM(target) = concurrentBatches × ramPerBatch(chosen f)
```

**This `pipelineRAM` — not a single batch — is what allocation checks against
the RAM pool.** (The earlier "pipeline RAM, not single-batch RAM" caveat.)

### Absolute land-time grid (the key to a permanently-full pipeline)

The goal is steady-state: the pipeline stays full at all times, with no
correction waves that stop earning money. The mechanism is to anchor landings
to a **fixed absolute time grid** per target, not to the loop's timing.

Per target, keep a launch clock: a time base `t0` and a batch index `n`.
Batch `n`'s W1 is *defined* to land at:

```
L_n = t0 + n × BATCH_PERIOD
```

When `booster` actually fires batch `n`, it computes each worker's delay from
the **real current time against the fixed grid**:

```
additionalMsec(op) = (L_n + opOffset) − now − opBaseDuration
```

(where `opOffset` is 0 for W1, `−D` for H, `+D` for G, `+2D` for W2.)

The crucial property: **the op lands at `L_n` exactly, regardless of when
within the launch window `booster` actually fired the exec.** If the loop wakes
80 ms late, the engine adds 80 ms less delay and the landing still hits the
grid. Loop jitter is absorbed (up to nearly a full `weakenTime` of slack), so
batches land exactly `BATCH_PERIOD` apart, in order, indefinitely — **no drift
accumulates, so no correction waves are needed.**

Because exactly one batch is fired per `BATCH_PERIOD` and each lives
`weakenTime`, the steady-state in-flight count is
`weakenTime / BATCH_PERIOD = concurrentBatches`, continuously and gapless. The
loop only needs to wake often enough (e.g. every `BATCH_PERIOD / 2`) to hit
each slot's launch window; lateness within the window is corrected by the
`additionalMsec` recomputation above.

### Control loop: stateless truth + phase clock

State is deliberately minimal — only the per-target launch clock (`t0`, `n`).
Everything else is re-derived from live truth each tick, which keeps `booster`
**restart-safe** (kill and relaunch → re-anchor `t0` to now, read `ps` to see
the pipeline is already full, resume; the one-time phase hiccup is smoothed by
self-heal).

```
loop forever:
  (periodically) scan + root + scp + rewrite topology JSON
  build RAM pool: per server free RAM (getServerMaxRam − getServerUsedRam − reserve)
  derive in-flight batches per target from ps across rooted servers
  rebuild each target's hack-% table IF hacking level changed
  classify targets from live money/security: prepped / needs-prep / drifted
  for each drifted target: pause launches, prep back to baseline (self-heal)
  for each prepped target by rank:
      while now is at/after the next grid launch (S_n = L_n − weakenTime)
            and pipelineRAM still fits:
          fire batch n (threads from table at chosen f; delays from the grid)
          n += 1
  leftover RAM → prep next needs-prep target
  launch next pending manager if its gate trips
  redraw status table
  sleep ~BATCH_PERIOD / 2
```

- **`ps`-derived in-flight count** decides *how many* batches to fire (top-up);
  the **grid** decides *when each lands*. The two are independent — order is the
  engine's job via `additionalMsec`, never the loop's.
- **Cold start** is the trivial case: the pipeline is empty, so the loop fires
  the whole pipeline's worth of batches in one pass (each on its grid slot,
  perfectly spaced) and then settles into one-per-`BATCH_PERIOD` top-up.

### Thread splitting across servers

Early servers are too small to hold a whole batch, so each op's threads are
spread across the RAM pool (`home` + rooted servers, minus `HOME_RESERVE`):

- **Weaken and grow** split freely — their effect is additive across threads
  and across separate `exec` calls.
- **Hack also splits** — total stolen = `threads × per-thread fraction`,
  additive across `exec` calls **provided every hack split shares the same
  `additionalMsec`** so they all act on the same money snapshot. They must land
  together.
- Each split `exec` is a distinct worker instance, so `batchId` must be unique
  per instance (e.g. `${batchSeq}-${op}-${hostIndex}`) for clean `ps`/`kill`
  accounting.

### Desync self-heal (safety net, not the primary mechanism)

The absolute land-time grid prevents *timing-driven* desync — batches land in
order regardless of loop jitter. So self-heal is no longer the workhorse; it's
a rarely-triggered safety net. The one genuine remaining drift source is
**mid-flight hacking level-ups**: if your level rises after a batch is sized
but before it lands, that batch's hack steals slightly more than its grow
restores, nudging the target off baseline. Two things keep this from
cascading: the thread table is rebuilt on level change (new batches stay
correct), and grow's safe-direction over-provisioning (~4% over + `ceil`
rounding) gives each batch a buffer to fully restore baseline. Level-ups also
become rarer as the BN progresses.

When drift does occur, each tick, for every batching target:

1. If money < `maxMoney × (1 − MONEY_EPSILON)` or security >
   `minSecurity × (1 + SEC_MARGIN)`, the target has **drifted**.
2. Stop launching new batches for it; let in-flight batches drain.
3. Fire prep (weaken to min, then grow to max) until it's back at baseline.
4. Resume batching.

Simpler and more robust than trying to make timing perfect.

### Leftover RAM → prep the pipeline

Any RAM not consumed by active batch pipelines goes to prepping the next-best
unprepped target (weaken/grow), so a queue of future good targets is always
being readied. "Lower the hack %" step-down (see Allocation) applies only to
the single marginal target at the bottom of the RAM pool.

## Stabilization (stage 3d): from chaos to steady state

The first full multi-hour runs surfaced a cascade of failures that only appear at
scale (many targets, a huge RAM pool). Each fix exposed the next layer, so they're
recorded here in the order they were found and solved.

1. **Unbounded admission → permanent overcommit.** Every prepped target was batched
   with no global RAM cap. Each target independently sustains a full pipeline of
   `weakenTime / BATCH_PERIOD` concurrent batches; summed across ~15 targets that
   far exceeds the pool, so RAM drained to zero, starved prep (large servers never
   finished prepping after 10 h), and forced under-funded batches that drifted.
   **Fix: `selectBatchers`** admits targets in score order only while cumulative
   *pipeline* RAM stays under `BATCH_BUDGET_FRAC` (0.80) of the *total* pool; the
   rest idle (prepped, un-hacked, zero cost). Keeps a real proportional reserve for
   prep. Un-admitted-target selection is keep-first (`wasBatching`) for hysteresis.

2. **Per-tick re-optimisation → grid desync + admission flap → worker accumulation.**
   `bestHackPct` was recomputed every tick for already-batching targets, so the
   batch shape (and its RAM estimate) wobbled. The wobble flipped marginal targets
   in and out of the admitted set; each re-admit fired fresh batches while the
   dropped admission's workers kept running for a full weaken time. The pile-up
   collapsed the pool to ~40 GB and produced a START/STOP storm (dozens/second).
   **Fix: lock the plan** (`batchPlan`) at admission and reuse it until the target
   drifts out; recompute only on re-admission. Stable estimates ⇒ no flap ⇒ no
   accumulation.

3. **Catch-up bursts.** A target whose launch clock fell behind could fire its whole
   pipeline (hundreds of batches) in one tick, re-spiking RAM. **Fix:
   `MAX_FIRES_PER_TICK = 2`** — pipelines fill/heal gradually; steady state only
   needs ~1 launch per couple of ticks.

4. **Recovery-grow accumulation.** `maybeRecover` re-fired a full deficit-sized grow
   *every tick* for any target below `RECOVER_MONEY_FRAC`, with no in-flight check
   (unlike `prepPhase`). Those grows live for the grow time and stacked, bleeding the
   pool from tens of TB to tens of GB and spiralling. **Fix: per-target cooldown**
   (`recoverClock`, ~`growTime`) so one corrective wave lands and is measured before
   the next fires.

5. **Residual per-cycle drift.** Even stable, the longest-pipeline targets (e.g.
   `iron-gym`) leak a fraction of a percent per cycle — inherent to a fixed-shape,
   `Date.now`-clocked batcher without Formulas-exact timing. Mitigations:
   `THREAD_MARGIN` (1.05) over-provisions grow/weaken (not hack) so each batch grows
   just past max / weakens just past min (both clamp harmlessly), and `D_GAP` was
   tightened 200→100 ms to reduce overlap jitter. Note `BATCH_PERIOD = 4 × D_GAP`,
   so smaller `D_GAP` deepens every pipeline and raises per-target RAM — a
   throughput/headroom trade-off. The true cure for sub-percent drift is the
   Formulas-based stage 5 controller; `iron-gym`-class outliers are accepted here.

**Display aid:** raw money/security reads land at a random phase of each target's
grid and oscillate; `displayHealth` reports the rolling-window peak money / floor
security so the status table shows the grid-aligned baseline (~100 % / +0.00) and
genuine drift still stands out.

## Bootstrap fix + target cap (stage 3e)

**Problem.** On a *fresh* save the controller ran correctly but took hours to get
going. With a tiny starting pool, prep was ordered biggest-money-first, so
`prepPhase` poured the whole pool into partial weaken/grow waves for the largest
servers (which can't finish for hours) while the trivially-cheap earners starved
at the back of the queue. No prep finished → nothing batched → no income → the
pool never grew.

**Why not the old workaround.** Previous saves solved this with a hardcoded
"n00dles-only bootstrap phase" gated on pserver count. That's a workaround for a
prep-ordering bug, and the gate signal was a proxy. The real constraint is RAM,
and the real bug is the ordering.

**Fix: prep easiest-earner-first.** Flip `needsPrep` to ascending `maxMoney`
([booster.js](../../src/booster.js), `classify`). Cheap servers prep in seconds,
start batching, and their income funds the pool that later preps the big ones.
Self-scaling: no bootstrap mode, no hardcoded server, no threshold — once the pool
is large, prep is fast for everyone and order stops mattering. `maxMoney` is a
free (no NS call) prep-cost proxy; a value/cost ROI is a possible future refinement.

**Target-count cap (folded in for later).** Early game is RAM-limited
(`BATCH_BUDGET_FRAC`); late game is lag-limited — Bitburner slows with too many
concurrent worker scripts. `MAX_BATCH_TARGETS` adds a second ceiling in
`selectBatchers` (default 999 ≈ off) that keeps the highest-score targets up to a
count. The two logics compose without conflict because they act at different
stages: **prep ordering decides what gets *ready* (velocity, easiest-first); the
cap decides what *runs* among the ready set (value, best-first).** They bind in
different regimes, so the cap never undermines the bootstrap fix. `PREP_LOOKAHEAD`
bounds prep breadth to `cap + lookahead` so prep doesn't sprawl onto servers that
won't earn a slot. Accepted tradeoff: with the cap active a freed slot can briefly
go to an easy modest server before a big earner finishes prepping — self-corrects
as `selectBatchers` retains the best and drops the weaker (hysteresis permitting).

**Then: prepped but still not batching.** Testing on a genuinely fresh save
surfaced two more blockers, both because a low hacking level makes weaken times
long → pipelines huge → batches large:

1. *Admission was all-or-nothing.* `selectBatchers` required a target's whole
   steady-state pipeline (`concurrency × ramPerBatch`) to fit the budget; on a tiny
   pool that never fits, so every target was rejected and nothing batched. Fix:
   admit if at least one batch fits, reserving `min(pipeline, remaining)` and
   running a shallow pipeline (batchPhase caps real fires by free RAM).

2. *The optimal batch itself didn't fit.* `bestHackPct` picked the best-*score*
   hack-%, ignoring pool size, so even one batch could exceed the pool. Fix:
   `bestHackPct` takes a RAM cap and returns the best batch that *fits*;
   `selectBatchers` steps the hack-% **down** when the optimal won't fit, then
   **up** toward optimal as the pool grows, then fills depth, then overflows to the
   next target. This is the depth-first "fill the best, then the next" the user
   wanted. The fit is stable tick-to-tick (`chance` is a common factor across all
   f, so it never flips the winner), so re-fitting every tick doesn't flap.

**Finally: prep starved the ramping pipeline.** A pipeline fills gradually (one
launch per `BATCH_PERIOD`), so a new batcher's reserved RAM is mostly unclaimed at
first — and greedy `prepPhase`, drawing from the same pool, grabbed it (huge grow
waves for 4%-money servers), so the pipeline never filled. Fix: `selectBatchers`
returns its `reserved` total; `prepPhase` holds a `prepFloor` (reserved minus the
batchers' already-running RAM) free, and each `prepWave` is capped to that
headroom. As the pipeline fills the floor shrinks; once batchers are satisfied it's
zero and prep uses the rest. This is the inverse reservation of `BATCH_BUDGET_FRAC`
(which reserves headroom *for* prep) — together they keep batch and prep from
starving each other in either direction.

## RAM gotcha: property names that collide with NS functions

Bitburner's RAM analyzer is **property-name based, not object-aware**. Any
member access whose property name matches an NS function — `obj.hack`,
`obj.grow`, `obj.weaken`, `obj.scan`, `obj.nuke`, etc. — gets charged that
function's RAM, even if `obj` is a plain object and the function is never
called. This was caught when `mem booster.js` showed phantom `hack`/`grow`/
`weaken` charges (0.4 GB) from a `WORKER_RAM = { hack, grow, weaken }` config
object. Fix: the keys are named `hackRam`/`growRam`/`weakenRam` instead.

**Rule for this project: never name a variable or object property after an NS
function.** When in doubt, run `mem <script>.js` and check the line-by-line
breakdown for charges you didn't expect.

## Alternatives considered

- **Separate scanner script** (own file, exec'd on a timer): rejected for the
  integrated approach to save the 1.6 GB base cost of a second script. The
  topology JSON it would have produced is still written, just by `booster`.
- **`getServer` per host** (2 GB) instead of individual getters (~1.1 GB for
  the same fields): rejected — individual getters are cheaper and we only
  need a subset of fields.
- **Calling the security-analysis functions** (`weakenAnalyze` etc.,
  3 GB total): rejected in favor of hardcoded constants.
- **Single optimal `f` via ternary search** instead of a full 1–99% table:
  rejected — a table gives the same optimum *plus* the RAM-constrained
  step-down fallback in one structure, for negligible extra (free) compute.
- **Persistent looping workers** instead of single-shot: rejected — they hold
  RAM indefinitely and can't free it precisely as each op lands, which breaks
  pipelined batch timing.
- **`ns.sleep(delay)` for batch timing** instead of `additionalMsec`:
  rejected — JS event-loop jitter desyncs landings; the engine-side
  `additionalMsec` lands ops precisely for the same RAM cost.
- **Shared `utils.js` helper library** imported by every script: rejected —
  Bitburner's import RAM tax charges the importer the full function cost of
  *everything* in the imported file. Only pure-constant config modules (0 NS
  calls) are safe to share; `booster` is otherwise self-contained.
