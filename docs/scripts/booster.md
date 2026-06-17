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

It also writes `/data/servers.json` (topology for managers) and refreshes a live
status table in the tail window each tick.

## How it works

The main loop (`main`) each tick:

1. `discoverAndRoot` — BFS from home, root what it can, copy workers onto newly
   rooted hosts once.
2. `buildPool` — one entry per rooted host with free RAM, largest-first; home
   keeps a safety buffer.
3. `classify` — splits viable servers into `eligible` (prepped + batch-worthy,
   each scored by $/GB/s via `bestHackPct`) and `needsPrep`. Uses hysteresis:
   **strict** bounds (on the raw read) to *start* batching, **loose** bounds to
   *keep* batching. The keep-test is judged on the **grid-aligned windowed
   baseline** (`displayHealth`'s peak money / floor security), not the raw
   instantaneous read — a healthy batch's money legitimately plunges to ~(1−hack%)
   each cycle, and its security legitimately spikes by the grow's full bump in the
   gap between the grow landing and its counter-weaken (at high hack-% that bump is
   large). Judging keep on those raw troughs/spikes would false-drop healthy
   targets. `chance` is dropped from the keep-test entirely: once a target is
   admitted, `chance` only degrades via security, which the floor-security bound
   already catches — and the raw `chance` read dips on the same mid-cycle spike.
   `needsPrep` is sorted **easiest-earner first** (ascending `maxMoney`).
4. `selectBatchers` — **admission control + depth-first allocation.** Walks the
   score-sorted `eligible` list in rank order and gives each target, greedily, the
   RAM it can use before moving to the next — filling the best target toward its
   full pipeline before a lower-ranked one starts. Per target, against the
   `remaining` budget: if a single *optimal* batch fits, use the locked optimal
   plan; otherwise step the hack-% **down** to the best batch that fits
   (`bestHackPct(..., remaining)`). It reserves `min(full pipeline, remaining)`, so
   a stepped-down target claims the whole remaining budget and the next target
   waits. Ceilings: `BATCH_BUDGET_FRAC` of the *total* pool and `MAX_BATCH_TARGETS`.
   Last tick's batchers (`wasBatching`) get first claim so the set doesn't flap.
   Returns `{ batchers, reserved }`.
5. `batchPhase` — fires rolling HWGW batches for the admitted set, in rank order,
   regulated by a per-target launch clock advancing by `BATCH_PERIOD`. The pipeline
   fills gradually (one launch per period) up to its concurrency, so a target's RAM
   use ramps over ~a weaken time. Calls `maybeRecover` to inject supplemental
   grow/weaken when a batching target drifts.
6. `prepPhase` — spends remaining RAM driving `needsPrep` targets to baseline, one
   corrective wave per target (`prepWave`), skipping any with workers already in
   flight; prepares at most `MAX_BATCH_TARGETS + PREP_LOOKAHEAD` servers at once.
   Stops at a `prepFloor` = the batchers' reserved-but-unclaimed RAM, and each
   `prepWave` is capped to that headroom — so prep can't starve a pipeline that is
   still ramping toward full depth.
7. **Hack-% ramp controller** — a global `rampLevel` (a hack-% *floor*, starts at
   0) absorbs idle pool RAM. After prep, the loop nudges `rampLevel` by at most one
   `RAMP_STEP` per tick, driven by actual **pool utilization** (`1 − free/total`,
   measured after this tick's batch + prep placements): **up** when every `eligible`
   target got a batch slot **and** utilization is below `RAMP_UTIL_LOW`; **down**
   when admission is RAM/lag-starved or utilization exceeds `RAMP_UTIL_HIGH`;
   otherwise it holds (the `LOW..HIGH` deadband). `classify` then plans each target
   at `max(score-optimal f, rampLevel)` capped at `HACK_PCT_RAMP_MAX`, so a raised
   floor pulls low-% targets up to spend the idle RAM. The plan lock stores the
   `rampLevel` it was computed at and recomputes only when the floor moves.
8. `updateDisplayStats` / `renderStatus` — refresh the tail-window status table.
   Raw money/security reads land at a random phase of each target's batch grid, so
   they oscillate (e.g. money flips between 100% and `100% − hack%`). For display
   only, `updateDisplayStats` keeps a short rolling window per batcher and
   `displayHealth` reports the window's **peak money / floor security** — the
   grid-aligned baseline (~100% / +0.00 when healthy), while a sustained drift still
   pulls the reported value off. This affects the tail table only, never batching
   decisions.

Thread placement (`placeThreads`) greedily bin-packs across the pool and returns
how many threads actually landed.

## Why it's built this way

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

**The hack-% ramp spends idle RAM without flapping.** `bestHackPct` picks the `f`
that maximizes `$/GB/s` — RAM *efficiency* — which is correct only while RAM is the
bottleneck. After hours on a fresh save, every available target batches at that
efficiency peak yet the pool still sits on huge free RAM (idle GB earn nothing). The
fix raises hack-% *above* the per-target peak: more money per batch at worse
`$/GB/s`, which is a good trade when the GB are otherwise idle. A single sticky
`rampLevel` floor (not a per-target greedy allocator) keeps the model simple,
monotonic, and easy to reason about — raising it pulls the cheapest-to-grow targets
up first. Anti-flap comes from three things together: the move is **gated on actual pool
utilization** (so it never steals RAM that prep or a new target is using and yields
the instant utilization climbs), it steps by a small `RAMP_STEP` at most once per
tick, and the wide `RAMP_UTIL_LOW..HIGH` deadband holds it steady through the normal
mid-cycle money/security oscillation. The plan lock keys on `rampLevel` so plans
only recompute on a genuine floor move, preserving the no-flap admission guarantee.

The signal is **pool utilization, not "prep is empty."** An earlier version gated
ramp-up on `needsPrep` being empty, but a large rooted network almost always has a
trickle of one server prepping, so the ramp never fired while 98% of the pool sat
idle. Measuring real utilization (which already counts prep's RAM) fixes that: a
one-server prep trickle barely moves utilization, so the ramp proceeds — yet a
fresh-save bootstrap, where prep is consuming the whole small pool, reads as
fully-used and correctly suppresses the ramp.

**`HACK_PCT_RAMP_MAX` doubles as the share-residual boundary.** Capping the ramp
(and thus every target's hack-%) at a fixed maximum means that once `rampLevel`
reaches it and `needsPrep` is empty, every target is hacking as hard as we allow, so
the free RAM still left over — `poolFree − poolTotal × (1 − BATCH_BUDGET_FRAC)` — is
genuine, well-defined surplus. A future `sharePhase` can claim exactly that residual
for `ns.share()` workers, recomputed each tick so a ramp-down or new demand reclaims
it instantly. Only the boundary is defined for now; `sharePhase` is not yet built.

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
concurrent worker scripts — governed by `MAX_BATCH_TARGETS` (default high =
effectively off until tuned down). The two never conflict: prep ordering decides
what gets *ready* (velocity, easiest-first), the cap decides what *runs* among the
ready set (value, best-score-first). They bind in different regimes, so the cap
never undermines the bootstrap fix. `PREP_LOOKAHEAD` keeps prep breadth aligned
with the cap so prep doesn't sprawl onto servers that won't earn a slot. Tradeoff:
with the cap active, a freed slot can briefly go to an easy modest server before a
big earner finishes prepping — this self-corrects as `selectBatchers` retains the
highest-score targets and drops weaker ones (hysteresis permitting).

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

**Recovery is rate-limited per target.** `maybeRecover` (the safety net that
re-grows a target that has slipped below `RECOVER_MONEY_FRAC`) fires at most one
wave per `growTime` via `recoverClock`. Without this gate it re-fired a full
deficit-sized grow every tick for any persistently-drifted target; those grows
live for the full grow time, so they stacked up, drained the pool, and starved the
normal batches — which pushed more targets below threshold, a runaway that bled the
pool from tens of TB to tens of GB. The cooldown lets one corrective wave land and
be measured before the next fires. Like the keep-test, recovery is **gated and
sized on the windowed baseline** (peak money / floor security), not the raw read —
otherwise a healthy high-hack-% target, whose raw money sits below
`RECOVER_MONEY_FRAC` almost every tick, would fire off-grid grows continuously,
themselves raising security and desyncing the pipeline.

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
