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
- **Hack-% ramp** raises hack fractions above the RAM-efficiency optimum when the
  whole fleet is engaged and pool RAM still sits idle, trading efficiency for
  absolute income.

- **Manager orchestration** launches the pserver/contracts/hacknet managers on
  home, in a fixed dependency order, once each one's gate passes.

It also writes `/data/servers.json` (topology for managers) and refreshes a live
status view each tick: the tail window (rendered by `lib/tail-ui.js`) always, plus
the HTML dashboard overlay when home has at least `DASHBOARD_MIN_HOME_RAM_GB`
(256 GB) — below that only `ns.ui.openTail()` (0 GB) is used, since early home RAM
is too scarce to spend on the overlay.

## How it works

The main loop (`main`) each tick:

1. `discoverAndRoot` — BFS from home, root what it can, copy workers onto newly
   rooted hosts once. **home is included as a rooted pool host** (it already holds
   the worker scripts, being the copy source) with `maxMoney 0` so `classify` never
   targets it for hacking — only its RAM is used.
2. `launchManagers` — exec's the first not-yet-running manager (pserver →
   contracts → hacknet, fixed order) on home, if its gate passes. pserver leads
   because it buys the RAM everything else runs on, and — since only the FIRST
   pending manager is ever considered — its small footprint (5.85 GB) can't block
   the chain on a tiny early home the way contracts (16.8 GB) could when it led
   the order. `nextManagerReserve`
   (called just before this) returns the RAM the *next* pending manager needs, fed
   into `buildPool` below so that headroom is walled off from workers before they
   can claim it.
3. `buildPool` — one entry per rooted host with free RAM, largest-first; home
   keeps the safety buffer **plus the next pending manager's RAM reservation** free,
   and contributes the rest to the pool.
4. `classify` — splits viable servers into `eligible` (prepped targets, each
   scored by $/GB/s via `bestHackPct`) and `needsPrep` (not yet at baseline). There
   is **no hack-chance floor** — `bestHackPct`'s `score` already multiplies in
   `chance` (`moneyPerBatch = maxMoney × f × chance`), so a low-chance target is
   correctly ranked low rather than excluded; it only wins a batch slot via
   `selectBatchers` if nothing higher-scoring is competing for the RAM. Uses
   hysteresis: **strict** bounds (on the raw read) to *start* batching, **looser**
   bounds to *keep* batching. The keep-test is judged on the **grid-aligned
   windowed baseline** (`displayHealth`'s peak money / floor security), not the raw
   instantaneous read — a healthy batch's money legitimately plunges to ~(1−hack%)
   each cycle, and its security legitimately spikes by the grow's full bump in the
   gap between the grow landing and its counter-weaken (at high hack-% that bump is
   large). Judging keep on those raw troughs/spikes would false-drop healthy
   targets. `chance` is dropped from the keep-test entirely: once a target is
   admitted, `chance` only degrades via security, which the floor-security bound
   already catches — and the raw `chance` read dips on the same mid-cycle spike.
   `needsPrep` is sorted **easiest-earner first** (ascending `maxMoney`).
5. `selectBatchers` — **admission control + per-target waterfall ramp.** Two passes
   over the `eligible` list in rank order (incumbents from `wasBatching` get a small
   `SELECT_KEEP_BIAS` so the set doesn't flap). A target's *base pipeline cost* is
   `concurrency × base ramPerBatch`, where `concurrency = ceil(weakenTime / BATCH_PERIOD)`
   (f-independent).
   - **Ranking metric tracks the binding constraint.** If the top-`MAX_BATCH_TARGETS`
     *earners* (by `potential = maxMoney × chance`, a target's absolute $/s once ramped)
     all fit their base pipelines in the budget, RAM is **not** the bottleneck — the count
     cap is — so admission ranks by `potential`, giving the slots to the biggest earners.
     Otherwise RAM is scarce and admission ranks by `$/GB/s` `score` (most income per
     limited GB). The mode (`ramAbundantMode`) is **sticky with a 5% hysteresis band** so a
     pool wobble at the boundary can't flap the metric and churn deep pipelines. This fixes
     the case where, under the count cap with idle RAM, a fast low-money server (great
     `$/GB/s`, poor `$/s`) would take a slot from a far bigger earner with a longer cycle.
   - **Pass A — pack base load.** Admit each target at its score-optimal (base) plan
     until the budget (`BATCH_BUDGET_FRAC` of the *total* pool) or `MAX_BATCH_TARGETS`
     binds. If a target's full base pipeline doesn't fit `remaining`, it's the marginal
     target: step its hack-% **down** to a single batch that fits (`bestHackPct(...,
     remaining)`), claim the rest of the budget, and run a shallow pipeline that
     `batchPhase` deepens later. This is the small-pool path; it consumes the budget, so
     no excess remains.
   - **Pass B — waterfall the excess.** If Pass A left budget unspent (every admitted
     base pipeline fit, with room over), spend it by ramping the **single best** target's
     hack-% up to `HACK_PCT_RAMP_MAX` first (more money/batch at worse $/GB/s — fine, the
     GB are idle), then spilling any remainder to the 2nd-best, and so on.
     `maximizeHackPct` finds the highest f that fits each target's capacity (base cost +
     running excess). The running excess is **clamped at 0** after each target: a locked
     incumbent plan may sit up to `RAMP_HYSTERESIS_FRAC` above its capacity (absorbed by
     the refill headroom), and propagating that negative would silently shrink the next
     target's capacity below its base cost and break its ramp.
     The ramped f is **sticky** (locked in `rampPlan`): a running
     incumbent reuses its locked ramp and does **not** re-ramp tick-to-tick as the excess
     pool wobbles — only a fresh/re-anchored target (no in-flight grid to desync) takes a
     new ramp immediately, and a level-up re-ramps via `classify` clearing `rampPlan`.

   Returns `{ batchers, reserved, rampSaturated }` — `rampSaturated` is true once every
   placeable target is admitted, all are at `HACK_PCT_RAMP_MAX`, and budget still
   remains (the share-eligibility signal).
6. `batchPhase` — a **self-pacing scheduler** that tops each admitted target's
   pipeline up to a target depth. It keeps a per-target `pipelines` entry
   (`committed[]` future W1 landing times, `lastLand`, `depth`); each tick it drops
   landings that have passed and fires enough new batches to refill to `depth`, each
   landing one `BATCH_PERIOD` after the previous committed one (or a fresh weaken-time
   + safety ahead if the pipeline drained). `depth = ceil(weakenTime/BATCH_PERIOD)` is
   derived from the **stable min-security weaken time** locked in the plan, so depth is
   constant and the pipeline holds at exactly N in flight. There is **no baseline
   fire gate, no skipped slots, and no recovery wave** (see "Why it's built this
   way" and [History](#history) below). The pipeline
   fills gradually (≤ `MAX_FIRES_PER_TICK` per tick) so RAM use ramps over ~a weaken
   time; a momentarily full pool just defers the rest to a later tick. Each fire is
   gated on `placeableThreads` — whole worker threads that actually fit per host —
   not on raw `poolFree`, whose sum counts sub-thread slivers (1.0 GB free on 30
   hosts reads as 30 GB "free" where no 1.75 GB thread fits) and could let a batch
   **half-fire** under fragmentation: hack placed, grow not, silently unbalancing
   the batch. `fireBatch` additionally verifies placement and logs a `HALF-FIRE`
   debug line if the gate and reality ever disagree.
7. `prepPhase` — spends remaining RAM driving `needsPrep` targets to baseline, one
   **combined overlapped wave** per target (`prepWave`): W1 fires undelayed and
   lands first (security → min), the grow fires in the same tick with
   `additionalMsec = weakenTime − growTime + D_GAP` so it lands `D_GAP` after W1
   (full growth multiplier at min security), and the counter-weaken lands `D_GAP`
   after the grow — the same landing-order technique as `fireBatch`. A full prep
   thus drains in **one** weakenTime instead of the two the old serial version took
   (weaken, wait for it to drain, then grow). Targets with workers already in
   flight are skipped; at most `MAX_BATCH_TARGETS + PREP_LOOKAHEAD` servers prep at once.
   Stops at a `prepFloor` = the batchers' reserved-but-unclaimed RAM, and each
   `prepWave` is capped to that headroom — so prep can't starve a pipeline that is
   still ramping toward full depth.
8. `sharePhase` — feeds the genuinely-idle pool residual to `ns.share()` for a
   faction-reputation boost. Runs *after* batch + prep so it only ever sees what they
   left. Gated to spend true surplus only: paused while the manual `SHARE_OFF_FLAG`
   flag is set in the flag port (`/utils/share-off.js` sets it, `share-on.js` clears it;
   the port clears on reset/reload so a pause lifts on a fresh run),
   otherwise active only once `rampSaturated` (from `selectBatchers`)
   **and** `needsPrep` is empty — i.e. every admitted target is at `HACK_PCT_RAMP_MAX`
   and the pool still has idle RAM. It spends `SHARE_BUDGET_FRAC` (0.75) of the residual
   `poolFree − poolTotal × (1 − BATCH_BUDGET_FRAC)`, topping the in-flight
   share-thread count (`countShareThreads`) up to that target with **single-shot 10 s
   share workers** (`placeShare`). When batch/prep demand returns, the residual
   shrinks, booster launches fewer, and the running workers free their RAM within
   ~10 s — so it yields without needing a share-specific kill (footprint currently
8.85 GB, `BOOSTER_RAM_GB`).
9. `updateDisplayStats` / `buildSnapshot` / `renderTail` — refresh the status
   views. `buildSnapshot` assembles ONE plain-JSON snapshot per tick; `renderTail`
   (shared `lib/tail-ui.js`) renders the tail window from it, and `publishStatus`
   ships the same object to the status bus for `dashboard.js` — one source of
   truth, two views with full information parity (pool usage, pipeline fill, the
   ranked target table tagged ATK/PRE/IDL, ranking mode, share state, manager
   status lines read from their status ports, and lag/pool alerts).
   Raw money/security reads land at a random phase of each target's batch grid, so
   they oscillate (e.g. money flips between 100% and `100% − hack%`). For display
   only, `updateDisplayStats` keeps a short rolling window per batcher and
   `displayHealth` reports the window's **peak money / floor security** — the
   grid-aligned baseline (~100% / +0.00 when healthy), while a sustained drift still
   pulls the reported value off. This affects the display only, never batching
   decisions.

Thread placement (`placeThreads`) greedily bin-packs across the pool and returns
how many threads actually landed.

## Why it's built this way

**home is a pool host, not a special case.** `discoverAndRoot` originally did
`if (host === "home") continue;`, which dropped home from `servers` entirely — so it
never reached `rootedHosts`, the pool, or the RAM totals, and *neither prep nor
batches ever ran on it*. On a save where home is the largest single block of RAM, the
batcher would crowd a small set of weak rooted servers to ~0 free while home sat idle
(and prep threads it *had* placed were invisible in the table, which lists only
batching targets and prep names — making it look like nothing launched). The fix is to
emit home as an ordinary rooted host with `maxMoney 0`: `classify` skips it as a target
(money ≤ 0) but it flows through `buildPool` (which already carried the
safety-buffer + manager-reserve logic for home), the pool totals, and the batch budget
like any other host. Keeping home a normal entry — rather than threading a separate
"home RAM" path through every phase — means the reserve is respected in exactly one
place and every consumer stays uniform.

**Prep is ordered easiest-earner-first to bootstrap a fresh save.** With a tiny
starting pool, prepping biggest-money-first (the original order) poured the whole
pool into partial waves for the largest servers — which can't finish for hours —
while the trivially-cheap earners starved at the back of the queue, so no income
ever flowed to grow the pool. Sorting `needsPrep` ascending by `maxMoney` gets the
cheap servers prepped and batching in seconds; their income funds the pool that
later preps the big servers. This is self-scaling (no bootstrap mode, no hardcoded
`n00dles`, no RAM threshold): once the pool is large, prep is fast for everyone and
the order stops mattering. `maxMoney` is a free, tunable prep-cost proxy.

**Batches are sized to fit the pool (step-down/up).** On a fresh save the hacking
level is low, so weaken times are long, pipelines are huge, and a single
*optimal* batch can exceed the whole tiny pool — leaving a server prepped but
unable to batch. `bestHackPct` therefore takes a RAM cap and returns the best
batch that *fits*; `selectBatchers` uses the optimal batch when it fits, else steps
the hack-% down. As the pool grows the hack-% climbs back toward optimal, then
`batchPhase` fills the depth, then the full pipeline completes and the leftover
budget overflows to the next target — a depth-first "fill the best, then the next"
progression. The fitted choice is stable tick-to-tick (`chance` is a common factor
across all f, so it never flips which f wins), so re-fitting each tick doesn't
cause flap.

**The hack-% waterfall spends idle RAM where it pays most.** `bestHackPct` picks the
`f` that maximizes `$/GB/s` — RAM *efficiency* — which is correct only while RAM is
the bottleneck. After hours on a fresh save, every available target batches at that
efficiency peak yet the pool still sits on huge free RAM (idle GB earn nothing). The
fix raises hack-% *above* the per-target peak: more money per batch at worse
`$/GB/s`, which is a good trade when the GB are otherwise idle. Crucially this is done
**per target, not as a flat global floor.** A flat floor raised every target's hack-%
in lockstep — which buys little extra money on weak targets while inflating the whole
admitted set's RAM, shoving the marginal target past the budget so it drops out (the
old `rampLevel` produced a 1-tick limit cycle: ramp 40↔42%, batchers 10↔8). The
waterfall instead pushes the **single most lucrative** target to `HACK_PCT_RAMP_MAX`
first and only spills leftover budget down the ranked list, so every excess GB goes to
the highest-payout target available. Anti-flap comes from the **sticky ramp lock**
(`rampPlan`): a running incumbent keeps its ramped `f` while it still fits, so its
pipeline RAM footprint never jitters as the excess pool wobbles tick-to-tick (the same
reason the base plan is locked). Only a fresh/re-anchored target — which has no
in-flight grid to desync — takes a new ramp immediately; a level-up re-ramps via
`classify` clearing `rampPlan` when the base recomputes.

**`HACK_PCT_RAMP_MAX` doubles as the share-residual boundary.** Capping each target's
hack-% at a fixed maximum means that once the waterfall is **saturated**
(`rampSaturated`: every placeable target admitted, all at the cap) and `needsPrep` is
empty, every target is hacking as hard as we allow, so the free RAM still left over —
`poolFree − poolTotal × (1 − BATCH_BUDGET_FRAC)` — is genuine, well-defined surplus.
`sharePhase` (Stage 5) claims a fraction (`SHARE_BUDGET_FRAC`) of exactly that residual
for `ns.share()` workers, recomputed each tick so falling demand reclaims it as the
running single-shot workers expire (~10 s).

**Prep can't starve a ramping pipeline.** A pipeline fills gradually (one launch
per `BATCH_PERIOD`, over ~a weaken time), so a freshly-admitted target's reserved
RAM is mostly *unclaimed* at first. Since prep and batching draw from the same
pool, greedy prep would grab that unclaimed RAM and the pipeline could never fill.
So `selectBatchers` reports its `reserved` total, and `prepPhase` keeps a
`prepFloor` (reserved minus the batchers' already-running RAM) free; each
`prepWave` is also capped so one large grow can't overshoot it. As the pipeline
fills, the floor shrinks and prep gets more room — and once batchers are satisfied,
the floor is zero and prep uses everything left.

**Two batching ceilings for two regimes.** Early game is *RAM-limited*, governed
by `BATCH_BUDGET_FRAC`. Late game is *lag-limited* — Bitburner slows with too many
concurrent worker scripts, and the self-pacing scheduler runs every target at its
full natural depth (`ceil(weakenTime/BATCH_PERIOD)`, hundreds of batches on a deep
target), so this is the binding late-game constraint — governed by
`MAX_BATCH_TARGETS` (currently a deliberately low **10**, tuned by hand against
observed lag; there is no longer a per-target depth cap). The two never conflict:
prep ordering decides
what gets *ready* (velocity, easiest-first), the cap decides what *runs* among the
ready set (value, best-score-first). They bind in different regimes, so the cap
never undermines the bootstrap fix. `PREP_LOOKAHEAD` keeps prep breadth aligned
with the cap so prep doesn't sprawl onto servers that won't earn a slot. Tradeoff:
with the cap active, a freed slot can briefly go to an easy modest server before a
big earner finishes prepping — this self-corrects as `selectBatchers` retains the
top-ranked targets and drops weaker ones (hysteresis permitting). Crucially, the
**rank metric itself adapts to which ceiling binds**: in the lag-limited (cap-bound,
RAM-rich) regime it ranks by absolute earning power (`maxMoney × chance`) so the
limited slots hold the biggest *earners*; only in the RAM-limited regime does it
rank by `$/GB/s` efficiency. Ranking by efficiency under the count cap would waste
slots on fast low-money servers while a 10×-bigger earner sat idle.

**Admission control is the core correctness mechanism.** Each batching target
independently tries to maintain a full pipeline of `ceil(weakenTime/BATCH_PERIOD)`
concurrent batches — the **same depth `batchPhase` actually runs** (the reservation
estimate and the scheduler must use the identical formula, or the budget is over- or
under-reserved). Without a global budget, the sum of all pipelines far exceeds
the pool: as pipelines fill, RAM drains to zero. That caused two failures observed
in a 10-hour run:

- **Prep starvation** — `batchPhase` runs before `prepPhase`, so an exhausted pool
  left prep nothing; large targets never finished prepping.
- **Batch drift / oscillation** — an exhausted pool meant batches couldn't fire
  their full pipeline and could half-fire (hack with no compensating grow/weaken),
  so money/security drifted, targets failed the keep-batching check, got kicked to
  prep (the `prepping` count oscillated), then slowly healed and were re-admitted.

`selectBatchers` fixes the root cause by matching aggregate batch demand to pool
capacity. `BATCH_BUDGET_FRAC` (currently **0.90**) leaves the complementary
`REFILL_HEADROOM_FRAC` (~10%) of the *total* pool as genuine, hard-reserved
headroom for prep, refills, and per-tick jitter — a proportional reserve,
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

**In-flight workers must match the current plan — kill them when they can't (the
flood-churn fix).** The worker-accumulation collapse described just above was the root
of a long, recurring "RAM spirals to 100%, everything churns" failure that appeared
whenever a flood of newly-prepped big servers entered the set and forced others to ramp
down. The invariant the whole batcher depends on: **`reserved` (admission's RAM model,
`depth × ramPerBatch`) must equal the actual in-flight worker RAM.** It silently breaks
whenever a pipeline's live workers stop matching its plan, and three sources were found
and fixed:

- **Drop → re-admit.** `classify` dropping a target left its HWGW workers running for a
  full weaken time; the target was usually re-admitted within seconds, so those stale
  workers stacked on the fresh pipeline (3–4 generations → 2–3× the plan's RAM, hidden
  in the *batch* bucket because the host was re-admitted). Fix: `killWorkersFor` kills
  **all** of a target's in-flight workers at the moment `classify` drops it, so re-prep
  starts clean — exactly the state a cold restart enjoys.
- **f-change on a live pipeline.** When `selectBatchers` lowered a target's hack-% (its
  share of leftover budget shrank), the pipeline stayed full of the old, *larger*-f
  workers while `reserved` was computed on the new, smaller f — real RAM 5–10× the
  plan. Fix: `batchPhase` detects a meaningful f-**drop** (> `REANCHOR_DROP_FRAC`) and
  **instant-drains** the pipeline (kills all its workers, refills from empty at the new
  f), so actual RAM snaps down to match `reserved` that tick. f-**up** needs no kill
  (old small + new big drains safely; `reserved` over-counts → conservative).
- **f churn.** The above re-anchor would thrash if f wobbled tick-to-tick, so the
  ramp/marginal plan is now **hysteretic** (`RAMP_HYSTERESIS_FRAC`): an incumbent keeps
  its locked plan while its cost stays within a band of its allocated capacity, making f
  piecewise-constant so re-anchors are rare and deliberate.

Together these keep `reserved ≡ actual`, so the pool can never silently oversubscribe.
(A fourth source — a server *evicted* from the top-`MAX_BATCH_TARGETS` leaving its
workers draining as untracked "orphan" RAM — is understood but left for later, as it
was small once the above were fixed; a debounced kill-on-sustained-eviction is the
planned remedy if it ever grows.)

**A protected refill headroom (`REFILL_HEADROOM_FRAC`).** Prep and share must always
leave a hard slice of free RAM (`poolTotal × REFILL_HEADROOM_FRAC`, the complement of
`BATCH_BUDGET_FRAC`) untouched, so `batchPhase` can always fire each pipeline's per-tick
refills and no pipeline decays. Before this, `prepFloor` only shielded the batchers'
*unclaimed* reservation, which collapsed to ~0 once pipelines filled — letting prep
drive free RAM to zero and starve refills. It is defence-in-depth (not the primary cure,
which is the worker-matching above) but a correct, cheap invariant.

**Batch landing times use fresh op-times, never the locked plan's.** `batchPhase`
schedules each batch's four landings from `ns.getWeakenTime/getGrowTime/getHackTime`
fetched *fresh* every fire — it must **not** reuse the `weakenTime` stored in the
locked plan. This was the root cause of a severe high-hack-% desync: the plan locks
its thread counts (`h/g/w1/w2`) at admission, but if its `weakenTime` is also reused
for scheduling, it goes stale as the hacking level climbs (real weaken time shrinks).
Because each op's delay is `base ± offset − now − opTime`, a too-large stale
`weakenTime` makes the two weakens (`W1`, `W2`) land progressively earlier than their
hack/grow; once the error exceeds one `D_GAP` the landing order flips to `W1, H, W2,
G` — the big `W2` lands *before* its `G`, so the grow's security bump is never
cleared and stacks across batches until the target drifts. It was invisible for
months because at low hack-% the grow is tiny (a fraction of a security point); the
ramp pushed grow counts into the thousands (tens of security points per batch), which
turned the latent bug into immediate, violent drift. The fix is one line — fetch
`weakenTime` fresh alongside grow/hack — and is RAM-free (`getWeakenTime` is already
charged via `bestHackPct`). The *thread counts* stay locked (they're robust, over-
provisioned by `THREAD_MARGIN`); only the landing *timing* must track the live level.

**The scheduler is self-pacing, with no baseline fire gate — this is the central
drift fix.** `batchPhase` tracks each target's committed future landings
(`pipelines` map) and, each tick, fires enough new batches to refill to `depth`,
each landing `BATCH_PERIOD` after the last committed one. Nothing is gated and
nothing is discarded — only clean, collision-free landings are ever scheduled, so
the pipeline holds full with zero drift. Validated in the isolated rig
(`src/test/batch-rig.js`): iron-gym at full depth 248 held +0.00 security, ~2 ms
landing error, 0 skipped, ~98% throughput (≈1469 fires/10 min) indefinitely. See
[History](#history) for the two earlier scheduler designs this replaced.

Two details make it hold exactly N in flight: `depth = ceil(weakenTime/
BATCH_PERIOD)` comes from the **stable min-security weaken time** in the locked plan
(using the live, security-inflated value would grow the depth target on a
transient bump and overfill), while landing *times* use **fresh op-times** so each
op still lands on slot. `committed.length` is also the live pipeline fill shown in
the status table.

A target that genuinely dips below the loose keep-bounds simply drops to a clean
re-prep via `classify`'s drift-grace logic — there is no separate corrective-wave
mechanism. With the self-pacing scheduler holding targets at baseline, such dips
are rare.

**Fill is capped per tick** (`MAX_FIRES_PER_TICK`). A target refilling a deep
pipeline (e.g. after brief RAM starvation) would otherwise fire its entire backlog
in a single tick, spiking RAM and re-starving the
pool. The cap refills a pipeline gradually; steady state only needs about one
launch every couple of ticks.

**`prepWave` only overlaps the grow when its weaken fully fit.** If the weaken
threads don't all place (budget/pool bound), the grow is NOT fired that tick — it
would land on still-elevated security and waste threads — and the wave finishes on
later ticks. Grow threads are sized at CURRENT (elevated) security, where
`growthAnalyze` reports weaker per-thread growth than the min security the grow
actually lands on: a deliberate over-provision (on top of `THREAD_MARGIN`) that
clamps harmlessly at max money.

**RAM share is opt-out, single-shot, and self-yielding (Stage 5).** `sharePhase`
feeds the residual `poolFree − poolTotal × (1 − BATCH_BUDGET_FRAC)` to `ns.share()`
once prep is clear and the ramp is maxed. Three design choices keep it from ever
hurting the batcher: it runs **after** batch + prep (sees only leftovers); it spends
only `SHARE_BUDGET_FRAC` (0.75) of the residual (a cushion against the worker-expiry
lag — `ns.share()`'s sharply-diminishing per-thread returns make this nearly as good
as 100 % anyway); and it uses **single-shot 10 s workers** topped up each tick rather
than long-lived ones, so reclaiming RAM needs no `ns.kill` — booster just launches
fewer and the rest expire within ~10 s. It is **on by default** (the user accepted
that `ns.share()` only boosts rep *while doing faction work*, so off-faction-work it
wastes cycles but never harms hacking); `/utils/share-off.js` sets the
`SHARE_OFF_FLAG` flag in the flag port (`lib/flags.js`) to pause it and
`/utils/share-on.js` clears it to resume. A standalone manager
was rejected: the residual only exists inside booster's per-tick pool accounting, so
a separate process couldn't see it without a lagging coordination file.

**No hack-chance floor — trust the score.** `bestHackPct`'s `score` already
multiplies in `chance` (`moneyPerBatch = maxMoney × f × chance`), so a low-chance
target is already penalized in proportion to its actual risk — it just naturally
ranks low and only gets a `selectBatchers` slot when nothing better is competing
for the RAM (the same philosophy as the hack-% ramp spending otherwise-idle RAM).
A failed hack still raises security by exactly the amount its thread count
accounts for (security cost is per-thread, not per-success), so a low-chance
target doesn't desync the grid by failing more often — it's just lower expected
value per RAM, which `score` already reflects. See [History](#history) for the
admission gate this replaced.

**Manager suppression lives in the flag port; launches retry on a failed `ns.exec`.**
The "seen running this run" set (`managersSeen`) is stored in the shared flag port
(`lib/flags.js`), not in booster's memory. Netscript ports are wiped on game restart
**and on aug/soft reset** (verified in-game), so the suppression
is inherently per-run: a manager that self-completed or was stopped stays down until a
reset clears the port, at which point the wiped pservers/hacknet rebuild — correct even
if the booster process *survives* the reset (a survived in-memory set used to wrongly
suppress everything; an earlier hacking-level reset-detector was deleted once the port
made it unnecessary). `launchManagers` only records a manager as seen when `ns.exec`
returns a nonzero pid: `ns.exec` fails silently — returns `0`, no exception — when home
lacks free RAM at that instant (e.g. right after a reset, before `buildPool`'s manager
reserve has had a tick to take effect). A failed launch would otherwise be
indistinguishable from "the user manually stopped it," permanently skipping that manager;
instead it logs a `WARN` line and retries the very next tick. `nextManagerReserve`/`homeReserveExtra`
(walling off the next manager's RAM on home before workers can claim it) is
the *prevention* half of this — it makes the failure rare — and the retry is
the *safety net* for the one moment prevention can't help: the very first tick
of a fresh process, before any prior tick has reserved anything yet.

**Keep-bounds tightened to ~10%, security made relative.**
`BATCH_KEEP_MONEY_FRAC` (0.2 → 0.9) and the old flat `BATCH_KEEP_SEC_OVER` (+5,
replaced by `BATCH_KEEP_SEC_FRAC = 0.10`, evaluated as `minSecurity × (1 +
this)`) were originally set loose to avoid false-tripping on normal HWGW
cycling. That oscillation is already filtered out upstream by `displayHealth`'s
windowed peak/floor (the keep-test reads the window's *peak* money and *floor*
security-over, not the raw instantaneous value), so the keep-bounds only ever
needed to catch genuine, sustained drift — the 0.2/+5 values were tolerating
far more damage (up to an 80% money loss, or a flat +5 security regardless of
how small the target's `minSecurity` was) than necessary before triggering a
re-prep. Security was also switched from an absolute number to a fraction of
`minSecurity`, mirroring `SEC_MARGIN`'s relative style for the strict
start-batching check (stricter bound to start, looser to keep — same pattern,
now consistent units on both ends).

**Drift-prevention tuning.** `THREAD_MARGIN` over-provisions every grow/weaken
thread count by a small factor (hack is left exact) so each batch grows just past
max and weakens just past min — both clamp harmlessly — absorbing the residual
per-cycle under-restore that let long-pipeline targets slowly rot.

`D_GAP` (spacing between HWGW landings, currently **100 ms**) also drives
`BATCH_PERIOD = 4 × D_GAP`, so it sets batch *throughput*: a smaller `D_GAP` →
shorter period → more batches/second → more income on RAM-rich pools (where deeper
pipelines are free). It is **not** a drift knob — the engine enforces landing times
via `additionalMsec`, so 100 ms is ample spacing as long as the scheduling op-times
are current (see the fresh-`weakenTime` point above). A brief experiment widening it
to 200 ms appeared to reduce drift, but that was a misdiagnosis: 200 ms only bought
more staleness headroom before the order flipped. With the stale-time bug fixed,
`D_GAP` returned to 100 ms for the throughput.

**The security limit cycle and its four coupled fixes (stage 9).** Long after every
other drift source was fixed, batchers on low-`minSecurity` starter servers
(foodnstuff, sigma-cosmetics) still drifted and dropped to re-prep — with a static
hacking level and shallow pipelines, ruling out plan staleness and lag. Worker
**landing telemetry** (below) showed landings precise to ≤ 18 ms and money always
restored, but security swinging `+0.3 ↔ +12.9` on alternating ticks while `depth`
and `reserved` flapped tick-to-tick. Three interacting mechanisms, four fixes:

- **Baseline mint gate.** `hackAnalyze`/`getWeakenTime`/`growthAnalyze` read the
  *current* security, so a plan (re)minted during the grid's ~100 ms post-grow "hot"
  window carries oversized `h` and an inflated `weakenTime` — skewed threads in
  flight, and a flapping depth/reserved as hot- and cold-minted ramp plans alternate.
  `classify`'s level-recompute and Pass B's re-ramp now only mint on a tick that
  reads the target at min security, reusing the locked plan meanwhile (the cold
  phase comes every `BATCH_PERIOD`, so the deferral lasts a tick or two). A deferred
  level-recompute keeps the old `level` stamp so it retries. Money is deliberately
  NOT gated — no mint input depends on it, and raw money legitimately sits at
  `(1−f)` most of the cycle.
- **Base-plan depth.** `batchPhase` derives `depth` from the BASE locked plan's
  `weakenTime` (`batchPlan`), never the batcher entry's — which may carry a ramped
  plan whose `weakenTime` was minted at a different security.
- **Security-phase fire deferral — the central fix.** An op's *duration* is fixed
  when the WORKER calls `ns.hack/grow/weaken`, about one engine tick AFTER the
  controller's `exec` — but the landing delays are computed from op-times read at
  exec. If security changes in that gap (the hot window again), the real duration
  differs from the estimate by *seconds* (op times scale with security), the ops
  land off-slot, create larger hot windows, and the error self-sustains as a limit
  cycle. `batchPhase` now never fires while the target reads above
  `minSecurity × (1 + SEC_MARGIN)`: it defers to the next tick (`FIRE-HOT` debug
  line). This is NOT the old Mode-A baseline fire gate — the landing clock
  (`lastLand`) keeps advancing, only the exec moment shifts, so no slot is lost and
  the pipeline stays full. Validated: 0 drops over 122 ticks, fills at ~100%,
  `FIRE-HOT` on ~11% of refill attempts with no starvation.
- **De-aliased loop + absolute keep floor.** At exactly `BATCH_PERIOD/2` the tick
  phase-locked to two fixed points of the landing grid (observed: `gap=205ms` every
  tick), so fires and health samples deterministically hit the same grid phases —
  if one was the hot window, every fire was bad. `LOOP_SLEEP` is now
  `BATCH_PERIOD/2 + 30` so the phase rotates. And the keep-bound gained an absolute
  floor (`BATCH_KEEP_SEC_ABS = 1.0`): the purely relative `min × 0.10` was a +0.30
  hair-trigger on `minSecurity = 3` servers — exactly where the drops clustered.

**Landing telemetry (drift diagnosis).** Every `TELEMETRY_SAMPLE`-th batch is tagged
so its four workers report `[opTag, target, expectedLand, actualLand, opReturn,
threads]` on `TELEMETRY_PORT` right after the op resolves (`writePort` is 0 GB, so
per-thread worker RAM is unchanged; the port number is hardcoded in the workers
because they are scp'd standalone). `drainTelemetry` aggregates per-target rolling
stats — landing error (`OFF-SLOT` past `TELEMETRY_ERR_WARN_MS`), failed hacks (`h0`),
successful hacks stealing below the plan's full-server `steal` (`HACK-LOW` — the
under-restore fingerprint), near-totally clamped weakens (`wCl` — a weaken reducing
< 25% of its capacity landed *before* the grow it counters; partial clamping is
normal, the margin over-provisions weakens by design) — and the `DROP`/trace lines
carry the summary. Debug-gated: with `CONTROLLER_DEBUG` off no batch is ever tagged.
Since the stage-9 diagnosis closed, `CONTROLLER_DEBUG` defaults to **false** — the
telemetry and debug logging stay in the code, dormant at zero cost; flip the flag in
`constants.js` to re-arm the whole toolkit if drift ever returns.

## History

Design decisions whose original code no longer exists in the script — kept for
context on *why* the current design looks the way it does, and so a future change
doesn't unknowingly resurrect an approach already tried and rejected.

**Scheduler evolution: baseline fire gate → decoupled skip-late → self-pacing
top-up.** The current self-pacing scheduler (see "Why it's built this way") is the
third design, validated against the first two using the test rig
(`src/test/batch-rig.js`, modes A/B/C):

- *Mode A — baseline fire gate (original).* A batch only fired while the server
  read at (near) min security, and the landing clock advanced *only on a fire*. On
  a deep pipeline (long-`weakenTime` targets like iron-gym) security is perpetually
  bumped by in-flight hacks/grows, so the gate was shut most of the time; while shut
  the clock stalled while `now` ran on, until the next fire's `addW1` went negative,
  clamped to 0, and the batch landed **late and off-grid** — breaking the
  H‑W1‑G‑W2 order so grow-security stopped being cleared and the target ran away.
  On iron-gym the rig measured landing-error p95 ≈ 2.5 s, 71% of landings
  off-optimum.
- *Mode B — decoupled grid + skip-late.* The gate was dropped (an op fired at `now`
  lands at `now + freshWeakenTime`, so it lands on slot regardless of current
  security — the gate bought no correctness) and slots too stale to land on-grid
  were *skipped*. This fixed the drift (p95 ≈ 2 ms, +0.00 security) but the skip
  bookkeeping wasted throughput: the grid drifted ahead of itself and discarded
  ~⅔ of slots (rig: 502 fired vs 1111 skipped over 10 min, ~31% of theoretical).
- *Mode C — self-pacing top-up.* Replaced both: no grid to skip against, just track
  committed future landings and refill to `depth` each tick. This is the design
  that shipped and is documented under "Why it's built this way."

**Drift recovery used to be an off-grid corrective wave (`maybeRecover`).** An
earlier `maybeRecover` function injected supplemental grow/weaken **off the grid**
when a batcher dipped below health; those landings collided with the in-flight
pipeline at unanticipated times, spiking security past the (then-present) fire gate
and locking the target into the very runaway it was meant to fix. It was removed
entirely, along with its `recoverClock` state. The current behavior — drop to a
clean re-prep via `classify`'s drift-grace logic — has no separate recovery code
path at all.

**The hack-% ramp used to be a single global `rampLevel` floor.** The original
absorber was a sticky global floor moved at most one `RAMP_STEP` per tick, gated on
pool utilization (`1 − free/total`) with a `RAMP_UTIL_LOW..HIGH` deadband and a
`RAMP_BUDGET_MIN` headroom check — `classify` then planned every target at
`max(score-optimal f, rampLevel)`. Two problems killed it. (1) Applying the floor to
*every* target in lockstep is the wrong objective under RAM pressure: it grows weak
targets (little extra money) and inflates the admitted set's RAM, shoving the marginal
target past the budget so it drops — a 1-tick limit cycle (ramp 40↔42%, batchers
10↔8) that the budget-headroom gate only partly tamed. (2) The signals (utilization
vs committed-but-unfilled budget) were hard to reconcile because pipelines fill
gradually. The current per-target **waterfall** in `selectBatchers` replaces it
entirely: it ramps the best target to `HACK_PCT_RAMP_MAX` first and spills excess down
the rank order, computing each target's exact RAM footprint so it never overspends the
budget, with the sticky `rampPlan` lock preventing tick-to-tick jitter. `RAMP_STEP`,
`RAMP_UTIL_LOW`, `RAMP_UTIL_HIGH`, and `RAMP_BUDGET_MIN` were deleted; only
`HACK_PCT_RAMP_MAX` (the per-target cap and share boundary) remains.

**`CONCURRENCY_CAP` — a per-target pipeline-depth cap, removed.** Before the
self-pacing scheduler existed, each target's pipeline depth was capped at a flat
`CONCURRENCY_CAP` (50) to keep deep-`weakenTime` targets shallow and self-healing —
a drift bandaid. Once the self-pacing scheduler fixed drift at the root (rig-
validated clean at full natural depth, e.g. iron-gym at 248), the cap's original
purpose was gone; its only remaining job was an incidental lag valve (bounding
concurrent worker-script count). It was removed entirely and that role handed to
`MAX_BATCH_TARGETS` (lowered from 999 to a hand-tuned 10) instead — a single
explicit knob for lag, rather than an implicit side effect of a depth cap that no
longer needed to exist for correctness.

**A `CHANCE_BATCH`/`CHANCE_FILTER` hack-chance floor used to gate admission,
with an `idle` bucket for what it excluded.** Any prepped target below
`CHANCE_BATCH` (80% hack chance) was excluded from `eligible` into a separate
`idle` bucket, shown in the status table but never attacked; `CHANCE_FILTER`
(50%) was defined alongside it but never actually wired into any check. Both were
removed once it was clear the gate was redundant: `score` already accounts for
`chance`, so excluding a target outright (rather than just letting it rank low)
was hiding real profit, not preventing any actual risk. Removing the gate and
folding the `idle` bucket away took measured income from ~15 b/s to ~80 b/s on one
save.

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
- **Per-target marginal-$/s ramp instead of a global floor**: greedily spending
  idle RAM on whichever target yields the most extra `$/s` per GB is closer to
  theoretically optimal income, but it needs per-target state and is much harder to
  keep from flapping at the margin. The global floor trades a little allocation
  optimality for simplicity and rock-solid stability — the right call for an
  opportunistic idle-RAM absorber.

## Status bus (dashboard hook)

Each tick booster builds ONE snapshot (`buildSnapshot`) and feeds it to both views:
`renderTail` (shared `lib/tail-ui.js`) draws the tail window from it, then
`publishStatus(ns, STATUS_PORT_CONTROLLER, snap)` broadcasts the same object to the
status bus (see `docs/scripts/status.md`) for `dashboard.js`. The snapshot reuses
values already computed for the tick (`displayHealth`, `expectedIncome`, `poolFree`,
the `pipelines` map, `topRampF`/`rampSaturated`, `shareThreads`, `prepCount`) plus
`tickGap`/`lastWorkMs` for the engine-lag indicator — no new NS calls. The old
per-controller `renderStatus` was deleted when `lib/tail-ui.js` gave the tail full
information parity with the dashboard. (orbiter.js carries the identical hook.)
