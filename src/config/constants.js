/**
 * config/constants.js — shared tunables and constants for the booster system.
 *
 * PURE CONSTANTS ONLY. This file must never call an NS function: a module with
 * zero NS calls adds 0 GB when imported, so every script can import it freely.
 * Adding an NS call here would tax the RAM of everything that imports it.
 *
 * Values validated in-game (see docs/devlog/02-booster.md) are marked.
 */

// ── HWGW batch timing ──────────────────────────────────────────────────────

/** Gap between consecutive HWGW landings, ms. Tune in-game later.
 *  Drives BATCH_PERIOD (= 4 × this), so it also sets batch throughput: smaller
 *  D_GAP → shorter period → more batches/sec → more income on RAM-rich pools. The
 *  engine enforces landing times via additionalMsec, so 100ms is ample spacing as
 *  long as the op times used to schedule are current (see batchPhase). */
export const D_GAP = 100;

/** Interval between batch launches into the pipeline, ms. One batch per period. */
export const BATCH_PERIOD = 4 * D_GAP;

/** Main loop sleep, ms. Wake often enough to never miss a grid launch window.
 *  Deliberately NOT an exact divisor of BATCH_PERIOD: at exactly BATCH_PERIOD/2 the
 *  tick phase-locks to two fixed points of the landing grid (observed as gap=205ms
 *  every tick), so fires and health samples always hit the same grid phases — if one
 *  of them is the 100ms post-grow "hot" security window, every fire/sample is bad,
 *  a deterministic resonance. The +30 makes the phase rotate through the whole grid. */
export const LOOP_SLEEP = BATCH_PERIOD / 2 + 30;

/** Launch lead, ms: a batch's grid slot is fired this far before its launch lead
 *  (slot − weakenTime), so on the absolute landing grid its per-op delays stay ≥ 0
 *  and it lands exactly on slot. Must EXCEED LOOP_SLEEP (and a little extra for the
 *  occasional wait for a min-security window), else a coarse loop can fire a slot
 *  late and clamp its delays. Bigger only deepens the pipeline by a batch or two
 *  (cheap — RAM is abundant). */
export const BATCH_SAFETY_MS = 300;

// ── Security deltas (single-core, validated exact in-game) ─────────────────

/** Security removed per weaken thread. */
export const WEAKEN_SEC = 0.05;
/** Security added per grow thread. */
export const GROW_SEC = 0.004;
/** Security added per hack thread. */
export const HACK_SEC = 0.002;

// ── Target selection & prep thresholds ─────────────────────────────────────
//
// No hack-chance floor: chance is already a multiplier in bestHackPct's score
// (moneyPerBatch = maxMoney × f × chance), so a low-chance target is correctly
// scored low rather than excluded — it only wins a batch slot if nothing
// higher-scoring is competing for the RAM.

/** "Prepped"/healthy if security ≤ minSecurity × (1 + this). */
export const SEC_MARGIN = 0.05;
/** "Prepped"/healthy if money ≥ maxMoney × (1 − this). */
export const MONEY_EPSILON = 0.01;

// Hysteresis: strict to START batching (above), looser to KEEP batching — but
// the within-cycle oscillation is already filtered out upstream by the windowed
// peak/floor in displayHealth (classify reads peak money / floor security across
// the recent window, not the raw instantaneous value), so these bounds only need
// to tolerate genuine, sustained drift, not normal HWGW cycling. ~10% drift on
// either axis is real drift (e.g. caused by a hacking-level-up shifting hack%/
// thread counts mid-pipeline) and worth a re-prep.
/** Keep batching while money ≥ maxMoney × this. */
export const BATCH_KEEP_MONEY_FRAC = 0.9;
/** Keep batching while security ≤ minSecurity × (1 + this) — relative, so it
 *  scales with the target instead of one flat number being too loose on a
 *  low-minSecurity server and too tight on a high one. */
export const BATCH_KEEP_SEC_FRAC = 0.10;
/** ABSOLUTE floor for the security keep-bound: keep while
 *  secOver ≤ max(minSecurity × BATCH_KEEP_SEC_FRAC, this). Purely relative bounds
 *  are hair-triggers on low-minSecurity servers (min=3 → only +0.30 tolerated),
 *  which is where the drift-drops clustered (foodnstuff/sigma-cosmetics). 1.0 of
 *  security ≈ one large batch's grow bump — tolerates a real transient without
 *  letting sustained drift through. */
export const BATCH_KEEP_SEC_ABS = 1.0;

// Drift grace. A batch fired during a transient security bump (caused by a
// high-grow target's own in-flight grows) lands a little late and briefly
// desyncs money/security; the grid then self-heals within a few seconds. Dropping
// a target on such a blip forces a destructive re-prep, so only re-prep a target
// once it has been UNHEALTHY (outside the keep-bounds above) continuously for this
// long. Must comfortably exceed one display window plus a couple of batch cycles
// so a self-healing transient is ridden out, while a genuine sustained collapse is
// still caught. Tune in-game.
/** Re-prep a drifted batcher only after it stays unhealthy this long, ms. */
export const DRIFT_GRACE_MS = 10000;

// A pipeline still FILLING toward its depth (a cold start, or a target RAM-starved
// while many newly-eligible servers flood in at once — e.g. just after bulk-buying
// the port openers + Formulas.exe) has not reached the steady state the keep-test
// above judges. Its low windowed money is the ramp, not genuine drift. Dropping it
// to re-prep then destroys the partial pipeline while its already-exec'd HWGW
// workers keep running for a full weaken time — untracked RAM-squatting "zombies"
// that starve every other pipeline's refill, driving more targets unhealthy and
// dropping them too: a self-sustaining churn the scheduler cannot climb out of (a
// cold start, which never drops, fills cleanly — proving the steady-state design is
// sound). So the keep-test only governs a target whose pipeline is at least this
// fraction of depth; below it the target is protected from the drop and left to
// fill. Inert in steady state (full pipelines sit at ~100% fill), so throughput is
// unchanged.
/** Only re-prep a drifted batcher once its pipeline has filled to ≥ this × depth. */
export const BATCH_DROP_MIN_FILL = 0.9;

// ── Batcher admission control ──────────────────────────────────────────────

// Each batching target sustains a full pipeline of ceil(weakenTime/BATCH_PERIOD)
// concurrent batches. The sum across all prepped targets can far exceed the pool,
// which drains RAM to zero — starving prep and desyncing batches (partial fires →
// money/security drift). To prevent overcommit, batchers are admitted in rank
// order only while their cumulative pipeline RAM stays under this fraction of the
// TOTAL pool. The remainder is real headroom for prep, recovery, and jitter.
/** Fraction of total pool RAM usable for batch pipelines. Tune in-game. */
export const BATCH_BUDGET_FRAC = 0.90;

// Hard, untouchable free-RAM floor that BOTH prep and share must always leave
// free, so batchPhase can always fit its per-tick refills and pipelines never
// decay. BATCH_BUDGET_FRAC caps the batchers' *reservation* but does NOT guarantee
// free RAM at the instant a refill needs it: as deep pipelines fill, prepFloor
// (= reserved − batchRunningRam) shrinks toward 0 and prep is then free to drive
// poolFree to ~0, so batchPhase can't fit even one batch (ramPerBatch > poolFree →
// defer) → pipelines decay → money drifts → keep-test churn → 100%-RAM spiral
// (observed after a flood of newly-rooted servers floods the prep queue at once).
// This makes the 20% that BATCH_BUDGET_FRAC already conceptually reserves LITERAL
// and untouchable — the same condition a cold restart (no pending prep) satisfies.
// Keep equal to (1 − BATCH_BUDGET_FRAC); raise both in tandem only if testing shows
// refills still defer under flood. Tune in-game.
/** Fraction of total pool RAM kept free as a hard refill floor. Tune in-game. */
export const REFILL_HEADROOM_FRAC = 1 - BATCH_BUDGET_FRAC; // 0.10

// A starved target's launch clock can fall a full pipeline behind; without a cap
// it dumps the entire backlog (hundreds of batches) in one tick, spiking RAM and
// re-starving the pool. Steady state only needs ~1 launch per couple of ticks, so
// a small cap fills/heals a pipeline gradually without spikes.
/** Max HWGW batches a single target may launch in one tick. */
export const MAX_FIRES_PER_TICK = 2;

// Primary lag governor: hard ceiling on how many targets batch at once, on top of
// the RAM budget. The self-pacing scheduler runs each target at its full natural
// depth (ceil(weakenTime/BATCH_PERIOD)), so a deep target can hold hundreds of
// in-flight batches = hundreds × 4 concurrent worker scripts; Bitburner slows with
// too many live scripts. This cap bounds the total by limiting the *number* of
// batched targets (selectBatchers keeps the highest-score ones). Temporary low value
// for tuning — raise it until the game starts to lag, then back off.
/** Max number of simultaneously batched targets. */
export const MAX_BATCH_TARGETS = 10;

// Admission hysteresis. selectBatchers admits targets in score order, but gives a
// currently-batching incumbent this fractional score bonus when ordering — so a
// *marginally* higher-scoring newcomer can't evict a running pipeline (which would
// waste a weaken time of in-flight workers), while a *clearly* higher one (score >
// incumbent × (1 + this)) still can. Without it, an old two-pass "all incumbents
// first" rule let low-value squatters (e.g. n00dles, admitted early when few targets
// were ready) hold a capped slot forever and lock out higher-value servers, so the
// admitted set could never improve toward the true top-MAX_BATCH_TARGETS by score.
/** Incumbent score bonus for admission ordering (anti-flap, anti-squat). */
export const SELECT_KEEP_BIAS = 0.05;

// When the target cap is active, prep no more than (cap + this) servers at once,
// so prep effort doesn't sprawl onto servers that won't earn a batch slot soon.
// Inert when MAX_BATCH_TARGETS is effectively unlimited (early game).
/** Extra servers beyond the batch cap to keep prepping as a lookahead buffer. */
export const PREP_LOOKAHEAD = 2;

// Over-provision grow and weaken threads by this factor. Each batch then grows
// slightly past max (clamps, harmless) and weakens slightly past min, which
// absorbs the small per-cycle under-restore that otherwise lets long-pipeline
// targets slowly drift down. Hack threads are NOT scaled. Tune in-game.
/** Multiplier applied to all grow/weaken thread counts (booster). */
export const THREAD_MARGIN = 1.10;

// orbiter sizes grow with Formulas-exact growThreads, so its only job is to break
// the deep-pipeline under-restore RATCHET (a grow lands on the money the previous
// grow left; any sub-thread shortfall compounds down to the hack floor). Because
// the over-grow clamps harmlessly at max, the margin only needs to EXCEED per-cycle
// timing jitter + integer rounding — it does not compound — so a much smaller cushion
// than booster's pre-Formulas 1.10 suffices. Tune in-game: raise if big servers still
// ratchet down, lower toward 1.0 while they hold at ~100%.
/** Multiplier applied to orbiter's grow/weaken thread counts (Formulas-exact base). */
export const ORBITER_THREAD_MARGIN = 1.025;

// ── Hack-percentage table ──────────────────────────────────────────────────

/** Resolution of the per-target hack-% table. */
export const HACK_PCT_STEP = 0.01;
/** Inclusive range of hack fractions to evaluate. */
export const HACK_PCT_MIN = 0.01;
export const HACK_PCT_MAX = 0.99;

// ── Hack-% ramp-up (idle-RAM absorber) ─────────────────────────────────────
//
// bestHackPct picks the f that maximises $/GB/s — the right objective when RAM
// is scarce. Once every available target is batching at that efficiency peak and
// the pool still sits on lots of idle RAM, efficiency stops mattering and
// absolute income does: we can spend the idle RAM by pushing hack-% ABOVE the
// per-target peak (more money per batch at worse $/GB/s — fine, the GB are idle).
//
// selectBatchers does this per-target with a WATERFALL (no global floor): it packs
// every admitted target at its score-optimal f, then spends the leftover budget by
// ramping the SINGLE most lucrative target up to HACK_PCT_RAMP_MAX first, spilling
// any remainder down the ranked list to the 2nd-best, and so on. This beats a flat
// global floor under RAM pressure — a flat floor grows weak targets too (little
// extra money) and shoves the marginal target past the budget, dropping it. The
// ramped f is sticky (locked like the base plan, only raised on re-anchor), so a
// running pipeline's RAM footprint never jitters tick-to-tick.

/** Max effective hack-% the per-target waterfall may reach. Also the share-residual
 *  boundary: once every admitted target sits at this cap and prep is clear, the
 *  leftover budget is genuine surplus and becomes shareable. Tune in-game. */
export const HACK_PCT_RAMP_MAX = 0.75;

// ── f-stability: hysteresis + instant-drain re-anchor ──────────────────────
//
// A batcher's hack-% f sets its per-batch RAM, but the pipeline holds ~a weaken
// time of in-flight workers all launched at WHATEVER f was current when each fired.
// So if f wobbles (selectBatchers re-sizing marginal targets against fluctuating
// leftover budget every tick), a pipeline whose plan now says "f=6%" is physically
// full of old f=60% workers — real RAM 10× the plan, `reserved` undercounts, the pool
// oversubscribes, and the batcher spiral returns. Two coupled guards fix it:
//
//   RAMP_HYSTERESIS_FRAC — an incumbent keeps its locked plan while its cost stays
//   within ±this band of its allocated capacity; f is only re-planned when capacity
//   moves OUTSIDE the band. This makes f piecewise-constant (no tick-to-tick wobble)
//   instead of churning, so re-anchors (below) are rare and deliberate.
//
//   REANCHOR_DROP_FRAC — when f genuinely drops by more than this (relative), the
//   pipeline is INSTANT-DRAINED: all its in-flight workers are killed and it refills
//   from empty at the new (smaller) f, so actual RAM snaps down to match `reserved`
//   immediately instead of staying bloated for a weaken time. (f-UP needs no kill —
//   old small + new big drains safely and `reserved` over-counts.) Set ≥ the
//   hysteresis band so we never re-anchor on noise. Both tunable in-game.
/** Deadband (fraction of capacity) before an incumbent's locked f is re-planned. */
export const RAMP_HYSTERESIS_FRAC = 0.15;
/** Minimum relative f drop that triggers a kill-all + refill re-anchor. */
export const REANCHOR_DROP_FRAC = 0.15;

// A re-anchor is a massacre (it kills the target's ENTIRE in-flight pipeline), so
// it must only answer a REAL sustained ramp-down, never planner noise. Observed
// pathology: the admission waterfall's leftover budget whipsaws tick-to-tick (an
// upstream deep target's locked plan is kept on its hot ticks and re-minted on its
// cold ones, so `reserved` oscillates), making the last-ranked targets' f flip
// between two values every other tick — and the instant re-anchor then killed
// 13-23k threads every ~20 ticks, forever (alpha-ent/zb-def flap). A genuine
// ramp-down persists indefinitely; the flap reverses within a tick or two. So the
// f-drop must hold for this many CONSECUTIVE ticks before the kill fires.
/** Consecutive ticks an f-drop must persist before the re-anchor kill fires. */
export const REANCHOR_STABLE_TICKS = 20;

// Same flap, one level up: the Pass-B waterfall re-mints an incumbent's ramped
// plan DOWN the instant its allocated capacity falls below the hysteresis band —
// but when the capacity itself whipsaws tick-to-tick (upstream locked plans kept
// on hot ticks, re-minted on cold ones), that instant down-mint is what feeds the
// f-flip the re-anchor gate above has to absorb. A genuine capacity loss (fleet
// shrank, better target admitted) persists; the flap reverses within a tick or
// two. So a down-mint only fires after the capacity deficit holds this many
// CONSECUTIVE ticks; until then the locked plan is kept at its real cost (the
// transient `reserved` overshoot is bounded and preferable to plan churn).
// Up-mints stay immediate — they kill nothing.
/** Consecutive ticks a capacity deficit must persist before a ramp-down re-mint. */
export const RAMP_DOWN_STABLE_TICKS = 20;

// ── Worker scripts ─────────────────────────────────────────────────────────

export const HACK_WORKER = "/workers/hack.js";
export const GROW_WORKER = "/workers/grow.js";
export const WEAKEN_WORKER = "/workers/weaken.js";

/**
 * Worker RAM costs, GB (validated). Hardcoded to avoid a getScriptRam call.
 *
 * NOTE: keys are intentionally NOT named hack/grow/weaken. Bitburner's RAM
 * analyzer charges for any property access matching an NS function name, so a
 * `.hack` key would phantom-charge 0.1 GB even though we never call ns.hack.
 */
export const WORKER_RAM = {
    hackRam: 1.70,
    growRam: 1.75,
    weakenRam: 1.75,
};

// ── RAM share (idle-RAM → faction reputation) ──────────────────────────────
//
// Once booster has ramped every target to HACK_PCT_RAMP_MAX and prep is clear,
// the pool still sits on idle RAM. sharePhase feeds the genuine surplus to
// ns.share() (a faction-rep boost while doing faction work). The surplus is the
// share residual already defined in booster's main loop:
//   residual = poolFree - poolTotal * (1 - BATCH_BUDGET_FRAC)
// sharePhase spends only SHARE_BUDGET_FRAC of that, using single-shot 10s workers
// re-topped-up each tick — so when batch/prep demand returns booster launches
// fewer and the running workers free their RAM within ~10s (no kill). NOTE:
// ns.share() only boosts rep WHILE you are doing faction work; otherwise the
// cycles are wasted (but never harm the batcher). Pause it manually with
// /utils/share-off.js (writes SHARE_OFF_FLAG).

export const SHARE_WORKER = "/workers/share.js";

/** share.js total RAM, GB (1.60 base + 2.40 share). Measure with `mem`. */
export const SHARE_RAM = 4.0;

/** Fraction of the share residual sharePhase will consume. <1 leaves a cushion
 *  against the ≤10s worker-expiry lag; ns.share's sharply-diminishing per-thread
 *  returns make this nearly as good as 1.0 anyway. Tune in-game. */
export const SHARE_BUDGET_FRAC = 0.75;

/** Flag-port key (see lib/flags.js): when truthy, sharing is manually paused.
 *  booster reads it each tick; /utils/share-off.js and share-on.js toggle it. Lives in
 *  the flag port (not a file), so a manual pause clears on aug/soft reset and game reload
 *  — sharing resumes automatically on a fresh run. */
export const SHARE_OFF_FLAG = "shareOff";

// ── RAM reservation ────────────────────────────────────────────────────────

// Measured script footprints (for reference — the pool reads live used RAM, so
// these are not imported anywhere): booster 8.85 GB, orbiter 8.35 GB,
// dashboard 1.6 GB. Re-measure with `mem <file>` after changes, and keep
// variable/property names off NS-function names (e.g. `share`) or the RAM
// analyzer phantom-charges them (+2.40 GB incident — see orbiter devlog).

/** Extra home RAM left free as a safety buffer, GB. */
export const HOME_SAFETY_BUFFER_GB = 2;

// ── Managers / orchestration ───────────────────────────────────────────────

/** Hostname prefix the pserver manager uses; booster counts these for gates. */
export const PSERVER_PREFIX = "pserv-";

/** Hacknet launch gate: pserver fleet fully built before hacknet starts. */
export const HACKNET_GATE = {
    serverCount: 25,
    ramEachGB: 32 * 1024, // 32 TB
};

/** Manager script paths. booster execs these on home in dependency order. */
export const CONTRACTS_MANAGER = "/managers/contracts.js";
export const PSERVER_MANAGER = "/managers/pserver.js";
export const HACKNET_MANAGER = "/managers/hacknet.js";

/**
 * Manager RAM footprints, GB. Hardcoded so booster can
 * reserve home headroom for the next pending manager WITHOUT a getScriptRam call.
 * Measure each with `mem <file>` after any change and update here.
 */
export const CONTRACTS_MANAGER_RAM = 16.80; // measured in-game (mem managers/contracts.js): 1.6 base + 0.2 ls + 15 getContract
export const PSERVER_MANAGER_RAM = 5.85; // measured in-game (mem managers/pserver.js)
export const HACKNET_MANAGER_RAM = 8.20; // measured in-game (mem managers/hacknet.js)

/** Loop sleep for the (infrequent-purchase) managers, ms. */
export const MANAGER_LOOP_SLEEP = 10000;

/** Max purchases a buyer/upgrader manager makes in one tick. Each tick now drains all
 *  affordable steps (not just one), so hacknet's hundreds of tiny upgrades complete in
 *  seconds instead of one-per-10s. The cap bounds a single tick for UI responsiveness. */
export const MANAGER_MAX_BUYS_PER_TICK = 100;

// ── pserver spending: payback OR reinvestment-fraction ─────────────────────
//
// The PSERVER manager buys the cheapest next step (gated by plain affordability) when
// EITHER arm passes:
//
//  1. PAYBACK arm — it pays back within PAYBACK_SECONDS of current income ($/s).
//     This lets large purchases through once income justifies them, and makes
//     upgrades halt automatically in BNs where servers get expensive.
//
//  2. REINVEST arm — its cost ≤ effFrac of current cash. Income-independent, so it
//     bootstraps the fleet on a fresh save (when income is ~0 *because* RAM is the
//     bottleneck — the payback arm can't fire yet). effFrac is NOT constant: it
//     DECAYS from PSERVER_REINVEST_FRAC (full bootstrap help) down to
//     PSERVER_REINVEST_FLOOR as fleet RAM grows toward PSERVER_BOOTSTRAP_RAM_GB. This
//     stops the reinvest arm from permanently overriding payback once bootstrap is
//     done — past the target, payback's "worth it?" gate governs upgrades, with the
//     small floor as a slow-trickle relief valve (a stalled fleet still creeps).
//
// (Hacknet no longer uses this model — it buys on ROI over the remaining-BN horizon,
// see "hacknet spending" below.)

/** Smallest pserver to buy when filling the fleet, GB (must be a power of two). */
export const PSERVER_START_RAM = 8;

/** Payback horizon: spend a step if it pays back within this many seconds. */
export const PSERVER_PAYBACK_SECONDS = 300;

/** Reinvest arm bootstrap-max fraction (used at zero infrastructure). */
export const PSERVER_REINVEST_FRAC = 0.25;

/** Reinvest arm floor — fraction it decays to once the bootstrap target is met. */
export const PSERVER_REINVEST_FLOOR = 0.01;

/** Infrastructure target at which the reinvest arm reaches its floor. */
export const PSERVER_BOOTSTRAP_RAM_GB = 25 * 32; // 800 GB (fleet of 25 at 32 GB)

// ── hacknet spending: ROI over the run (aug-reset) horizon ─────────────────
//
// The HACKNET manager buys a step only if it pays back within the expected length of
// the current RUN — the span between augmentation installs (lastAugReset), since an aug
// install wipes hacknet nodes and starts a fresh build-out: cost / marginalGain ≤
// horizonSeconds. The horizon is fixed for the run (it doesn't change mid-run):
// HACKNET_FRESH_BN_HORIZON_SECONDS when no run length has been recorded yet, otherwise
// the last recorded run duration (runs shorten as the BitNode cycle progresses). Run
// durations are derived from consecutive lastAugReset timestamps — exact even when the
// manager self-kills early. Marginal production gain per step comes from getNodeStats
// production ratios (no Formulas.exe). This replaces the payback+reinvest arms used by
// pserver — a hacknet node's marginal production is nonzero from the first node, so
// there is no income-is-zero chicken-and-egg to bootstrap around.

/** Fresh-run horizon when no run duration has been recorded yet, seconds. */
export const HACKNET_FRESH_BN_HORIZON_SECONDS = 8 * 3600; // 8 h

/** Floor on the run horizon so a freak very-short recorded run doesn't stall all
 *  hacknet spending, seconds. */
export const HACKNET_MIN_HORIZON_SECONDS = 300;

/** Hacknet-node production RAM growth base: production ∝ this^(ram−1). Validate in-game
 *  (predicted vs actual production across one RAM buy); only affects RAM-upgrade ROI. */
export const HACKNET_RAM_MULT_BASE = 1.035;

// ── Data files ─────────────────────────────────────────────────────────────

/** Topology JSON written by booster for managers to consume. */
export const SERVERS_JSON = "/data/servers.json";

/**
 * Netscript port holding the shared runtime flag object (see lib/flags.js). Ports
 * are wiped on game restart AND on aug/soft reset (verified in-game), so every flag
 * stored here is automatically per-run — no reset detection needed.
 */
export const FLAG_PORT = 1;

// ── Status bus (see lib/status.js) ─────────────────────────────────────────
//
// Each long-running script publishes a small JSON snapshot of its state to its own
// dedicated port at the end of every tick; dashboard.js peeks all of them and renders
// one unified overlay. Ports are free RAM and persist across ticks, and each snapshot
// carries a `ts` timestamp so the dashboard can flag a dead/stale publisher. Only one
// controller (booster OR orbiter) runs at a time, so they share one port.

/** Active HWGW controller (booster or orbiter) status snapshot. */
export const STATUS_PORT_CONTROLLER = 2;
/** contracts manager status snapshot. */
export const STATUS_PORT_CONTRACTS = 3;
/** pserver manager status snapshot. */
export const STATUS_PORT_PSERVER = 4;
/** hacknet manager status snapshot. */
export const STATUS_PORT_HACKNET = 5;

/** Recorded run (aug-reset) durations + last-seen aug-reset timestamp, for hacknet's
 *  ROI horizon. Survives aug installs (a soft reset keeps files); delete on a full
 *  BitNode reset to start the horizon history fresh. */
export const BN_DURATIONS_JSON = "/data/bn-durations.json";

// ── Worker landing telemetry (drift diagnosis) ─────────────────────────────
//
// The HWGW workers can report each op's ACTUAL landing back to the controller:
// [opTag, target, expectedLand, actualLand, opReturn, threads] written to
// TELEMETRY_PORT right after the op resolves (writePort is 0 GB; Date.now is
// plain JS). The controller drains the port every tick and aggregates per-target
// stats that separate the competing drift hypotheses:
//   - landing error (actual − expected): |err| > ~D_GAP/2 means the H→W1→G→W2
//     landing order is at risk → timing/engine cause;
//   - hack return (money stolen) below the plan's expected steal from a FULL
//     server → the server was NOT at max money when the hack landed → the
//     previous cycle under-restored → plan-balance cause (e.g. a plan minted at
//     slightly-elevated security oversizes h relative to g);
//   - hack return of 0 → failed hack (chance < 100%) — benign for money (a miss
//     steals nothing) but measured to rule it in/out.
// Only every TELEMETRY_SAMPLE-th batch is tagged for reporting so port volume
// stays far below the buffer between drains (a full port silently drops the
// oldest entry). Workers hardcode the port number: they are scp'd standalone to
// every rooted host, where an import of constants.js would not resolve.

/** Port the workers report landings on. HARDCODED in workers/*.js — keep in sync. */
export const TELEMETRY_PORT = 6;
/** Report every Nth batch's landings (1 = every batch; raise if the port floods). */
export const TELEMETRY_SAMPLE = 8;
/** Landing error (ms) beyond which a landing is logged as off-slot. Half of D_GAP
 *  is where the landing ORDER starts to be at risk. */
export const TELEMETRY_ERR_WARN_MS = 50;

// ── Diagnostics ────────────────────────────────────────────────────────────

/** When true, the active controller (booster OR orbiter) appends per-tick
 *  diagnostics to its own debug log — booster → BOOSTER_DEBUG_LOG, orbiter →
 *  ORBITER_DEBUG_LOG (separate files so the booster→orbiter handoff can't clobber
 *  or interleave the two). Write is free RAM, so this costs the controller nothing.
 *  Captures: per-tick admission summary; which targets drop and whether classify
 *  (drift keep-test) or selectBatchers (budget/cap) dropped them; hacking-LEVEL
 *  changes; per-target drift TRACE lines (raw + windowed money/security, locked f
 *  vs current effective hack fraction, and locked vs live weaken time — to pin
 *  drift on plan-staleness as the level rises); and batch DEFER lines (pipeline
 *  couldn't refill because the pool was full). Trace lines are gated to the
 *  windowed-drift case plus a sparse heartbeat, so a healthy fleet stays quiet. One
 *  shared flag: booster and orbiter run at different stages, so it only ever drives
 *  whichever is live. Default false since the stage-9 drift diagnosis closed; set
 *  true to re-arm the full logging + landing-telemetry toolkit. */
export const CONTROLLER_DEBUG = true; // re-armed: diagnosing stalled 0/N pipelines (stage 10)
export const BOOSTER_DEBUG_LOG = "/data/booster-debug.txt";
export const ORBITER_DEBUG_LOG = "/data/orbiter-debug.txt";

// The debug log grows ~1.4KB/s and was never truncated mid-run; a multi-hour run
// left a 45MB file. The sync tool pulls these files over the Remote API, and each
// pull makes the GAME JSON-serialize the whole file on its main thread — at tens
// of MB that freezes the UI (prime suspect for the recurring crashes; game stable
// with sync off). Rotation caps the cost: when the file would exceed this,
// flushDebug truncates and starts over (~25 min of history at debug rates — enough
// window to diagnose a stall).
/** Max debug-log size in bytes before flushDebug truncates and restarts the file. */
export const DEBUG_LOG_MAX_BYTES = 2_000_000;

// ── Detection / handoff ────────────────────────────────────────────────────

/** Presence of this file triggers handoff to the advanced controller. */
export const FORMULAS_EXE = "Formulas.exe";

/** orbiter.js — the Formulas-based mid-game controller (stage 2 of the lineage).
 *  booster execs this and exits once Formulas.exe is owned. */
export const ORBITER = "/orbiter.js";

// ── Dashboard ──────────────────────────────────────────────────────────────

/** Unified HTML/CSS overlay dashboard (reads the status-bus ports above). */
export const DASHBOARD = "/dashboard.js";
/** Only auto-open the dashboard once home has at least this much RAM, GB. Below it
 *  the controller opens its own tail window instead (ns.ui.openTail, 0 GB) — early
 *  home RAM is too scarce to spend on an overlay. */
export const DASHBOARD_MIN_HOME_RAM_GB = 256;
