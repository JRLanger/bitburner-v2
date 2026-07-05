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
clean seam for a future station/SF4 handoff. Measured footprint: **8.35 GB**
(`ORBITER_RAM_GB`) — under booster's 8.85, because Formulas functions cost 0 GB
(only owning the program is required) even though `ns.getServer` adds 2 GB and
`ns.getPlayer` 0.5 GB. Caution from a real incident: the RAM analyzer
phantom-charges any **property** named after an NS function — `ramAttribution`'s
debug bucket was briefly named `share` (`att.share`) and inflated the footprint to
10.75 GB (+2.40 for `ns.share` never called); it is now `shareUse`.

## How it works

orbiter is a **fork of booster**. Everything except the planning core is carried
over unchanged: `discoverAndRoot`/`tryRoot`/`provisionWorkers`, the RAM pool
(`buildPool`/`placeThreads`), manager orchestration
(`launchManagers`/`nextManagerReserve`), `sharePhase`, the self-pacing scheduler
shell (`batchPhase`/`fireBatch`), `selectBatchers` admission + the per-target
waterfall ramp, and the status table. See [booster.md](booster.md) for those.

The Formulas core is what differs:

- **Prepped snapshot.** `preppedSnapshot(ns, host)` takes `ns.getServer(host)` and
  overrides `hackDifficulty = minDifficulty` and `moneyAvailable = moneyMax`. Every
  planning calculation runs against this *hypothetical baseline* server plus the
  live `ns.getPlayer()` (fetched once per tick), so the numbers are exact for the
  state a batch will actually act on — regardless of the server's current state.
- **`buildPlanner` / `bestHackPct` / `maximizeHackPct`.** `buildPlanner` resolves the
  f-independent baseline once (`hackPercent`, op-times, `chance`, `moneyMax` from the
  prepped snapshot + live player) and returns `atF(f)`, which costs one HWGW batch at
  fraction `f`: `h = ceil(f / hackPercent)`; grow via `growThreads` on a snapshot whose
  money is `moneyMax*(1-f)`; counter-weakens scaled by `ORBITER_THREAD_MARGIN`.
  `bestHackPct` sweeps `atF` upward and returns the best-scoring ($/GB/s) row (the base
  plan); `maximizeHackPct` sweeps it **downward** from `HACK_PCT_RAMP_MAX` and returns
  the highest `f` that fits a RAM cap (the waterfall's up-ramp). Both carry the plan's
  threads, op-times, and chance, so `batchPhase` needs no further NS calls.
- **`lockedPlan`** caches each batcher's **base** plan in `batchPlan`, stamped with the
  hacking `level`, and only recomputes when the level changes (dropping the sticky
  `rampPlan` so the waterfall re-ramps from the fresh base). Because the recompute is
  Formulas-exact, a level-up just re-balances `h`/`g` in place — no drift grace, no
  destructive re-prep.
- **`classify`** keeps booster's strict-to-admit / loose-windowed-to-keep hysteresis,
  the `unhealthySince`/`DRIFT_GRACE_MS` drift grace (raised to **10 s**) and the
  `BATCH_DROP_MIN_FILL` ramping guard — with booster's stage-10 exemption: an
  **empty** pipeline is *not* protected (protecting it deadlocked hot+drained targets
  at `fill=0/N` forever; see booster.md "Empty-pipeline deadlock"). The other
  stage-10 stability gates are mirrored too: the REANCHOR persistence gate
  (`REANCHOR_STABLE_TICKS`) and the Pass-B ramp-down damping
  (`RAMP_DOWN_STABLE_TICKS` + `ramp-hold`/`OVERBUDGET` debug lines); orbiter never
  had booster's live-chance rank flap, since its plans already carry the
  prepped-snapshot `fm.hackChance`. And — like booster — it **kills a dropped
  target's in-flight workers** (`killWorkersFor`) so re-prep starts clean instead of
  stacking stale workers onto the re-admitted pipeline. A target drifts out only if its windowed
  baseline stays outside the keep-bounds past the grace. A **null plan** from
  `lockedPlan` (hackPercent 0 — rare) is treated exactly like a drift-out and runs the
  same drop cleanup; before this it fell through to the not-batching path with the
  target still in `activeBatching` and a live pipeline of zombie workers no one killed.
- **`prepWave`** fires booster's combined overlapped wave (W1 → G → W2 via
  `additionalMsec`, one weakenTime per prep — see booster.md) but sizes the grow
  **Formulas-exact for where it lands**: `formulas.hacking.growThreads` against the
  live snapshot with `hackDifficulty` forced to `minDifficulty` when this wave's
  weaken flies ahead of the grow.

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
   `ORBITER_THREAD_MARGIN` (**1.025**, raised from 1.01 after deep, high-level servers
   were seen to slowly ratchet money 100%→~40% over a fill — the 1% cushion couldn't
   absorb per-cycle rounding + level-up creep on the in-flight backlog) on grow +
   counter-weakens; the over-grow clamps harmlessly at max, hack threads stay exact.

3. **Plans are LOCKED for cost, not correctness.** Recomputing every server's full
   hack-% sweep every tick cost ~100ms/tick (`getServer` + ~75 `growThreads` calls ×
   ~60 servers), which itself added landing jitter. `lockedPlan` pins base planning to
   admission + level changes, and the waterfall's `rampPlan` is likewise sticky (an
   incumbent reuses its ramped `f` rather than re-sweeping `maximizeHackPct` each tick),
   dropping per-tick work back toward booster's ~40ms.

4. **In-flight workers must match the plan, or `reserved` lies and the pool
   oversubscribes.** This was the real root of the long "RAM spirals to 100% when big
   servers flood in and force others to ramp down" failure. orbiter carries the full
   shared fix (see booster.md, "In-flight workers must match the current plan"):
   **kill-on-drop** (`killWorkersFor` when `classify` drops a target), an **instant-drain
   re-anchor** in `batchPhase` when f drops past `REANCHOR_DROP_FRAC` (kill all workers,
   refill at the new f so actual RAM matches `reserved` immediately), **`RAMP_HYSTERESIS_FRAC`**
   to keep f piecewise-constant so re-anchors stay rare, and the hard **`REFILL_HEADROOM_FRAC`**
   floor on prep/share. The deep-pipeline weakness here is the long weaken time: a stale
   generation drains for ~8 minutes, so leaving workers un-killed stacked 3–4 generations
   and 2–3×'d the RAM before the fix.

5. **Security-phase fire deferral + landing telemetry (stage 9, shared with
   booster).** An op's duration is fixed when the WORKER calls it (~1 engine tick
   after the controller's exec), but landing delays are computed from op-times read
   at exec; security changing in that gap (the grid's ~100 ms post-grow hot window)
   desyncs landings by seconds and self-sustains as a limit cycle. `batchPhase`
   therefore never fires while the target reads above `minSecurity × (1 +
   SEC_MARGIN)` — it defers to the next tick (`FIRE-HOT` debug line); the landing
   clock keeps advancing, so no slot is lost. The keep-bound also gained the
   `BATCH_KEEP_SEC_ABS` absolute floor, and orbiter carries the same
   worker-landing telemetry (`TELEMETRY_*` / `drainTelemetry` / `teleSummary`;
   dormant while `CONTROLLER_DEBUG` is false, the post-stage-9 default) —
   see booster.md, "The security limit cycle and its four coupled fixes", for the
   full diagnosis. One difference: orbiter needs **no baseline mint gate** —
   `buildPlanner` computes everything against the prepped snapshot, so a plan
   minted during a hot window is identical to one minted cold (the booster-only
   skew simply cannot happen here).

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

## Status bus (dashboard hook)

Each tick orbiter builds ONE snapshot (`buildSnapshot`) and feeds it to both views:
`renderTail` (shared `lib/tail-ui.js`) draws the tail window from it, then
`publishStatus(ns, STATUS_PORT_CONTROLLER, snap)` broadcasts the same object to the
status bus (see `docs/scripts/status.md`) for `dashboard.js`. The snapshot reuses
values already computed for the tick — no new NS calls. The old per-controller
`renderStatus` was deleted when `lib/tail-ui.js` gave the tail full information
parity with the dashboard; the dashboard overlay itself is only auto-opened when
home has ≥ `DASHBOARD_MIN_HOME_RAM_GB` (256 GB), with `ns.ui.openTail()` as the
small-home fallback. (booster.js carries the identical hook.)
