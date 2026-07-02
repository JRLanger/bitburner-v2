/**
 * booster.js — early-game bootstrap hacking controller.
 *
 * The cheap "first stage" controller that runs at the start of a BitNode cycle,
 * before Formulas.exe. See docs/devlog/02-booster.md for the full design.
 *
 * BUILD STATUS: Stage 5 — feeds idle pool RAM to ns.share() (sharePhase) on top
 * of the Stage 4 manager orchestration and the 3a–3e batcher + status table.
 * Formulas.exe handoff (stage 6) still follows.
 *
 * Prerequisites: the three worker scripts must already exist on home. booster
 * does NOT create them; it errors out and exits if any is missing.
 */

import {
    HACK_WORKER,
    GROW_WORKER,
    WEAKEN_WORKER,
    SHARE_WORKER,
    SHARE_RAM,
    SHARE_BUDGET_FRAC,
    SHARE_OFF_FLAG,
    SERVERS_JSON,
    SEC_MARGIN,
    MONEY_EPSILON,
    BATCH_KEEP_MONEY_FRAC,
    BATCH_KEEP_SEC_FRAC,
    BATCH_DROP_MIN_FILL,
    DRIFT_GRACE_MS,
    HACK_PCT_MIN,
    HACK_PCT_MAX,
    HACK_PCT_STEP,
    HACK_PCT_RAMP_MAX,
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
    THREAD_MARGIN,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
    ORBITER,
    BATCH_BUDGET_FRAC,
    REFILL_HEADROOM_FRAC,
    RAMP_HYSTERESIS_FRAC,
    REANCHOR_DROP_FRAC,
    MAX_FIRES_PER_TICK,
    MAX_BATCH_TARGETS,
    SELECT_KEEP_BIAS,
    PREP_LOOKAHEAD,
    D_GAP,
    BATCH_PERIOD,
    BATCH_SAFETY_MS,
    CONTROLLER_DEBUG,
    BOOSTER_DEBUG_LOG,
    CONTRACTS_MANAGER,
    PSERVER_MANAGER,
    HACKNET_MANAGER,
    CONTRACTS_MANAGER_RAM,
    PSERVER_MANAGER_RAM,
    HACKNET_MANAGER_RAM,
    PSERVER_PREFIX,
    HACKNET_GATE,
    STATUS_PORT_CONTROLLER,
    DASHBOARD,
    DASHBOARD_MIN_HOME_RAM_GB,
} from "/config/constants.js";
import { readFlags, writeFlags } from "/lib/flags.js";
import { publishStatus } from "/lib/status.js";

/** HWGW worker paths that must exist on home and get copied to every rooted server. */
const WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

/** Normalized HWGW worker filenames for matching against ns.ps() output. Note this
 *  intentionally EXCLUDES the share worker: inFlightByTarget uses it to attribute
 *  workers to a hack target via args[0], but share workers carry only a seq arg. */
const WORKER_FILES = new Set(WORKERS.map(stripSlash));

/** Everything booster places on rooted hosts: the HWGW workers plus the share
 *  worker. Used for the prerequisite check and per-host provisioning. */
const PLACED_WORKERS = [...WORKERS, SHARE_WORKER];

/**
 * Managers booster orchestrates, in fixed dependency order. Each tick booster
 * launches the FIRST not-yet-running manager whose gate passes, and won't consider
 * a later one until every earlier one is already running (see launchManagers).
 * `ramGB` (hardcoded in constants) is reserved on home so the exec always fits.
 *
 *  1. pserver — grows the RAM pool; launch immediately (it waits internally to
 *     afford). Highest compounding ROI: purchased servers feed the batch pool that
 *     everything else runs on — and it's the cheapest manager (5.85 GB), so it fits
 *     a small early home where contracts (16.8 GB) wouldn't (launchManagers only
 *     considers the FIRST pending manager, so a too-big one at the front would
 *     block the whole chain).
 *  2. contracts — solves coding contracts for free money/rep; no prerequisites
 *     (network is rooted). Gate always true.
 *  3. hacknet — weak ROI; deferred until the pserver fleet is fully built (counted
 *     from topology data booster already has — no extra NS call).
 */
const MANAGERS = [
    { file: PSERVER_MANAGER, ramGB: PSERVER_MANAGER_RAM, gate: () => true },
    { file: CONTRACTS_MANAGER, ramGB: CONTRACTS_MANAGER_RAM, gate: () => true },
    { file: HACKNET_MANAGER, ramGB: HACKNET_MANAGER_RAM, gate: pserverFleetBuilt },
];

/**
 * Manager-launch suppression now lives in the shared flag port (lib/flags.js) under the
 * `managersSeen` key — a list of manager filenames booster has seen running this run. A
 * manager that was seen running and is now gone (user-stopped or self-completed) is not
 * relaunched. The port is wiped on aug/soft reset, so a wiped infra always rebuilds even
 * if this booster process survives the reset — no in-memory set, no reset detection. See
 * launchManagers / nextManagerReserve.
 */
const MANAGERS_SEEN_FLAG = "managersSeen";

/** Monotonic id appended to every worker exec so concurrent workers are unique. */
let batchSeq = 0;

/**
 * Per-target HWGW pipeline state: target -> { committed, lastLand, depth }.
 * `committed` is the list of W1 landing timestamps still in the future, `lastLand`
 * the most recent committed landing, `depth` the target in-flight count (for the
 * status display). Each tick batchPhase prunes landed entries and fires enough new
 * batches to refill to `depth`, each landing one BATCH_PERIOD after the last — a
 * self-pacing scheduler that holds the pipeline full with no fire gate and no
 * skipped slots. Cleared when a target drops to re-prep (classify).
 */
const pipelines = new Map();

/** Targets currently in the batching rotation (persistent across ticks). */
const activeBatching = new Set();

/**
 * Locked BASE batch plan per batching target: the score-optimal bestHackPct result
 * captured when the target was admitted. Reused every tick while batching (never
 * recomputed) so the HWGW grid shape and its RAM footprint stay constant — recomputing
 * each tick desyncs the in-flight grid and wobbles the admission estimate, causing flap.
 * Deleted when a target drifts out and must re-prep. host -> bestHackPct result.
 */
const batchPlan = new Map();

/**
 * Locked RAMPED plan per target: the higher-f plan selectBatchers's waterfall gave this
 * target to spend excess pool RAM (see selectBatchers Pass B). Kept STICKY so a running
 * pipeline's f — and thus its RAM footprint — never jitters tick-to-tick as the excess
 * pool wobbles (prep finishing, share starting); an incumbent reuses its locked ramped
 * plan and only re-ramps on re-anchor (fresh admission), a level/ramp recompute, or a
 * budget collapse that no longer fits. host -> bestHackPct/maximizeHackPct result.
 */
const rampPlan = new Map();

/** Hostnames admitted to batching last tick — drives selectBatchers hysteresis. */
const wasBatching = new Set();

/**
 * Per-target timestamp (ms) when a batching target first went unhealthy (outside
 * the keep-bounds), cleared whenever it reads healthy again. Drives the drift
 * grace: a target is only dropped for re-prep once it has been continuously
 * unhealthy for DRIFT_GRACE_MS, so a brief self-healing transient (a bump-fired
 * batch landing late) doesn't trigger a destructive re-prep. host -> timestamp.
 */
const unhealthySince = new Map();

/** Active share-worker thread count and manual-pause state, for the status line.
 *  Updated by sharePhase each tick. */
let shareThreads = 0;
let shareOff = false;

/**
 * Set by selectBatchers each tick: true once the per-target waterfall has pushed
 * every admitted target to HACK_PCT_RAMP_MAX and still left budget unspent — i.e.
 * all idle batch RAM is absorbed and the remainder is genuine surplus. sharePhase
 * gates on this (was the old `rampLevel == HACK_PCT_RAMP_MAX` boundary).
 */
let rampSaturated = false;

/**
 * Sticky admission-ranking mode (see selectBatchers). false = rank by $/GB/s `score`
 * (RAM is the binding constraint — pack income per scarce GB); true = rank by absolute
 * earning power (the MAX_BATCH_TARGETS count cap is binding while RAM is plentiful — fill
 * the slots with the biggest earners). Sticky with a hysteresis band so a pool wobble at
 * the boundary can't flap the mode (which would reshuffle the admitted set and churn deep
 * pipelines).
 */
let ramAbundantMode = false;

/** Diagnostic log buffer (flushed once per tick) and a monotonic tick counter so
 *  log lines from the same tick can be grouped. See CONTROLLER_DEBUG in constants. */
let debugBuf = [];
let tickNo = 0;
/** Last hacking level seen, to log level-ups (a prime drift suspect: the locked
 *  plan's hack-thread count goes stale as per-thread hack fraction rises). */
let lastHackLevel = 0;
/** Tick-timing diagnostics. `lastTickStart` is the wall-clock time the previous
 *  tick began; `gap` (this start − last start) is the real engine-lag signal: it
 *  should be ≈ LOOP_SLEEP + work, so a gap far above that means the engine slept
 *  long / lagged (too many live worker scripts), which delays op landings and is
 *  the suspected correlated-security-spike cause. `lastWorkMs` is the previous
 *  tick's body duration (top → just before sleep). */
let lastTickStart = 0;
let lastWorkMs = 0;
/** Buffer one diagnostic line for this tick (no-op unless CONTROLLER_DEBUG). */
function dbg(line) {
    if (CONTROLLER_DEBUG) debugBuf.push(line);
}
/** Append this tick's buffered diagnostic lines to the log file and clear. */
function flushDebug(ns) {
    if (CONTROLLER_DEBUG && debugBuf.length > 0) {
        ns.write(BOOSTER_DEBUG_LOG, debugBuf.join("\n") + "\n", "a");
    }
    debugBuf = [];
}

/**
 * Per-target rolling samples of money fraction and security-over-min, used only
 * for the status display. Raw mid-cycle reads oscillate (a hack has landed
 * but its counter-grow hasn't); reporting the window's peak money / floor
 * security shows the grid-aligned baseline instead, so genuine drift is easy to
 * spot. host -> { money: number[], sec: number[] }.
 */
const displayHistory = new Map();
/** How many recent ticks to keep for the display peak/floor (covers a few cycles). */
const DISPLAY_WINDOW = 6;

export async function main(ns) {
    ns.disableLog("ALL");

    // Prerequisite check: all workers (HWGW + share) must exist on home.
    const missing = PLACED_WORKERS.filter((w) => !ns.fileExists(w, "home"));
    if (missing.length > 0) {
        ns.tprint(`ERROR: missing worker script(s): ${missing.join(", ")}`);
        ns.tprint("booster does not create workers. Add them, then re-run.");
        return;
    }

    // Open the unified dashboard if home is roomy enough and it isn't already running;
    // on a small early home, open this controller's own tail window instead (0 GB).
    if (ns.getServerMaxRam("home") >= DASHBOARD_MIN_HOME_RAM_GB) {
        if (ns.fileExists(DASHBOARD, "home") && !isRunning(ns, DASHBOARD)) ns.exec(DASHBOARD, "home");
    } else {
        ns.ui.openTail();
    }

    // Fresh diagnostic log per run (truncate). No-op cost when CONTROLLER_DEBUG off.
    if (CONTROLLER_DEBUG) {
        ns.write(BOOSTER_DEBUG_LOG, `# booster debug log — ${new Date().toISOString()}\n`, "w");
    }

    // Main control loop. Exits via the stage-6 handoff inside the loop: once
    // Formulas.exe is owned, booster execs orbiter on home and returns (see below).
    // The loop is `while (true)` rather than `while (!fileExists(FORMULAS_EXE))`
    // because the handoff must keep the fleet running until orbiter ACTUALLY launches
    // (home may lack RAM for a tick or two) — a bare exit condition would stop booster
    // before orbiter started.
    while (true) {
        tickNo++;
        // Tick-timing: gap = elapsed since the previous tick began. ≈ LOOP_SLEEP +
        // work in the healthy case; a gap far above that = engine lag (op landings
        // delayed → the suspected correlated security spikes). lastWorkMs is the
        // previous tick's body time. Both surface on this tick's summary line.
        const tickStart = Date.now();
        const tickGap = lastTickStart ? tickStart - lastTickStart : 0;
        lastTickStart = tickStart;
        // Log hacking-level changes: a level-up raises per-thread hack fraction, so a
        // plan locked at admission now hacks MORE than its f while its grow still
        // restores only the old f — a leading drift suspect. Correlate trace lines
        // (classify) against these to see drift onset track level-ups.
        if (CONTROLLER_DEBUG) {
            const lvl = ns.getHackingLevel();
            if (lvl !== lastHackLevel) {
                dbg(`T${tickNo} LEVEL ${lastHackLevel} -> ${lvl}`);
                lastHackLevel = lvl;
            }
        }

        // Stage 6 handoff: once Formulas.exe is owned, launch the orbiter controller
        // and retire. Checked at the top of the tick (not as the loop condition) so
        // booster keeps the fleet running until orbiter ACTUALLY starts — if home
        // lacks the RAM this tick, exec returns 0 and booster just retries next tick.
        // The managers (separate processes) keep running across the swap; orbiter
        // re-discovers and continues from the in-flight state.
        if (ns.fileExists(FORMULAS_EXE, "home")) {
            if (isRunning(ns, ORBITER)) {
                ns.tprint("orbiter already running — booster retiring.");
                return;
            }
            const pid = ns.exec(ORBITER, "home");
            if (pid !== 0) {
                ns.tprint("Formulas.exe detected — handed off to orbiter; booster retiring.");
                return;
            }
            ns.print("WARN: Formulas.exe owned but orbiter launch failed (home RAM?) — will retry.");
        }

        const servers = discoverAndRoot(ns);
        ns.write(SERVERS_JSON, JSON.stringify(servers, null, 2), "w");

        const rootedHosts = servers.filter((s) => s.hasRoot).map((s) => s.hostname);
        // Reserve home headroom for the next pending manager, then launch it if its
        // gate trips. Done before buildPool so the pool already excludes that reserve.
        const homeReserveExtra = nextManagerReserve(ns);
        launchManagers(ns, servers);
        const pool = buildPool(ns, rootedHosts, homeReserveExtra);
        const inFlight = inFlightByTarget(ns, rootedHosts);

        const { eligible, needsPrep } = classify(ns, servers);

        // Admission control: cap the actively-batched set to what the pool can
        // sustain (full pipelines), leaving real headroom for prep. Total pool
        // RAM mirrors renderStatus's tally; no extra NS calls.
        const poolTotal =
            servers.reduce((sum, s) => (s.hasRoot ? sum + s.maxRam : sum), 0) -
            HOME_SAFETY_BUFFER_GB;
        const { batchers, reserved, rampSaturated: saturated } = selectBatchers(ns, eligible, poolTotal);
        rampSaturated = saturated;

        // Per-tick summary: eligible vs admitted, so a drop is attributable to either
        // classify (host absent from `eligible`) or selectBatchers (in `eligible`,
        // absent from `batchers` → budget/cap). dropEligible/dropAdmit logged inside.
        if (CONTROLLER_DEBUG) {
            const elig = eligible.map((t) => t.hostname);
            const batched = new Set(batchers.map((t) => t.hostname));
            const notAdmitted = elig.filter((h) => !batched.has(h));
            // gap≈LOOP_SLEEP+work is healthy; gap ≫ that = engine lag. SLOW marks a
            // gap over twice LOOP_SLEEP so lag ticks are greppable and can be lined up
            // against the correlated security spikes in the trace lines.
            const slow = tickGap > 2 * LOOP_SLEEP ? " SLOW" : "";
            dbg(
                `T${tickNo} elig=${eligible.length} batch=${batchers.length} ` +
                `topF=${batchers.length ? Math.round(batchers[0].f * 100) : 0}%${rampSaturated ? " SAT" : ""} ` +
                `reserved=${ns.format.ram(reserved)}/${ns.format.ram(poolTotal * BATCH_BUDGET_FRAC)} ` +
                `poolFree=${ns.format.ram(poolFree(pool))} ` +
                `gap=${tickGap}ms work=${lastWorkMs}ms (sleep=${LOOP_SLEEP}ms)${slow}`
            );
            if (notAdmitted.length > 0) dbg(`  selectBatchers excluded: ${notAdmitted.join(", ")}`);
        }

        // Batch the admitted targets first (consumes RAM by rank), then spend
        // whatever's left prepping the next-best targets.
        batchPhase(ns, batchers, pool, rootedHosts);

        // Reserve the batchers' *unclaimed* pipeline RAM from prep, so a target
        // ramping toward its full pipeline (which fills gradually over a weaken
        // time) isn't starved by greedy prep waves. Batch RAM already running ≈
        // in-flight worker threads × per-thread RAM; the rest of the reservation
        // must stay free for the pipeline to keep filling.
        let batchRunningRam = 0;
        for (const t of batchers) {
            batchRunningRam += (inFlight.get(t.hostname) ?? 0) * WORKER_RAM.weakenRam;
        }
        const prepFloor = Math.max(0, reserved - batchRunningRam);
        // Hard refill floor: free RAM prep/share may never cross, so batchPhase can
        // always fire its per-tick refills and pipelines never decay (see prepPhase).
        const refillHeadroom = poolTotal * REFILL_HEADROOM_FRAC;
        prepPhase(ns, needsPrep, pool, inFlight, prepFloor, refillHeadroom);

        // Share phase (idle-RAM → faction reputation). Once the waterfall is
        // saturated (rampSaturated, set by selectBatchers) and prep is clear, the
        // free RAM still left over beyond the reserved
        // prep/jitter headroom is genuine surplus; sharePhase feeds a fraction of it
        // to ns.share(). Recomputed each tick so it yields the instant batch/prep
        // demand (or a ramp-down) reclaims the RAM. Runs after batch + prep so it
        // only ever sees what they left behind.
        sharePhase(ns, pool, poolTotal, needsPrep, rootedHosts);

        // Track the health window for the full ACTIVE set (eligible), not just the
        // admitted batchers. A target selectBatchers excludes for budget is still
        // active and still being hacked by its in-flight workers, so its window stays
        // valid — and classify's next keep-test needs it. Passing only `batchers` here
        // deleted excluded targets' windows, so their keep-test fell back to the raw
        // trough read (low money / spiked security at high ramp), false-dropping them
        // to re-prep and causing the admitted set to flap. See classify keep-test.
        updateDisplayStats(eligible);
        renderStatus(ns, servers, pool, batchers, needsPrep);
        // Publish the same data to the status bus for dashboard.js (free port write).
        // Pass the FULL eligible set (not just batchers) so the dashboard can show
        // prepped-but-idle targets too (those that lost out on RAM this tick).
        publishStatus(ns, STATUS_PORT_CONTROLLER, buildSnapshot(ns, "booster", servers, pool, eligible, batchers, needsPrep, tickGap));

        // Remember this tick's admitted set for next tick's admission hysteresis.
        wasBatching.clear();
        for (const t of batchers) wasBatching.add(t.hostname);

        // Record this tick's body duration for the next tick's summary line.
        lastWorkMs = Date.now() - tickStart;
        flushDebug(ns);
        await ns.sleep(LOOP_SLEEP);
    }
}

// ── Discovery / rooting ─────────────────────────────────────────────────────

/**
 * Breadth-first scan from home. Roots every reachable server it can, copies the
 * workers onto newly rooted hosts, and returns an array of static info objects.
 */
function discoverAndRoot(ns) {
    const seen = new Set(["home"]);
    const queue = ["home"];
    const result = [];

    while (queue.length > 0) {
        const host = queue.shift();
        for (const next of ns.scan(host)) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }

        // home is always rooted and already holds the worker scripts (it's the
        // copy source). Include it as a normal pool host — buildPool keeps the
        // safety + manager reserve free on it — so batches and prep use its RAM.
        // gatherInfo reports maxMoney 0 for home, so classify never targets it.
        if (host === "home") {
            result.push(gatherInfo(ns, "home", true));
            continue;
        }

        const rooted = ns.hasRootAccess(host) || tryRoot(ns, host);
        // Self-healing provisioning: scp the workers whenever the host is missing them,
        // rather than tracking a "done" set in memory. An aug/soft reset wipes copied
        // scripts from non-home servers, so checking file presence (free — fileExists is
        // already in the RAM budget) re-provisions automatically after a reset without any
        // cache to clear. scp copies all PLACED_WORKERS together, so HACK_WORKER's presence
        // is a sufficient proxy for the whole set.
        if (rooted && !ns.fileExists(HACK_WORKER, host)) {
            provisionWorkers(ns, host);
        }

        result.push(gatherInfo(ns, host, rooted));
    }

    return result;
}

/** Open ports we have crackers for, then nuke. Returns true if rooted. */
function tryRoot(ns, host) {
    if (ns.fileExists("BruteSSH.exe", "home")) ns.brutessh(host);
    if (ns.fileExists("FTPCrack.exe", "home")) ns.ftpcrack(host);
    if (ns.fileExists("relaySMTP.exe", "home")) ns.relaysmtp(host);
    if (ns.fileExists("HTTPWorm.exe", "home")) ns.httpworm(host);
    if (ns.fileExists("SQLInject.exe", "home")) ns.sqlinject(host);

    try {
        ns.nuke(host);
    } catch {
        return false;
    }
    return ns.hasRootAccess(host);
}

/** Copy the workers (HWGW + share) onto a rooted host so it can run them. */
function provisionWorkers(ns, host) {
    ns.scp(PLACED_WORKERS, host, "home");
}

/** Collect static / slow-changing fields for a server. */
function gatherInfo(ns, host, rooted) {
    return {
        hostname: host,
        hasRoot: rooted,
        portsRequired: ns.getServerNumPortsRequired(host),
        hackLevelReq: ns.getServerRequiredHackingLevel(host),
        maxMoney: ns.getServerMaxMoney(host),
        minSecurity: ns.getServerMinSecurityLevel(host),
        maxRam: ns.getServerMaxRam(host),
    };
}

// ── RAM pool & in-flight accounting ─────────────────────────────────────────

/**
 * Build the worker RAM pool: one entry per rooted host with free RAM, sorted
 * largest-first for tidy bin-packing. home keeps a safety buffer free.
 */
function buildPool(ns, rootedHosts, homeReserveExtra = 0) {
    const pool = [];
    for (const host of rootedHosts) {
        const max = ns.getServerMaxRam(host);
        if (max <= 0) continue;
        let free = max - ns.getServerUsedRam(host);
        // Keep the safety buffer plus headroom for the next pending manager free on
        // home, so workers never fill home and block that manager's exec.
        if (host === "home") free -= HOME_SAFETY_BUFFER_GB + homeReserveExtra;
        if (free > 0) pool.push({ host, free });
    }
    pool.sort((a, b) => b.free - a.free);
    return pool;
}

/** Total free RAM across the pool. */
function poolFree(pool) {
    return pool.reduce((sum, s) => sum + s.free, 0);
}

/**
 * Scan ns.ps() across all rooted hosts and tally worker threads per target.
 * Returns Map<target, totalThreads> — used to avoid double-firing prep waves.
 */
function inFlightByTarget(ns, rootedHosts) {
    const map = new Map();
    for (const host of rootedHosts) {
        for (const proc of ns.ps(host)) {
            if (!WORKER_FILES.has(stripSlash(proc.filename))) continue;
            const target = proc.args[0];
            map.set(target, (map.get(target) ?? 0) + proc.threads);
        }
    }
    return map;
}

/**
 * Kill every in-flight HWGW worker targeting `target` across the pool. Called when a
 * target is DROPPED to re-prep: without this, the dropped pipeline's workers keep
 * draining for a full weaken time (~minutes). Because the host is usually re-admitted
 * within seconds, those stale workers stack on top of the fresh pipeline's workers —
 * 3-4 overlapping generations inflate the host's real RAM to 2-3× its plan, eat the
 * pool headroom, starve refills, and over-steal money to ~0, snowballing into the
 * 100%-RAM churn. Killing them makes a drop start clean, exactly like a cold restart.
 * Mirrors inFlightByTarget's matching (WORKER_FILES + args[0]); ns.ps/ns.kill are
 * already in the script's RAM footprint, and drops are rare, so the cost is negligible.
 */
function killWorkersFor(ns, rootedHosts, target) {
    let killed = 0;
    for (const host of rootedHosts) {
        for (const proc of ns.ps(host)) {
            if (!WORKER_FILES.has(stripSlash(proc.filename))) continue;
            if (proc.args[0] !== target) continue;
            if (ns.kill(proc.pid)) killed += proc.threads;
        }
    }
    return killed;
}

// ── Manager orchestration ───────────────────────────────────────────────────

/**
 * Launch managers in fixed dependency order. Each tick, find the FIRST manager that is
 * not running and hasn't already been accounted for this run, and if its gate passes,
 * exec it. A later manager is never launched until every earlier one is accounted for,
 * which makes the order "fixed." Checks ns.ps("home") (not just stored state) so a
 * booster restart never double-launches a persistent manager.
 *
 * The "seen running" set lives in the shared flag port (MANAGERS_SEEN_FLAG): a manager
 * booster saw running that is now gone — user-stopped or self-completed (nothing worth
 * buying) — stays down for the rest of the run. Because the port is wiped on aug/soft
 * reset, the managers relaunch and rebuild the wiped infra automatically, even if this
 * booster process survived the reset (no reset detection needed). A suppressed manager
 * is treated as "accounted for" so the loop moves past it to later managers (e.g.
 * hacknet still launches after pserver finishes).
 */
function launchManagers(ns, servers) {
    const flags = readFlags(ns);
    const seen = new Set(flags[MANAGERS_SEEN_FLAG] ?? []);
    const sizeBefore = seen.size;

    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) {
            seen.add(m.file); // remember it's up so a later disappearance is detectable
            dbg(`  mgr ${m.file}: running`);
            continue;
        }
        if (seen.has(m.file)) {
            dbg(`  mgr ${m.file}: SUPPRESSED (seen running earlier this run, now gone)`);
            continue; // was running, now gone → stopped/done
        }
        const gateOpen = m.gate(servers);
        if (gateOpen) {
            const pid = ns.exec(m.file, "home");
            dbg(`  mgr ${m.file}: gate=open exec pid=${pid}`);
            // Only mark it accounted-for if the exec actually started a process. exec()
            // fails silently (returns 0, no exception) when home lacks free RAM at that
            // instant — e.g. right after a reset, before the reserve has caught up.
            // Without this check a single failed launch looked like "user stopped it".
            if (pid !== 0) seen.add(m.file);
            else ns.print(`WARN: failed to launch ${m.file} (insufficient RAM on home?) — will retry`);
        } else {
            dbg(`  mgr ${m.file}: gate=closed`);
        }
        break; // first pending manager is the only candidate this tick
    }

    if (seen.size !== sizeBefore) writeFlags(ns, { ...flags, [MANAGERS_SEEN_FLAG]: [...seen] });
}

/** RAM to reserve on home for the next pending manager, GB. Skips managers that are
 *  running or already accounted for (stopped/done) — none of those will be (re)launched,
 *  so reserving for them would needlessly shrink the worker pool. */
function nextManagerReserve(ns) {
    const seen = new Set(readFlags(ns)[MANAGERS_SEEN_FLAG] ?? []);
    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) continue;
        if (seen.has(m.file)) continue;
        return m.ramGB;
    }
    return 0; // nothing left to launch → no reserve needed
}

/** True if a script with this filename is already running on home. */
function isRunning(ns, file) {
    const name = stripSlash(file);
    return ns.ps("home").some((proc) => stripSlash(proc.filename) === name);
}

/**
 * Hacknet gate: the pserver fleet is fully built — at least serverCount purchased
 * servers, each at or above ramEachGB. Counted from the topology booster already
 * gathered (hostnames starting with PSERVER_PREFIX), so no extra NS calls.
 */
function pserverFleetBuilt(servers) {
    const built = servers.filter(
        (s) => s.hostname.startsWith(PSERVER_PREFIX) && s.maxRam >= HACKNET_GATE.ramEachGB
    ).length;
    return built >= HACKNET_GATE.serverCount;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Split viable targets into:
 *  - `eligible`: prepped targets, each with its best hack-% table row attached,
 *    sorted by score (most profitable first). No hack-chance floor — `score`
 *    already multiplies in `chance` (see bestHackPct), so a low-chance target
 *    is correctly ranked low rather than excluded outright; it only gets a
 *    batch slot if nothing better is competing for the RAM.
 *  - `needsPrep`: not yet at baseline, sorted by maxMoney (prep value first).
 *
 * The expensive hack-% table is only built for prepped eligible targets (few),
 * never for the whole network.
 */
function classify(ns, servers) {
    const level = ns.getHackingLevel();
    const now = Date.now();
    const eligible = [];
    const needsPrep = [];
    // Rooted hosts run the workers; used to kill a dropped target's stale in-flight
    // workers so re-prep starts clean (see killWorkersFor at the DROP branch below).
    const rootedHosts = servers.filter((s) => s.hasRoot).map((s) => s.hostname);

    for (const s of servers) {
        if (!s.hasRoot || s.maxMoney <= 0 || s.hackLevelReq > level) continue;
        const sec = ns.getServerSecurityLevel(s.hostname);
        const money = ns.getServerMoneyAvailable(s.hostname);

        // Already batching: keep going unless GENUINELY drifted (loose bounds —
        // healthy batches oscillate within each cycle).
        if (activeBatching.has(s.hostname)) {
            const chance = ns.hackAnalyzeChance(s.hostname);
            // Judge drift on the grid-aligned WINDOWED baseline (peak money /
            // floor security), not the raw instantaneous read. At high hack-% the
            // raw money legitimately plunges to ~(1−f) of max each cycle (hack
            // lands, money sits low until the grow lands) and security momentarily
            // spikes — judging on those troughs false-drops healthy targets, which
            // breaks their pipeline and snowballs into real drift. The window's
            // peak/floor is the true baseline the status table already trusts.
            // Chance is dropped from the keep-test: once admitted it only degrades
            // via security, which the security-floor bound already catches.
            const { moneyFrac, secOver } = displayHealth({
                hostname: s.hostname,
                money,
                maxMoney: s.maxMoney,
                sec,
                minSecurity: s.minSecurity,
            });
            const healthy =
                moneyFrac >= BATCH_KEEP_MONEY_FRAC &&
                secOver <= s.minSecurity * BATCH_KEEP_SEC_FRAC;
            // A pipeline still filling toward depth (cold start, or RAM-starved by a
            // flood of newly-eligible servers) hasn't reached the steady state the
            // keep-test judges — its low windowed money is the ramp, not drift.
            // Dropping it destroys the partial pipeline and orphans its in-flight
            // HWGW workers as RAM-squatting zombies that starve the refill further,
            // snowballing into the churn a cold start never hits. So protect a
            // ramping pipeline from the drop entirely; the keep-test only governs
            // FULL pipelines (≥ BATCH_DROP_MIN_FILL × depth). pipe is last tick's
            // state (batchPhase refills after classify); a target with no pipe yet
            // (just admitted) counts as ramping too. Inert in steady state.
            const pipe = pipelines.get(s.hostname);
            const ramping = pipe
                ? pipe.committed.length < pipe.depth * BATCH_DROP_MIN_FILL
                : true;
            // Drift grace: keep batching through a brief unhealthy blip (a
            // bump-fired batch landing late self-heals in a few seconds); only
            // drop to re-prep once unhealthy continuously past DRIFT_GRACE_MS.
            let keep = healthy || ramping;
            if (healthy || ramping) {
                unhealthySince.delete(s.hostname);
            } else {
                const since = unhealthySince.get(s.hostname) ?? now;
                unhealthySince.set(s.hostname, since);
                keep = now - since < DRIFT_GRACE_MS;
            }
            if (keep) {
                // Reuse the locked plan (don't re-optimise mid-pipeline) UNLESS the
                // global ramp floor OR the hacking LEVEL has moved since it was locked.
                // A level-up raises per-thread hack fraction, so the locked h steals
                // more than the locked g restores — money settles at a stable fixed
                // point just below max (the flat-pinned drift that re-prepped catalyst
                // /zb-def). Recomputing h/g at the live level in place restores the
                // balance with no destructive re-prep.
                const locked = batchPlan.get(s.hostname);
                let best = locked && locked.level === level ? locked : null;
                if (!best) {
                    best = bestHackPct(ns, s, chance);
                    if (best) rampPlan.delete(s.hostname); // base changed → waterfall re-ramps fresh
                }
                if (best) {
                    best.level = level;
                    batchPlan.set(s.hostname, best);
                    eligible.push({ ...s, chance, sec, money, ...best });
                    // Drift trajectory trace. Logged when the WINDOWED baseline shows
                    // genuine drift (not the normal per-cycle oscillation, which the
                    // window already filters), plus a sparse heartbeat for context.
                    // `effF` = locked hack-threads × CURRENT per-thread hack fraction:
                    // if it has crept above the locked `f`, the hack now steals more
                    // than the locked grow restores → money drifts down. That gap
                    // (f vs effF), tracked against the LEVEL lines, is the staleness
                    // smoking gun. lockWt vs the live weaken time is a secondary tell.
                    const rawM = money / s.maxMoney;
                    const rawS = sec - s.minSecurity;
                    if (CONTROLLER_DEBUG && (moneyFrac < 0.99 || secOver > 0.3 || rawM < 0.9 || rawS > 1 || tickNo % 30 === 0)) {
                        const effF = best.h * ns.hackAnalyze(s.hostname);
                        const liveWt = ns.getWeakenTime(s.hostname);
                        // pipe (above) is last tick's state (batchPhase refills after
                        // classify): fill = in-flight committed landings vs target depth.
                        // A fill far below depth = pipeline still ramping (fill transient,
                        // now protected from the drop); fill ≈ depth while money/sec drift =
                        // steady-state deep-pipeline instability.
                        const fill = pipe ? `${pipe.committed.length}/${pipe.depth}` : "-";
                        dbg(
                            `  trace ${s.hostname} L${level} ` +
                            `rawM=${rawM.toFixed(3)} rawS=${rawS.toFixed(2)} ` +
                            `winM=${moneyFrac.toFixed(3)} winS=${secOver.toFixed(2)} ` +
                            `f=${best.f.toFixed(2)} effF=${effF.toFixed(3)} h=${best.h} g=${best.g} ` +
                            `fill=${fill} ` +
                            `lockWt=${(best.weakenTime / 1000).toFixed(1)}s liveWt=${(liveWt / 1000).toFixed(1)}s ` +
                            `grace=${unhealthySince.has(s.hostname) ? now - unhealthySince.get(s.hostname) : 0}`
                        );
                    }
                    continue;
                }
            }
            // Drifted out → drop to re-prep below. Kill the stale pipeline's in-flight
            // workers FIRST so they can't keep draining for a weaken time and stack on
            // the re-admitted generation.
            const killed = killWorkersFor(ns, rootedHosts, s.hostname);
            dbg(
                `  classify DROP ${s.hostname}: moneyFrac=${moneyFrac.toFixed(3)} ` +
                `(keep≥${BATCH_KEEP_MONEY_FRAC}) secOver=${secOver.toFixed(2)} ` +
                `(keep≤${(s.minSecurity * BATCH_KEEP_SEC_FRAC).toFixed(2)}) ` +
                `killed=${killed} graceMs=${now - (unhealthySince.get(s.hostname) ?? now)}`
            );
            unhealthySince.delete(s.hostname); // clear grace state
            activeBatching.delete(s.hostname);
            batchPlan.delete(s.hostname); // recompute a fresh plan on re-admission
            rampPlan.delete(s.hostname); // drop the sticky ramp so re-admission re-ramps fresh
            pipelines.delete(s.hostname); // re-anchor the pipeline on re-admission
        }

        // Not batching: STRICT prepped check to start (ensures table accuracy).
        if (!isPrepped(s, sec, money)) {
            needsPrep.push({ ...s, sec, money });
            continue;
        }
        const chance = ns.hackAnalyzeChance(s.hostname);
        const best = bestHackPct(ns, s, chance);
        if (best) {
            best.level = level;
            activeBatching.add(s.hostname);
            batchPlan.set(s.hostname, best); // lock the base plan (+ level) for this run
            rampPlan.delete(s.hostname); // fresh admission → waterfall re-ramps fresh
            eligible.push({ ...s, chance, sec, money, ...best });
            dbg(
                `  classify ADMIT-NEW ${s.hostname} (was re-prepped or fresh): ` +
                `money=${((money / s.maxMoney) * 100).toFixed(1)}% sec=+${(sec - s.minSecurity).toFixed(2)} ` +
                `(min=${s.minSecurity.toFixed(2)})`
            );
        }
    }

    eligible.sort((a, b) => b.score - a.score);
    // Prep easiest-earner first (ascending maxMoney ≈ fewer grow threads to fill ≈
    // cheaper/faster to prep). With a tiny early pool this gets the trivial servers
    // prepped and earning in seconds — funding the pool that later preps the big
    // ones — instead of stalling for hours on un-preppable large servers at the
    // front of the queue. `maxMoney` is the free, tunable prep-cost proxy.
    needsPrep.sort((a, b) => a.maxMoney - b.maxMoney);
    return { eligible, needsPrep };
}

/** True when a server is at (near) min security and (near) max money. */
function isPrepped(s, sec, money) {
    return (
        sec <= s.minSecurity * (1 + SEC_MARGIN) &&
        money >= s.maxMoney * (1 - MONEY_EPSILON)
    );
}

/**
 * Admission control + per-target WATERFALL ramp. Two passes over the prepped, eligible
 * targets in rank order. Concurrency = full pipeline depth (weakenTime/BATCH_PERIOD),
 * f-independent, so a "base pipeline cost" = concurrency × base ramPerBatch.
 *
 * Pass A — pack base load. Admit each target at its score-optimal (base) plan until the
 * RAM budget or MAX_BATCH_TARGETS binds:
 *  - if the full base pipeline fits `remaining`, admit at base — the normal big-pool path;
 *  - else (the marginal target) step the hack-% DOWN to a single batch that fits
 *    `remaining` (`bestHackPct(..., remaining)`), claim the whole rest of the budget,
 *    and run a shallow pipeline that batchPhase deepens as RAM grows. This is the
 *    small-pool path that lets a fresh save batch at all; it consumes the budget, so no
 *    excess remains and Pass B is a no-op.
 *
 * Pass B — waterfall the excess. If Pass A left budget unspent (every admitted target's
 * full base pipeline fit, with room over), spend it by pushing the BEST target's hack-%
 * up to HACK_PCT_RAMP_MAX first (more money/batch at worse $/GB/s — fine, the GB are
 * idle), then spill any remainder to the 2nd-best, and so on. Each target's capacity is
 * its base cost + the running excess; maximizeHackPct finds the highest f that fits.
 *
 * STICKY: the ramped f is locked in rampPlan. A running incumbent reuses its locked
 * ramped plan as long as it still fits the budget — it does NOT re-ramp tick-to-tick as
 * the excess pool wobbles (that would change the pipeline's RAM footprint and desync the
 * in-flight grid / flap the admission estimate, the very thing the lock prevents). A
 * fresh/re-anchored target (not an incumbent, no in-flight grid to desync) takes its
 * full computed ramp immediately; a level-up re-ramps via the batchPlan recompute
 * clearing rampPlan in classify.
 *
 * Ranking metric depends on the BINDING constraint (see the ramAbundant block). When RAM
 * is scarce, rank by $/GB/s `score` (most income per limited GB). When the MAX_BATCH_TARGETS
 * count cap binds while RAM is plentiful, rank by absolute earning power so the slots go to
 * the biggest earners, not the most RAM-efficient ones (a fast low-money server has a great
 * $/GB/s but a poor $/s — pointless to prefer it when GB are idle).
 *
 * Hysteresis: admission walks targets in that rank order, but an incumbent (last tick's
 * batcher) gets a SELECT_KEEP_BIAS bonus for ordering only — so a marginally higher
 * newcomer can't evict a running pipeline, while a clearly higher one still can. Two
 * ceilings: the RAM budget (early, RAM-limited) and MAX_BATCH_TARGETS (late, lag-limited);
 * whichever binds first wins.
 *
 * Returns `rampSaturated`: true once every admitted target is at HACK_PCT_RAMP_MAX and
 * budget still remains — the signal sharePhase uses to spend genuine surplus on share().
 */
function selectBatchers(ns, eligible, poolTotal) {
    const budget = poolTotal * BATCH_BUDGET_FRAC;
    const concurrency = (t) => Math.ceil(t.weakenTime / BATCH_PERIOD);

    // Pick the ranking metric by the BINDING constraint. `potential` = maxMoney × chance,
    // a target's absolute earning power once it ramps to max hack-% (∝ its steady $/s). If
    // the top-MAX_BATCH_TARGETS earners' full base pipelines ALL fit the budget, RAM is not
    // the bottleneck — the count cap is — so rank by potential (biggest earners win the
    // slots). Otherwise RAM is scarce, so $/GB/s `score` (more income per limited GB) wins.
    // The mode is sticky with a 5% hysteresis band (ramAbundantMode) so a pool wobble at the
    // boundary can't flap the metric and churn deep pipelines. (Mirrored in orbiter.js.)
    const potential = (t) => t.maxMoney * t.chance;
    const topByIncomeCost = [...eligible]
        .sort((a, b) => potential(b) - potential(a))
        .slice(0, MAX_BATCH_TARGETS)
        .reduce((sum, t) => sum + concurrency(t) * t.ramPerBatch, 0);
    ramAbundantMode = topByIncomeCost <= budget * (ramAbundantMode ? 1.05 : 1.0);
    const rankKey = ramAbundantMode ? potential : (t) => t.score;

    // Order by the chosen metric, giving incumbents a small bonus (anti-flap, anti-squat).
    const effScore = (t) => rankKey(t) * (wasBatching.has(t.hostname) ? 1 + SELECT_KEEP_BIAS : 1);
    const order = [...eligible].sort((a, b) => effScore(b) - effScore(a));

    // Pass A — pack every target at its base (score-optimal) plan.
    const admitted = [];
    let used = 0;
    for (const t of order) {
        if (admitted.length >= MAX_BATCH_TARGETS) break;
        const remaining = budget - used;
        const baseCost = concurrency(t) * t.ramPerBatch;
        if (remaining >= baseCost) {
            admitted.push({ t, plan: t, baseCost }); // full base pipeline fits
            used += baseCost;
        } else {
            // Marginal target: step the hack-% down to fit `remaining`, claim the rest.
            const fitted = bestHackPct(ns, t, t.chance, remaining);
            if (!fitted) continue; // not even the smallest batch fits → try the next
            admitted.push({ t, plan: { ...t, ...fitted, score: t.score }, baseCost: remaining, capped: true });
            used += remaining;
        }
    }

    // Pass B — waterfall the leftover budget into the best targets (up-ramp only).
    let excess = budget - used;
    let saturated = false;
    if (excess > 0) {
        let allAtMax = true;
        for (const a of admitted) {
            if (excess <= 0 || a.capped) { allAtMax = false; break; }
            const t = a.t;
            const conc = concurrency(t);
            const capacity = a.baseCost + excess;
            // Sticky + HYSTERESIS: an incumbent keeps its locked ramped plan while its
            // cost stays within ±RAMP_HYSTERESIS_FRAC of the allocated capacity, so f
            // stays piecewise-constant instead of churning tick-to-tick as the leftover
            // budget wobbles (the churn that left pipelines full of mismatched-f workers
            // and oversubscribed the pool). Re-plan only when capacity moves OUTSIDE the
            // band: well above → ramp up; well below → ramp down (which batchPhase then
            // instant-drains, see REANCHOR_DROP_FRAC).
            let ramped = rampPlan.get(t.hostname);
            const lockedCost = ramped ? conc * ramped.ramPerBatch : 0;
            const withinBand = ramped &&
                lockedCost <= capacity * (1 + RAMP_HYSTERESIS_FRAC) &&
                lockedCost >= capacity * (1 - RAMP_HYSTERESIS_FRAC);
            if (!(wasBatching.has(t.hostname) && withinBand)) {
                ramped = maximizeHackPct(ns, t, t.chance, capacity / conc, t.f);
                if (ramped) rampPlan.set(t.hostname, ramped);
            }
            if (!ramped) { allAtMax = false; break; }
            a.plan = { ...t, ...ramped, score: t.score }; // keep base score for rank
            const rampedCost = conc * ramped.ramPerBatch;
            used += rampedCost - a.baseCost; // base already counted in Pass A
            excess = capacity - rampedCost;
            if (ramped.f < HACK_PCT_RAMP_MAX - 1e-9) allAtMax = false;
        }
        // Saturated only when every placeable target is admitted (none RAM-starved),
        // all are at the cap, and budget still remains — then the rest is true surplus.
        const allPlaced = admitted.length === Math.min(eligible.length, MAX_BATCH_TARGETS);
        saturated = allAtMax && excess > 0 && allPlaced && admitted.length > 0;
    }

    const batchers = admitted.map((a) => a.plan);
    batchers.sort((a, b) => rankKey(b) - rankKey(a)); // restore global rank order (same metric)
    return { batchers, reserved: used, rampSaturated: saturated };
}

// ── Batch phase (rolling HWGW grid scheduler) ───────────────────────────────

/**
 * SELF-PACING HWGW scheduler. For each eligible target, in rank order, it tops the
 * pipeline up to a target depth: each tick it drops landings that have already
 * passed, then fires enough new batches to refill to `depth`, each landing one
 * one BATCH_PERIOD after the previous committed landing (or one fresh weaken-time + safety
 * ahead if the pipeline ran dry). Nothing is gated and nothing is skipped — only
 * clean, collision-free landings are ever scheduled, so the pipeline holds full
 * with zero drift.
 *
 * Cadence and depth are derived from the STABLE min-security weaken time locked in
 * the plan (`t.weakenTime`), so the depth target is constant and the pipeline holds
 * at exactly N in flight; using the live (security-inflated) weaken time here would
 * grow the target on a transient bump and overfill. Landing *times*, however, use
 * FRESH op-times (current security) so each op lands exactly on its slot regardless
 * of security — see fireBatch. Validated in the isolated rig (src/test/batch-rig.js,
 * Mode C on iron-gym at full depth): +0.00 security, ~2ms landing error, ~full
 * throughput indefinitely.
 */
function batchPhase(ns, eligible, pool, rootedHosts) {
    const now = Date.now();

    for (const t of eligible) {
        const target = t.hostname;
        const ramPerBatch = t.ramPerBatch;

        // In-flight depth = a full pipeline at BATCH_PERIOD spacing, from the stable
        // plan weaken time (constant depth, no overfill on a transient security bump).
        // Lag is governed by MAX_BATCH_TARGETS (number of targets), not per-target depth.
        const depth = Math.ceil(t.weakenTime / BATCH_PERIOD);

        // Fresh op-times for landing math (see fireBatch).
        const weakenTime = ns.getWeakenTime(target);
        const growTime = ns.getGrowTime(target);
        const hackTime = ns.getHackTime(target);

        let pipe = pipelines.get(target);
        if (!pipe) {
            pipe = { committed: [], lastLand: 0, depth, f: t.f };
            pipelines.set(target, pipe);
        }
        pipe.depth = depth;

        // Instant-drain re-anchor on a meaningful f-DOWN. The pipeline is full of
        // workers launched at the OLD (larger) f; firing smaller batches into it would
        // leave it mismatched (real RAM far above the new plan → pool oversubscribes).
        // So when f drops past REANCHOR_DROP_FRAC, kill ALL its in-flight workers and
        // rebuild from empty at the new f — actual RAM snaps down to match `reserved`
        // this tick. f-UP needs no kill. Rare, because RAMP_HYSTERESIS_FRAC keeps f
        // from wobbling.
        if (pipe.committed.length > 0 && t.f < pipe.f * (1 - REANCHOR_DROP_FRAC)) {
            const killed = killWorkersFor(ns, rootedHosts, target);
            if (CONTROLLER_DEBUG) {
                dbg(`  batch ${target} REANCHOR f ${Math.round(pipe.f * 100)}%->${Math.round(t.f * 100)}% killed=${killed}`);
            }
            pipe.committed = [];
            pipe.lastLand = 0;
        }
        pipe.f = t.f;

        // Drop landings that have already passed; what remains is the live depth.
        pipe.committed = pipe.committed.filter((land) => land > now);

        // Top up to depth. Each new batch lands one BATCH_PERIOD after the last committed one,
        // or a fresh weaken-time + safety ahead if the pipeline drained. A momentarily
        // full pool just defers the rest to a later tick (no skipped slots).
        let k = 0;
        let deferred = false;
        while (pipe.committed.length < depth && k < MAX_FIRES_PER_TICK) {
            if (ramPerBatch > poolFree(pool)) { deferred = true; break; }
            const land = Math.max(now + weakenTime + BATCH_SAFETY_MS, pipe.lastLand + BATCH_PERIOD);
            fireBatch(ns, pool, t, land, now, hackTime, growTime, weakenTime);
            pipe.committed.push(land);
            pipe.lastLand = land;
            k++;
        }

        // A pipeline that wanted to refill but couldn't (pool momentarily full) runs
        // shallower than `depth`: fewer grows land per cycle than the hacks need, so
        // money can drift down even though the locked plan is balanced. Logging the
        // defer + the resulting under-fill separates this RAM-starvation drift cause
        // from the plan-staleness one the classify trace captures.
        if (CONTROLLER_DEBUG && deferred) {
            dbg(
                `  batch ${target} DEFER: ramPerBatch=${ns.format.ram(ramPerBatch)} > ` +
                `poolFree=${ns.format.ram(poolFree(pool))} fill=${pipe.committed.length}/${depth} fired=${k}`
            );
        }
    }
}

/**
 * Place one batch's four ops with per-op delays so they land H, W1, G, W2 in
 * order, D_GAP apart, with W1 landing at `base`. The whole batch is known to
 * fit (checked by the caller) so it never half-fires.
 */
function fireBatch(ns, pool, t, base, now, hackTime, growTime, weakenTime) {
    const target = t.hostname;
    // Clamp to ≥ 0; only addH can go negative (on very fast servers), and since
    // hackTime < weakenTime the H→W1 order still holds when it lands ASAP.
    const addH = Math.max(0, base - D_GAP - now - hackTime);
    const addW1 = Math.max(0, base - now - weakenTime);
    const addG = Math.max(0, base + D_GAP - now - growTime);
    const addW2 = Math.max(0, base + 2 * D_GAP - now - weakenTime);

    placeThreads(ns, pool, HACK_WORKER, WORKER_RAM.hackRam, t.h, target, addH);
    placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, t.w1, target, addW1);
    placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, t.g, target, addG);
    placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, t.w2, target, addW2);
}

// ── Prep phase ──────────────────────────────────────────────────────────────

/**
 * Drive needs-prep targets toward baseline (min security, max money), most
 * valuable first, one corrective wave per target at a time (skip targets that
 * already have workers in flight).
 */
function prepPhase(ns, needsPrep, pool, inFlight, prepFloor = 0, refillHeadroom = 0) {
    // Breadth guard: when the batch cap is active, don't prep more servers than
    // could earn a slot soon (cap + lookahead). needsPrep is easiest-first, so
    // this preps the cheapest candidates. Inert when MAX_BATCH_TARGETS is large.
    const prepBudget = MAX_BATCH_TARGETS + PREP_LOOKAHEAD;
    let considered = 0;
    for (const t of needsPrep) {
        if (considered >= prepBudget) break;
        considered++;
        // Stop once free RAM hits the higher of (a) the batchers' reserved-but-
        // unclaimed floor — RAM that belongs to ramping pipelines — and (b) the hard
        // refill headroom that batchPhase needs to keep every pipeline topped up. The
        // headroom is the binding floor once pipelines are full (prepFloor → 0); it is
        // what prevents prep from draining poolFree to zero and starving refills.
        const prepStop = Math.max(prepFloor, refillHeadroom);
        if (poolFree(pool) <= prepStop) break;
        if ((inFlight.get(t.hostname) ?? 0) > 0) continue; // wave already running
        prepWave(ns, t, pool, poolFree(pool) - prepStop);
    }
}

/**
 * Fire one corrective wave for a target:
 *  - if security is above min, weaken it down;
 *  - else grow money toward max, plus weaken to counter grow's security rise
 *    (grow lands at growTime, the counter-weaken at the longer weakenTime, so
 *    the weaken naturally lands after the grow it offsets).
 *
 * `ramBudget` caps the RAM this single wave may consume so one large grow can't
 * blow past the prep floor (and into the batchers' reserved RAM). A wave that
 * doesn't fully fit just makes partial progress and finishes on later ticks.
 */
function prepWave(ns, t, pool, ramBudget = Infinity) {
    const target = t.hostname;

    if (t.sec > t.minSecurity * (1 + SEC_MARGIN)) {
        let need = Math.ceil((t.sec - t.minSecurity) / WEAKEN_SEC * THREAD_MARGIN);
        need = Math.min(need, Math.floor(ramBudget / WORKER_RAM.weakenRam));
        const placed = placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, need, target, 0);
        // Only count this wave as handled if weaken threads actually landed; if
        // the pool was momentarily empty, fall through / retry next tick rather
        // than falsely signalling progress.
        if (placed > 0) return;
    }

    // Security is fine; restore money. Cap grow to the budget, leaving a little for
    // the counter-weaken (~1 weaken per 12.5 grow, so the grow share dominates).
    const mult = t.maxMoney / Math.max(t.money, 1);
    let growNeed = Math.ceil(ns.growthAnalyze(target, mult) * THREAD_MARGIN);
    growNeed = Math.min(growNeed, Math.floor((ramBudget * 0.9) / WORKER_RAM.growRam));
    const placed = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, growNeed, target, 0);
    if (placed > 0) {
        const counter = Math.ceil((placed * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
        placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, counter, target, 0);
    }
}

// ── Thread placement ────────────────────────────────────────────────────────

/**
 * Greedily place up to `threads` worker instances across the pool, largest free
 * host first. Mutates pool free RAM. Returns the number of threads actually
 * placed (may be less than requested if RAM runs out).
 */
function placeThreads(ns, pool, script, ramPerThread, threads, target, delay) {
    let remaining = threads;
    for (const server of pool) {
        if (remaining <= 0) break;
        const fit = Math.floor(server.free / ramPerThread);
        const n = Math.min(fit, remaining);
        if (n <= 0) continue;
        ns.exec(script, server.host, n, target, delay, batchSeq++);
        server.free -= n * ramPerThread;
        remaining -= n;
    }
    return threads - remaining;
}

// ── RAM share ───────────────────────────────────────────────────────────────

/**
 * Feed genuinely-idle pool RAM to ns.share() for a faction-rep boost. Called after
 * batch + prep so it only sees what they left. Gated to spend ONLY true surplus:
 *  - paused if the manual SHARE_OFF_FLAG flag is set in the flag port;
 *  - otherwise only once the waterfall is saturated AND prep is clear, i.e. every
 *    admitted target is at HACK_PCT_RAMP_MAX and the pool still has idle RAM.
 * Spends SHARE_BUDGET_FRAC of the residual (free RAM beyond the reserved
 * prep/jitter headroom). Tops the share-thread count up to target each tick with
 * single-shot 10s workers; when demand returns it launches fewer and the running
 * workers free their RAM within ~10s, so no kill is needed. Updates the display
 * vars (shareThreads / shareOff).
 */
function sharePhase(ns, pool, poolTotal, needsPrep, rootedHosts) {
    // Paused when the SHARE_OFF_FLAG flag is truthy in the flag port (set by
    // /utils/share-off.js; share-on.js clears it). The port clears on aug/soft reset
    // and game reload, so a manual pause naturally lifts on a fresh run.
    shareOff = readFlags(ns)[SHARE_OFF_FLAG] === true;
    if (shareOff) { shareThreads = 0; return; }

    // Gate: only spend surplus that batching/prep provably don't want.
    if (!rampSaturated || needsPrep.length > 0) {
        shareThreads = 0;
        return;
    }

    const residual = poolFree(pool) - poolTotal * REFILL_HEADROOM_FRAC;
    const current = countShareThreads(ns, rootedHosts);
    if (residual <= 0) { shareThreads = current; return; }

    const target = Math.floor((residual * SHARE_BUDGET_FRAC) / SHARE_RAM);
    const toLaunch = target - current;
    const placed = toLaunch > 0 ? placeShare(ns, pool, toLaunch) : 0;
    shareThreads = current + placed;
}

/** Sum in-flight share-worker threads across the pool (RAM-free: ns.ps is in budget). */
function countShareThreads(ns, rootedHosts) {
    const file = stripSlash(SHARE_WORKER);
    let total = 0;
    for (const host of rootedHosts) {
        for (const proc of ns.ps(host)) {
            if (stripSlash(proc.filename) === file) total += proc.threads;
        }
    }
    return total;
}

/** Greedily place up to `threads` share workers across the pool, largest free host
 *  first. Mutates pool free RAM. Returns the number of threads actually placed. */
function placeShare(ns, pool, threads) {
    let remaining = threads;
    for (const server of pool) {
        if (remaining <= 0) break;
        const fit = Math.floor(server.free / SHARE_RAM);
        const n = Math.min(fit, remaining);
        if (n <= 0) continue;
        ns.exec(SHARE_WORKER, server.host, n, batchSeq++);
        server.free -= n * SHARE_RAM;
        remaining -= n;
    }
    return threads - remaining;
}

// ── Scoring (kept for stage 3b batching; not used in the 3a prep loop) ───────

/**
 * Build a per-target plan factory. Resolves the f-independent baseline once (hack-per-
 * thread, weaken time) and returns `atF(f)` which costs a single HWGW batch at hack-
 * fraction `f`. Both bestHackPct (sweep up for best $/GB/s) and maximizeHackPct (sweep
 * down for the highest f that fits) share it so neither re-resolves the baseline per
 * candidate. Grow/weaken (not hack) are over-provisioned by THREAD_MARGIN to absorb
 * per-cycle drift. Returns null if hackAnalyze is 0. All NS calls here are free RAM.
 */
function buildPlanner(ns, server, chance) {
    const target = server.hostname;
    const hackFrac = ns.hackAnalyze(target);
    if (hackFrac <= 0) return null;
    const weakenTime = ns.getWeakenTime(target);

    const atF = (f) => {
        const h = Math.ceil(f / hackFrac);
        // h is rounded UP, so the batch actually steals h*hackFrac, which can exceed the
        // requested f — negligibly on big servers but badly on a small/high-level server
        // where one thread steals a large chunk (e.g. f=0.75 but h*hackFrac≈0.80). Size the
        // grow to the ACTUAL post-hack money: sizing it to 1/(1−f) under-restores by the
        // rounding gap, and the rolling pipeline pins money at a fixed point below max,
        // tripping the keep-test into an endless drop/re-prep churn. Cap at the full-drain
        // floor (one thread can steal ≥100%).
        const actualF = Math.min(h * hackFrac, 1 - 1 / server.maxMoney);
        const g = Math.ceil(ns.growthAnalyze(target, 1 / (1 - actualF)) * THREAD_MARGIN);
        const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC * THREAD_MARGIN);
        const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
        const ramPerBatch =
            h * WORKER_RAM.hackRam + g * WORKER_RAM.growRam + (w1 + w2) * WORKER_RAM.weakenRam;
        const moneyPerBatch = server.maxMoney * f * chance;
        const score = moneyPerBatch / (weakenTime * ramPerBatch);
        return { f, h, g, w1, w2, ramPerBatch, weakenTime, score };
    };
    return { atF };
}

/**
 * Sweep hack fractions HACK_PCT_MIN..HACK_PCT_RAMP_MAX and return the score-optimal
 * ($/GB/s) plan whose single-batch RAM is ≤ `ramCap`. With the default (Infinity) this
 * is the global optimum (the base plan). With a finite cap it's the best batch that
 * *fits* — used to step the hack-% down on a small pool so a target can still batch (a
 * single optimal batch may not fit early, when low hacking level makes weakenTime long
 * and batches large). Returns null if not even the smallest (1%) batch fits the cap.
 *
 * The fitted choice is stable tick-to-tick: `chance` is a common factor across all f,
 * so it never changes which f wins — only hackFrac/weakenTime/ramPerBatch (all stable
 * for a given hacking level) and the cap do.
 */
function bestHackPct(ns, server, chance, ramCap = Infinity) {
    const p = buildPlanner(ns, server, chance);
    if (!p) return null;
    let best = null;
    const hi = Math.min(HACK_PCT_MAX, HACK_PCT_RAMP_MAX);
    for (let f = HACK_PCT_MIN; f <= hi + 1e-9; f += HACK_PCT_STEP) {
        const plan = p.atF(f);
        if (plan.ramPerBatch > ramCap) continue; // batch too big for the available RAM
        if (!best || plan.score > best.score) best = plan;
    }
    return best;
}

/**
 * The waterfall's up-ramp: search from HACK_PCT_RAMP_MAX DOWN to `minF` (the target's
 * base f) and return the HIGHEST f whose single-batch RAM is ≤ `ramCapPerBatch`. Since
 * the caller's capacity always covers the base plan, this returns at least the base f.
 * Top-down with early return keeps it cheap when RAM is plentiful (returns at the cap).
 */
function maximizeHackPct(ns, server, chance, ramCapPerBatch, minF) {
    const p = buildPlanner(ns, server, chance);
    if (!p) return null;
    const hi = Math.min(HACK_PCT_MAX, HACK_PCT_RAMP_MAX);
    for (let f = hi; f >= minF - 1e-9; f -= HACK_PCT_STEP) {
        const plan = p.atF(f);
        if (plan.ramPerBatch <= ramCapPerBatch) return plan;
    }
    return null;
}

// ── Status / helpers ────────────────────────────────────────────────────────

/**
 * Push this tick's raw money/security reads into each batcher's rolling window
 * and drop targets that are no longer batching. Call once per tick before the
 * display functions.
 */
function updateDisplayStats(batchers) {
    const live = new Set();
    for (const t of batchers) {
        live.add(t.hostname);
        let h = displayHistory.get(t.hostname);
        if (!h) {
            h = { money: [], sec: [] };
            displayHistory.set(t.hostname, h);
        }
        h.money.push(t.money / t.maxMoney);
        h.sec.push(t.sec - t.minSecurity);
        if (h.money.length > DISPLAY_WINDOW) h.money.shift();
        if (h.sec.length > DISPLAY_WINDOW) h.sec.shift();
    }
    for (const host of displayHistory.keys()) {
        if (!live.has(host)) displayHistory.delete(host);
    }
}

/**
 * Grid-aligned display health for a target: peak money fraction and floor
 * security-over across the recent window. Falls back to the instantaneous read
 * if no history yet. Returns { moneyFrac, secOver }.
 */
function displayHealth(t) {
    const h = displayHistory.get(t.hostname);
    if (!h || h.money.length === 0) {
        return { moneyFrac: t.money / t.maxMoney, secOver: t.sec - t.minSecurity };
    }
    return { moneyFrac: Math.max(...h.money), secOver: Math.min(...h.sec) };
}

/** Expected income for a batching target, $/s: one batch's take per BATCH_PERIOD
 *  (the steady-state landing cadence). */
function expectedIncome(t) {
    return (t.maxMoney * t.f * t.chance) / (BATCH_PERIOD / 1000);
}

/**
 * Build the status-bus snapshot for dashboard.js — the same numbers renderStatus
 * prints, plus the fuller target list the dashboard needs, as a plain JSON-able
 * object. `allEligible` is classify's full ranked list (batching AND prepped-but-
 * idle targets that lost out on RAM this tick); `batchers` is the admitted subset
 * actually running. Each target is tagged `isBatching` so the dashboard can colour
 * idle (blue) rows differently from active ones (green/amber). Reuses pure helpers
 * (displayHealth, expectedIncome, poolFree) and module state (pipelines,
 * rampSaturated, shareThreads), so it adds no NS calls beyond the cheap
 * getHackingLevel already in the RAM budget. `stage` labels which controller is
 * live; `tickGap` is the engine-lag signal.
 */
function buildSnapshot(ns, stage, servers, pool, allEligible, batchers, needsPrep, tickGap) {
    // Index the ramped plans by host: a batching target's displayed hack-% (and the
    // income/score derived from it) must come from its RAMPED batcher plan, not from the
    // base allEligible entry (which carries the score-optimal f the waterfall ramps UP
    // from). Using allEligible's f here published the un-ramped 4–8% to the dashboard
    // while the pipeline actually ran at the 75% cap.
    const batchingSet = new Set(batchers.map((b) => b.hostname));
    const batcherByHost = new Map(batchers.map((b) => [b.hostname, b]));
    let inFlight = 0, depth = 0;
    const rows = [];

    // Prepped servers (batching = green, prepped-but-idle = blue). For batching rows the
    // ramped plan is the source of f/income/score; idle rows fall back to the base plan.
    // Only batchers contribute to the pipeline totals.
    for (const t of allEligible) {
        const { moneyFrac, secOver } = displayHealth(t);
        const isBatching = batchingSet.has(t.hostname);
        const plan = batcherByHost.get(t.hostname) ?? t; // ramped plan when batching
        const pipe = pipelines.get(t.hostname);
        const committed = pipe ? pipe.committed.length : 0;
        // Idle targets never get a pipeline entry, so derive the depth they WOULD run
        // at from the plan's weaken time, purely for display.
        const tDepth = pipe ? pipe.depth : Math.ceil(t.weakenTime / BATCH_PERIOD);
        if (isBatching) { inFlight += committed; depth += tDepth; }
        rows.push({
            host: t.hostname, moneyFrac, secOver, f: plan.f, committed, depth: tDepth,
            income: expectedIncome(plan), score: plan.score, time: t.weakenTime,
            kind: isBatching ? "active" : "idle",
        });
    }

    // Prep/needs-prep servers (red). To keep the whole list ONE ranked-by-$/s table we
    // need each prep target's potential income, which needs a plan sweep — so cap the
    // work: take the highest-maxMoney prep candidates (free proxy) and preview only
    // those. The preview plan is THROWAWAY (bestHackPct never writes batchPlan/rampPlan).
    // Pre-Formulas this previews against LIVE security/chance (no hypothetical-prepped
    // snapshot), so it under-estimates until the server is near baseline — a rough
    // preview, not exact.
    const prepRanked = [...needsPrep].sort((a, b) => b.maxMoney - a.maxMoney).slice(0, 20);
    for (const t of prepRanked) {
        const chance = ns.hackAnalyzeChance(t.hostname);
        const preview = bestHackPct(ns, t, chance);
        rows.push({
            host: t.hostname, moneyFrac: t.money / t.maxMoney, secOver: t.sec - t.minSecurity,
            f: 0, committed: 0, depth: 0,
            income: preview ? expectedIncome({ ...t, chance, ...preview }) : 0,
            score: preview ? preview.score : 0,
            time: ns.getWeakenTime(t.hostname), // live weaken time ≈ time left to finish prep
            kind: "prepping",
        });
    }

    // Grouped list: attacking (active) first, then prepping, then prepped-but-idle —
    // each group internally ordered by the SAME metric selectBatchers used this tick
    // (ramAbundantMode → absolute $/s, else $/GB/s score). Capped at 20 rows total.
    const metricSort = (a, b) => (ramAbundantMode ? b.income - a.income : b.score - a.score);
    const grouped = [
        ...rows.filter((r) => r.kind === "active").sort(metricSort),
        ...rows.filter((r) => r.kind === "prepping").sort(metricSort),
        ...rows.filter((r) => r.kind === "idle").sort(metricSort),
    ];

    return {
        stage,
        ts: Date.now(),
        level: ns.getHackingLevel(),
        rooted: servers.filter((s) => s.hasRoot).length,
        total: servers.length,
        poolFree: poolFree(pool),
        totalRam: servers.reduce((sum, s) => (s.hasRoot ? sum + s.maxRam : sum), 0),
        topRampF: batchers.reduce((m, t) => Math.max(m, t.f), 0), // highest ramped hack-%
        rampSaturated,
        rankByIncome: ramAbundantMode, // which metric admission/the list is ranked by
        activeCount: batchers.length, // servers actually being attacked (green rows)
        income: batchers.reduce((sum, t) => sum + expectedIncome(t), 0), // only actively-batching $/s counts
        shareThreads,
        shareOff,
        inFlight,
        depth,
        tickGap,
        lastWorkMs,
        targets: grouped.slice(0, 20),
    };
}

/** Render a refreshing status table to the tail window each tick. */

function renderStatus(ns, servers, pool, eligible, needsPrep) {
    ns.clearLog();
    const level = ns.getHackingLevel();
    const rooted = servers.filter((s) => s.hasRoot).length;
    const totalRam = servers.reduce((sum, s) => (s.hasRoot ? sum + s.maxRam : sum), 0);
    const free = poolFree(pool);
    const income = eligible.reduce((sum, t) => sum + expectedIncome(t), 0);

    const W = 58;
    ns.print(`╔═ BOOSTER ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 24))}`);
    ns.print(`║ Hack Lv ${level}  |  Rooted ${rooted}/${servers.length}  |  Pool ${ns.format.ram(free)} free / ${ns.format.ram(totalRam)}`);
    // Top target's hack-% (the waterfall ramps the best target first); SAT = the
    // waterfall is saturated (all admitted at HACK_PCT_RAMP_MAX, surplus is shareable).
    const topF = eligible.reduce((m, t) => Math.max(m, t.f), 0);
    const ramp = topF > 0 ? `  |  Ramp ${Math.round(topF * 100)}%${rampSaturated ? " SAT" : ""}` : "";
    // Pipeline fill meter: total in-flight batches vs total target depth across all
    // batchers, so how full the pipelines are running is visible at a glance.
    let inFlight = 0, depth = 0;
    for (const t of eligible) {
        const pipe = pipelines.get(t.hostname);
        if (pipe) { inFlight += pipe.committed.length; depth += pipe.depth; }
    }
    const fillPct = depth > 0 ? (inFlight / depth) * 100 : 0;
    const fill = `  |  Pipeline ${inFlight}/${depth} (${fillPct.toFixed(0)}%)`;
    ns.print(`║ Batching ${eligible.length}  |  Prepping ${needsPrep.length}${ramp}${fill}  |  Est income $${ns.format.number(income)}/s`);
    if (shareOff) {
        ns.print("║ Share: OFF (manual stop — run /utils/share-on.js to resume)");
    } else if (shareThreads > 0) {
        ns.print(`║ Share: ${shareThreads} threads (${ns.format.ram(shareThreads * SHARE_RAM)})`);
    }
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(
        "║ " +
        "TARGET".padEnd(16) +
        "MON%".padStart(5) +
        "SEC".padStart(7) +
        "HK%".padStart(5) +
        "FILL".padStart(7) +
        "$/s".padStart(11)
    );
    for (const t of eligible) {
        const { moneyFrac, secOver: secOverNum } = displayHealth(t);
        const monPct = Math.round(moneyFrac * 100);
        const secOver = secOverNum.toFixed(2);
        const pipe = pipelines.get(t.hostname);
        const fillCol = pipe ? `${pipe.committed.length}/${pipe.depth}` : "-";
        ns.print(
            "║ " +
            t.hostname.padEnd(16) +
            `${monPct}%`.padStart(5) +
            `+${secOver}`.padStart(7) +
            `${(t.f * 100).toFixed(0)}%`.padStart(5) +
            fillCol.padStart(7) +
            ns.format.number(expectedIncome(t)).padStart(11)
        );
    }
    if (needsPrep.length > 0) {
        ns.print(`╠═ Prepping ${"═".repeat(W - 11)}`);
        const items = needsPrep
            .slice(0, 8)
            .map((t) => `${t.hostname}(${Math.round((t.money / t.maxMoney) * 100)}%)`);
        ns.print("║ " + items.join("  "));
    }
    ns.print(`╚${"═".repeat(W)}`);
}

/** Strip a leading slash so script paths compare consistently. */
function stripSlash(path) {
    return path.startsWith("/") ? path.slice(1) : path;
}
