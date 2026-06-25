# orbiter

**Location:** `src/orbiter.js`

## What it does

`orbiter` is the **mid-game hacking controller** — the second stage of the
controller lineage (**booster → orbiter → station**). It does the same job as
[booster](booster.md) — discover/root the network, run a rolling HWGW batcher
against the best targets, prep weak targets, orchestrate the manager scripts,
feed idle RAM to `ns.share()`, and render a status table — but its
targeting/thread-math core is rebuilt on the **Formulas API** (`ns.formulas.*`),
which booster cannot use.

It only runs once **Formulas.exe is owned** (it errors out and exits otherwise),
and loops `while (ns.fileExists(FORMULAS_EXE, "home"))` so the condition leaves a
clean seam for a future station/SF4 handoff. Measured footprint: **7.85 GB**
(`ORBITER_RAM_GB`) — slightly under booster's 8.35, because Formulas functions
cost 0 GB (only owning the program is required) even though `ns.getServer` adds
2 GB.

## How it works

orbiter is a **fork of booster**. Everything except the planning core is carried
over unchanged: `discoverAndRoot`/`tryRoot`/`provisionWorkers`, the RAM pool
(`buildPool`/`placeThreads`), manager orchestration
(`launchManagers`/`nextManagerReserve`), `sharePhase`, the self-pacing scheduler
shell (`batchPhase`/`fireBatch`), `selectBatchers` admission, the ramp
controller, and the status table. See [booster.md](booster.md) for those.

The Formulas core is what differs:

- **Prepped snapshot.** `preppedSnapshot(ns, host)` takes `ns.getServer(host)` and
  overrides `hackDifficulty = minDifficulty` and `moneyAvailable = moneyMax`. Every
  planning calculation runs against this *hypothetical baseline* server plus the
  live `ns.getPlayer()` (fetched once per tick), so the numbers are exact for the
  state a batch will actually act on — regardless of the server's current state.
- **`bestHackPct`** sweeps hack fractions `f` and, per `f`, computes:
  `h = ceil(f / formulas.hacking.hackPercent(snap, player))`; grow via
  `formulas.hacking.growThreads(postHackSnap, player, moneyMax)` on a snapshot whose
  money is set to `moneyMax*(1-f)`; op-times and `chance` from the matching
  `formulas.hacking.*` calls. It returns the best-scoring row ($/GB/s), carrying the
  plan's threads, op-times, and chance.
- **`lockedPlan`** caches each batcher's plan in `batchPlan`, stamped with the
  hacking `level` and `rampLevel` it was computed at, and only recomputes when one of
  those changes. Because the recompute is Formulas-exact, a level-up just re-balances
  `h`/`g` in place — no drift grace, no destructive re-prep.
- **`classify`** keeps booster's strict-to-admit / loose-windowed-to-keep hysteresis,
  but drops booster's pre-Formulas drift machinery (`unhealthySince`/`DRIFT_GRACE_MS`,
  the `effF` staleness trace). A target drifts out only if its windowed baseline
  leaves the keep-bounds, which should now be rare.
- **`prepWave`** sizes grow with `formulas.hacking.growThreads` on the live server
  instead of `growthAnalyze`.

## Why it's built this way

booster's whole complexity (prep-before-plan, plan-locking-to-fight-level-drift,
`THREAD_MARGIN` over-provisioning) exists because its NS getters are only accurate
at baseline. Formulas removes that constraint, so orbiter can plan the exact batch
shape directly and let a level-up re-derive it exactly. Two hard lessons shaped the
final design, both worth preserving:

1. **Schedule landings with LIVE op-times, never the prepped plan times.** The first
   cut scheduled the HWGW landings using the prepped (min-security) op-times, on the
   theory that orbiter holds everything at min security so they're equal. They are
   not, in a deep pipeline. An op lands at `base + (actualTime − scheduledTime)`;
   whenever the live server sits even slightly above min, the weaken (4× the hack's
   duration) is delayed ~4× more than its paired hack, so the counter-weaken falls
   behind, security creeps, the next batch runs slower, and the grid runs away — seen
   as money draining to the hack floor at `sec 0`, and as a runaway `moneyFrac=1.000
   secOver=+3.4` spike. `batchPhase` now derives **depth** from the stable plan
   weaken time (so the pipeline target doesn't wobble) but reads **live**
   `getWeakenTime/getGrowTime/getHackTime` for the landing math — exactly booster's
   proven scheduler. This is the single most important invariant in the file.

2. **A small grow/weaken margin is still needed; thread-count was a red herring.**
   The drift was misdiagnosed first as grow under-provisioning, and `THREAD_MARGIN`
   was removed entirely ("growThreads is exact") then re-added at 1.01→1.02 — none of
   which fixed it, which is what pointed at scheduling. orbiter keeps a *small*
   `ORBITER_THREAD_MARGIN` (1.01) on grow + counter-weakens as cheap insurance against
   per-cycle rounding/jitter compounding over a deep pipeline (the over-grow clamps
   harmlessly at max); hack threads stay exact.

3. **Plans are LOCKED for cost, not correctness.** Recomputing every server's full
   hack-% sweep every tick cost ~100ms/tick (`getServer` + ~75 `growThreads` calls ×
   ~60 servers), which itself added landing jitter. `lockedPlan` pins planning to
   admission + level/ramp changes, dropping per-tick work back toward booster's ~40ms.

## Alternatives considered

- **Extract shared infra into lib modules** instead of forking. Rejected for now: a
  fork is faster and keeps the proven booster untouched while orbiter stabilises. The
  duplication is the known cost.
- **Full simplification — recompute every tick, drop locking, drop margin, schedule
  with prepped times.** This was the original plan and it failed in-game: prepped-time
  scheduling caused the runaway drift, and the every-tick replan was the source of the
  ~100ms ticks. The shipped design keeps Formulas-exact *thread math* but reverts to
  booster's *scheduling discipline* (live times) and *plan locking*.
- **Predict op-times at the level expected when ops land** (rather than at fire time).
  Not pursued — live times at fire time are sufficient and match the validated booster
  scheduler.
