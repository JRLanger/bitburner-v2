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

/** Main loop sleep, ms. Wake often enough to never miss a grid launch window. */
export const LOOP_SLEEP = BATCH_PERIOD / 2;

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

/** Min hackAnalyzeChance to even consider a target. */
export const CHANCE_FILTER = 0.5;
/** Min hackAnalyzeChance before a prepped target is batch-eligible. */
export const CHANCE_BATCH = 0.8;
/** "Prepped"/healthy if security ≤ minSecurity × (1 + this). */
export const SEC_MARGIN = 0.05;
/** "Prepped"/healthy if money ≥ maxMoney × (1 − this). */
export const MONEY_EPSILON = 0.01;

// Hysteresis: strict to START batching (above), loose to KEEP batching. A
// healthy batch's money/security oscillate each cycle, so only pull a target
// for re-prep if it has genuinely drifted past these looser bounds.
/** Keep batching while money ≥ maxMoney × this. */
export const BATCH_KEEP_MONEY_FRAC = 0.2;
/** Keep batching while security ≤ minSecurity + this (absolute). */
export const BATCH_KEEP_SEC_OVER = 5;

// Drift grace. A batch fired during a transient security bump (caused by a
// high-grow target's own in-flight grows) lands a little late and briefly
// desyncs money/security; the grid then self-heals within a few seconds. Dropping
// a target on such a blip forces a destructive re-prep, so only re-prep a target
// once it has been UNHEALTHY (outside the keep-bounds above) continuously for this
// long. Must comfortably exceed one display window plus a couple of batch cycles
// so a self-healing transient is ridden out, while a genuine sustained collapse is
// still caught. Tune in-game.
/** Re-prep a drifted batcher only after it stays unhealthy this long, ms. */
export const DRIFT_GRACE_MS = 4000;

// ── Batcher admission control ──────────────────────────────────────────────

// Each batching target sustains a full pipeline of ceil(weakenTime/BATCH_PERIOD)
// concurrent batches. The sum across all prepped targets can far exceed the pool,
// which drains RAM to zero — starving prep and desyncing batches (partial fires →
// money/security drift). To prevent overcommit, batchers are admitted in rank
// order only while their cumulative pipeline RAM stays under this fraction of the
// TOTAL pool. The remainder is real headroom for prep, recovery, and jitter.
/** Fraction of total pool RAM usable for batch pipelines. Tune in-game. */
export const BATCH_BUDGET_FRAC = 0.80;

// A starved target's launch clock can fall a full pipeline behind; without a cap
// it dumps the entire backlog (hundreds of batches) in one tick, spiking RAM and
// re-starving the pool. Steady state only needs ~1 launch per couple of ticks, so
// a small cap fills/heals a pipeline gradually without spikes.
/** Max HWGW batches a single target may launch in one tick. */
export const MAX_FIRES_PER_TICK = 2;

// Pipeline DEPTH cap. A target's natural depth is weakenTime/BATCH_PERIOD; on a
// long-weakenTime server (e.g. iron-gym wt≈99s → 248 batches at 400ms spacing) the
// pipeline is so deep it is almost never at min security, so the baseline fire gate
// rarely opens, the pipeline can't stay full, grow-security accumulates uncleared,
// and the target drifts into runaway security. Capping depth widens a deep target's
// inter-batch spacing to max(BATCH_PERIOD, weakenTime/CONCURRENCY_CAP) so it stays
// in the shallow, self-healing regime the design is validated in — at the cost of
// some throughput on long-wt targets (cheap: the pool has ample idle RAM).
/** Max concurrent in-flight HWGW batches per target. Tune in-game. */
export const CONCURRENCY_CAP = 50;

// Hard ceiling on how many targets batch at once, on top of the RAM budget. The
// RAM budget is the early-game (RAM-limited) constraint; this cap is the
// late-game (lag-limited) knob — Bitburner slows down with too many concurrent
// worker scripts, so dial this down if the game lags. selectBatchers keeps the
// highest-score targets up to the cap. Default high = effectively unlimited
// (RAM budget governs) so established saves are unaffected until tuned down.
/** Max number of simultaneously batched targets. */
export const MAX_BATCH_TARGETS = 999;

// When the target cap is active, prep no more than (cap + this) servers at once,
// so prep effort doesn't sprawl onto servers that won't earn a batch slot soon.
// Inert when MAX_BATCH_TARGETS is effectively unlimited (early game).
/** Extra servers beyond the batch cap to keep prepping as a lookahead buffer. */
export const PREP_LOOKAHEAD = 2;

// Over-provision grow and weaken threads by this factor. Each batch then grows
// slightly past max (clamps, harmless) and weakens slightly past min, which
// absorbs the small per-cycle under-restore that otherwise lets long-pipeline
// targets slowly drift down. Hack threads are NOT scaled. Tune in-game.
/** Multiplier applied to all grow/weaken thread counts. */
export const THREAD_MARGIN = 1.05;

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
// A single sticky global `rampLevel` acts as a hack-% FLOOR: each target plans at
// max(score-optimal f, rampLevel), capped at HACK_PCT_RAMP_MAX. The level moves at
// most one RAMP_STEP per tick, driven by actual POOL UTILIZATION (1 − free/total,
// which already counts prep usage): raise it while every batch-worthy target has a
// slot and the pool sits under RAMP_UTIL_LOW used; lower it once usage exceeds
// RAMP_UTIL_HIGH or admission is RAM/lag-starved. The wide LOW..HIGH deadband keeps
// routine mid-cycle oscillation from springing it up/down, and basing it on real
// utilization (not "prep empty") means a steady-state prep trickle no longer blocks
// the ramp while a fresh-save bootstrap — where prep eats the small pool — still
// reads as fully-used and won't ramp.

/** Max effective hack-% the ramp may reach. Also the share-residual boundary:
 *  once rampLevel == this and prep is clear, free RAM beyond the reserve is
 *  shareable. Tune in-game. */
export const HACK_PCT_RAMP_MAX = 0.75;

/** Per-tick step the ramp floor moves by. Small → smooth, no flap. */
export const RAMP_STEP = 0.02;

/** Ramp UP only when pool utilization (1 − free/total) is below this — i.e. there
 *  is genuine idle RAM after batch + prep. */
export const RAMP_UTIL_LOW = 0.85;

/** Ramp DOWN when pool utilization exceeds this (pool nearly full). The gap
 *  RAMP_UTIL_LOW..RAMP_UTIL_HIGH is the hold deadband. */
export const RAMP_UTIL_HIGH = 0.97;

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

// ── RAM reservation ────────────────────────────────────────────────────────

/** booster's own RAM footprint, GB (its function budget — see devlog). */
export const BOOSTER_RAM_GB = 8.2;
/** Extra home RAM left free as a safety buffer, GB. */
export const HOME_SAFETY_BUFFER_GB = 2;

// ── Port-opener programs (file name → NS method to call) ───────────────────

export const CRACKS = [
    { file: "BruteSSH.exe", method: "brutessh" },
    { file: "FTPCrack.exe", method: "ftpcrack" },
    { file: "relaySMTP.exe", method: "relaysmtp" },
    { file: "HTTPWorm.exe", method: "httpworm" },
    { file: "SQLInject.exe", method: "sqlinject" },
];

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
 * Manager RAM footprints, GB. Hardcoded (like BOOSTER_RAM_GB) so booster can
 * reserve home headroom for the next pending manager WITHOUT a getScriptRam call.
 * Measure each with `mem <file>` after any change and update here.
 */
export const CONTRACTS_MANAGER_RAM = 16.80; // measured in-game (mem managers/contracts.js): 1.6 base + 0.2 ls + 15 getContract
export const PSERVER_MANAGER_RAM = 5.85; // measured in-game (mem managers/pserver.js)
export const HACKNET_MANAGER_RAM = 6.80; // measured in-game (mem managers/hacknet.js)

/** Loop sleep for the (infrequent-purchase) managers, ms. */
export const MANAGER_LOOP_SLEEP = 10000;

// ── Manager spending: payback OR reinvestment-fraction ─────────────────────
//
// A manager buys the cheapest next step (gated by plain affordability) when
// EITHER arm passes:
//
//  1. PAYBACK arm — it pays back within PAYBACK_SECONDS of current income ($/s).
//     This lets large purchases through once income justifies them, and makes
//     upgrades halt automatically in BNs where servers get expensive.
//
//  2. REINVEST arm — its cost ≤ effFrac of current cash. Income-independent, so it
//     bootstraps the fleet on a fresh save (when income is ~0 *because* RAM is the
//     bottleneck — the payback arm can't fire yet). effFrac is NOT constant: it
//     DECAYS from *_REINVEST_FRAC (full bootstrap help) down to *_REINVEST_FLOOR
//     as infrastructure grows toward a target (pserver: fleet RAM → BOOTSTRAP_RAM_GB;
//     hacknet: node count → BOOTSTRAP_NODES). This stops the reinvest arm from
//     permanently overriding payback once bootstrap is done — past the target,
//     payback's "worth it?" gate governs upgrades, with the small floor as a
//     slow-trickle relief valve (a stalled fleet still creeps on a big cash pile).

/** Smallest pserver to buy when filling the fleet, GB (must be a power of two). */
export const PSERVER_START_RAM = 8;

/** Payback horizon: spend a step if it pays back within this many seconds. */
export const PSERVER_PAYBACK_SECONDS = 300;
export const HACKNET_PAYBACK_SECONDS = 300;

/** Reinvest arm bootstrap-max fraction (used at zero infrastructure). */
export const PSERVER_REINVEST_FRAC = 0.25;
export const HACKNET_REINVEST_FRAC = 0.25;

/** Reinvest arm floor — fraction it decays to once the bootstrap target is met. */
export const PSERVER_REINVEST_FLOOR = 0.01;
export const HACKNET_REINVEST_FLOOR = 0.01;

/** Infrastructure target at which the reinvest arm reaches its floor. */
export const PSERVER_BOOTSTRAP_RAM_GB = 25 * 32; // 800 GB (fleet of 25 at 32 GB)
export const HACKNET_BOOTSTRAP_NODES = 8;

// ── Data files ─────────────────────────────────────────────────────────────

/** Topology JSON written by booster for managers to consume. */
export const SERVERS_JSON = "/data/servers.json";

// ── Detection / handoff ────────────────────────────────────────────────────

/** Presence of this file triggers handoff to the advanced controller. */
export const FORMULAS_EXE = "Formulas.exe";
