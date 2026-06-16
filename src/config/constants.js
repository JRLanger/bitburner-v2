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

/** Gap between consecutive HWGW landings, ms. Tune in-game later. */
export const D_GAP = 200;

/** Interval between batch launches into the pipeline, ms. One batch per period. */
export const BATCH_PERIOD = 4 * D_GAP;

/** Main loop sleep, ms. Wake often enough to never miss a grid launch window. */
export const LOOP_SLEEP = BATCH_PERIOD / 2;

/** Small buffer added to every batch's land base so all delays stay ≥ 0, ms. */
export const BATCH_SAFETY_MS = 50;

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

// Recovery: a pure HWGW batch maintains money but provides no surplus to climb
// back to max if a target ever dips below it. When a batching target sits below
// this fraction of max (a sustained drift, not a healthy mid-cycle dip), inject
// supplemental grow to pull it back up.
/** Fire recovery grow when a batching target's money < maxMoney × this. */
export const RECOVER_MONEY_FRAC = 0.95;
/** Fire recovery weaken when a batching target's security > minSecurity + this. */
export const RECOVER_SEC_OVER = 1;

// ── Hack-percentage table ──────────────────────────────────────────────────

/** Resolution of the per-target hack-% table. */
export const HACK_PCT_STEP = 0.01;
/** Inclusive range of hack fractions to evaluate. */
export const HACK_PCT_MIN = 0.01;
export const HACK_PCT_MAX = 0.99;

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

// ── Data files ─────────────────────────────────────────────────────────────

/** Topology JSON written by booster for managers to consume. */
export const SERVERS_JSON = "/data/servers.json";

/** Event log booster writes for offline inspection. */
export const BOOSTER_LOG = "/data/booster-log.txt";

/** How often booster writes a SUMMARY line to the event log, ms. */
export const SUMMARY_INTERVAL_MS = 5000;

// ── Detection / handoff ────────────────────────────────────────────────────

/** Presence of this file triggers handoff to the advanced controller. */
export const FORMULAS_EXE = "Formulas.exe";
