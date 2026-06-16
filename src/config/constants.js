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

/** Worker RAM costs, GB (validated). Hardcoded to avoid a getScriptRam call. */
export const WORKER_RAM = {
    hack: 1.70,
    grow: 1.75,
    weaken: 1.75,
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

// ── Detection / handoff ────────────────────────────────────────────────────

/** Presence of this file triggers handoff to the advanced controller. */
export const FORMULAS_EXE = "Formulas.exe";
