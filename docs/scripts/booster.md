# booster

**Location:** `src/booster.js`

## What it does

Early-game bootstrap hacking controller. Each tick it discovers and roots every
reachable server, builds a RAM pool from all rooted hosts, and drives money
extraction via HWGW batching:

- **Prep** brings drifted/unprepared targets to baseline (min security, max money).
- **Batch** runs rolling HWGW grids against prepped, profitable targets.
- **Admission control** caps how many targets batch at once so aggregate RAM
  demand never exceeds what the pool can sustain.

It also writes `/data/servers.json` (topology for managers) and an event log
(`/data/booster-log.txt`) with START/STOP transitions and periodic SUMMARY lines.

## How it works

The main loop (`main`) each tick:

1. `discoverAndRoot` — BFS from home, root what it can, copy workers onto newly
   rooted hosts once.
2. `buildPool` — one entry per rooted host with free RAM, largest-first; home
   keeps a safety buffer.
3. `classify` — splits viable servers into `eligible` (prepped + batch-worthy,
   each scored by $/GB/s via `bestHackPct`) and `needsPrep`. Uses hysteresis:
   **strict** bounds to *start* batching, **loose** bounds to *keep* batching
   (healthy batches oscillate mid-cycle).
4. `selectBatchers` — **admission control.** Walks the score-sorted `eligible`
   list and admits targets while their cumulative steady-state pipeline RAM
   (`ceil(weakenTime / BATCH_PERIOD) * ramPerBatch`) stays under
   `BATCH_BUDGET_FRAC` of the *total* pool. Last tick's batchers (`wasBatching`)
   get first claim on the budget so the active set doesn't flap.
5. `batchPhase` — fires rolling HWGW batches for the admitted set, in rank order,
   regulated by a per-target launch clock advancing by `BATCH_PERIOD`. Calls
   `maybeRecover` to inject supplemental grow/weaken when a batching target drifts.
6. `prepPhase` — spends remaining RAM driving `needsPrep` targets to baseline, one
   corrective wave per target (`prepWave`), skipping any with workers already in
   flight.
7. `updateDisplayStats` / `logEvents` / `renderStatus` — log transitions/SUMMARY
   and refresh the tail. Raw money/security reads land at a random phase of each
   target's batch grid, so they oscillate (e.g. money flips between 100% and
   `100% − hack%`). For display only, `updateDisplayStats` keeps a short rolling
   window per batcher and `displayHealth` reports the window's **peak money /
   floor security** — the grid-aligned baseline (~100% / +0.00 when healthy),
   while a sustained drift still pulls the reported value off. This affects the
   tail table and log SUMMARY only, never batching decisions.

Thread placement (`placeThreads`) greedily bin-packs across the pool and returns
how many threads actually landed.

## Why it's built this way

**Admission control is the core correctness mechanism.** Each batching target
independently tries to maintain a full pipeline of `weakenTime / BATCH_PERIOD`
concurrent batches. Without a global budget, the sum of all pipelines far exceeds
the pool: as pipelines fill, RAM drains to zero. That caused two failures observed
in a 10-hour run:

- **Prep starvation** — `batchPhase` runs before `prepPhase`, so an exhausted pool
  left prep nothing; large targets never finished prepping.
- **Batch drift / oscillation** — an exhausted pool meant batches couldn't fire
  their full pipeline and could half-fire (hack with no compensating grow/weaken),
  so money/security drifted, targets failed the keep-batching check, got kicked to
  prep (the `prepping` count oscillated), then slowly healed and were re-admitted.

`selectBatchers` fixes the root cause by matching aggregate batch demand to pool
capacity. `BATCH_BUDGET_FRAC = 0.85` leaves ~15% of the *total* pool as genuine
headroom for prep, recovery waves, and per-tick jitter — a proportional reserve,
not a flat constant that becomes meaningless as the pool grows. Un-admitted prepped
targets simply idle: since they aren't hacked, they stay at max money at zero RAM
cost and are admitted instantly when budget frees.

**Hysteresis** appears twice: loose keep-bounds in `classify` (tolerate healthy
mid-cycle oscillation) and the `wasBatching`-first pass in `selectBatchers` (don't
flap the admitted set tick-to-tick). Both exist because flapping is itself a source
of drift.

**The batch plan is locked once a target starts batching.** `classify` captures
each target's `bestHackPct` result in `batchPlan` at admission and reuses it every
tick while batching, instead of re-optimising. Re-optimising mid-pipeline was a
real bug: the hack fraction and thread counts shifted tick-to-tick, which (a)
desynced the in-flight HWGW grid (running batches assumed the old shape) and (b)
made each target's pipeline-RAM estimate wobble, so marginal targets flapped in and
out of the admitted set. Flapping is destructive because a dropped target's workers
keep running for a full weaken time while re-admission fires fresh batches on top —
worker accumulation collapses the pool to near-zero, starving everything and
causing the very drift the system is trying to avoid. The plan is deleted when a
target drifts out (so it re-optimises fresh on the next admission).

**Recovery is rate-limited per target.** `maybeRecover` (the safety net that
re-grows a target that has slipped below `RECOVER_MONEY_FRAC`) fires at most one
wave per `growTime` via `recoverClock`. Without this gate it re-fired a full
deficit-sized grow every tick for any persistently-drifted target; those grows
live for the full grow time, so they stacked up, drained the pool, and starved the
normal batches — which pushed more targets below threshold, a runaway that bled the
pool from tens of TB to tens of GB. The cooldown lets one corrective wave land and
be measured before the next fires.

**Launches are capped per tick** (`MAX_FIRES_PER_TICK`). A target whose launch
clock fell behind (e.g. after brief RAM starvation) would otherwise dump its entire
pipeline — hundreds of batches — in a single tick, spiking RAM and re-starving the
pool. The cap refills a pipeline gradually; steady state only needs about one
launch every couple of ticks.

**`prepWave` only counts a weaken wave as handled when threads actually land**
(`placed > 0`) — otherwise a momentarily empty pool would falsely mark a target
done instead of retrying.

A **future RAM-share hook** is documented at the end of the main loop: once prep is
clear, `excess = poolFree - poolTotal * (1 - BATCH_BUDGET_FRAC)` is the genuine
surplus a future `sharePhase` could feed to `ns.share()` for faction-rep bonuses,
recomputed each tick so it yields the moment hacking demand rises. Not built yet.

**Drift-prevention tuning.** Two knobs target the residual per-cycle leak that let
long-pipeline targets (e.g. `iron-gym`) slowly rot even with recovery running:
`THREAD_MARGIN` over-provisions every grow/weaken thread count by a small factor
(hack is left exact) so each batch grows just past max and weakens just past min —
both clamp harmlessly — absorbing the under-restore; and `D_GAP` (the spacing
between HWGW landings) was tightened to reduce overlap jitter. Note `D_GAP` also
drives `BATCH_PERIOD = 4 × D_GAP`, so halving it doubles each target's steady-state
pipeline depth and RAM footprint — fewer targets fit the budget, but each runs
hotter. These are tunables, validated by watching the log.

## Alternatives considered

- **Flat RAM reserve for prep** (e.g. reserve 40 GB): rejected. It's negligible
  against a multi-TB pool and treats the symptom (prep starvation) without
  addressing overcommit, leaving batch drift unsolved.
- **Reorder prep before batch / interleave**: would help prep but not stop batch
  overcommit or drift, and complicates the rank-priority model.
- **Per-target reserve instead of a global budget**: doesn't bound the *aggregate*
  demand, which is the actual constraint.
- **Counting in-flight batches to limit depth**: the existing launch-clock model
  already regulates per-target depth implicitly; the missing piece was a *global*
  admission gate, which `selectBatchers` adds with minimal new state.
