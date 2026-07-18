/**
 * orbiter.js — mid-game Formulas.exe hacking controller.
 *
 * The "second stage" of the controller lineage (booster → orbiter → station).
 * It is a fork of booster.js with the targeting / thread-math core swapped from
 * current-state NS getters to the Formulas API: every batch plan is computed
 * against a HYPOTHETICAL prepped snapshot (the server at min security / max
 * money) and the live Player, so plans stay exact regardless of the server's
 * actual state. That exactness removes most of booster's drift-fighting machinery
 * — no plan locking, no level/ramp re-lock, no drift grace: classify recomputes
 * each plan from scratch every tick, so it cannot go stale as the hacking level
 * rises. (THREAD_MARGIN is RETAINED on grow/weaken: per-batch grow exactness still
 * compounds downward in a deep rolling pipeline, so the over-provision cushion
 * stays — only hack threads are exact. See bestHackPct.)
 *
 * Everything else (discovery/root/provision, RAM pool, manager orchestration,
 * the self-pacing HWGW scheduler, the share phase, and the status table) is
 * carried over from booster unchanged. See docs/devlog/02-booster.md for the
 * shared design and docs/scripts/orbiter.md for the Formulas swap.
 *
 * Prerequisites: Formulas.exe must be owned (the controller only runs while it
 * exists) and the three worker scripts must already exist on home. orbiter does
 * NOT create workers; it errors out and exits if any is missing.
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
    BATCH_KEEP_SEC_ABS,
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
    ORBITER_THREAD_MARGIN,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
    BATCH_BUDGET_FRAC,
    BATCH_RAM_CAP_FRAC,
    REFILL_HEADROOM_FRAC,
    RAMP_HYSTERESIS_FRAC,
    RAMP_DOWN_STABLE_TICKS,
    REANCHOR_DROP_FRAC,
    REANCHOR_STABLE_TICKS,
    MAX_FIRES_PER_TICK,
    MAX_BATCH_TARGETS,
    SELECT_KEEP_BIAS,
    PREP_LOOKAHEAD,
    D_GAP,
    BATCH_PERIOD,
    BATCH_SAFETY_MS,
    CONTROLLER_DEBUG,
    ORBITER_DEBUG_LOG,
    DEBUG_LOG_MAX_BYTES,
    CONTRACTS_MANAGER,
    PSERVER_MANAGER,
    HACKNET_MANAGER,
    PILOT_MANAGER,
    LIFECYCLE_MANAGER,
    GANG_MANAGER,
    CONTRACTS_MANAGER_RAM,
    PSERVER_MANAGER_RAM,
    HACKNET_MANAGER_RAM,
    PILOT_MANAGER_RAM,
    LIFECYCLE_MANAGER_RAM,
    GANG_MANAGER_RAM,
    PSERVER_PREFIX,
    HACKNET_GATE,
    STATUS_PORT_CONTROLLER,
    DASHBOARD,
    DASHBOARD_MIN_HOME_RAM_GB,
    TELEMETRY_PORT,
    TELEMETRY_SAMPLE,
    TELEMETRY_ERR_WARN_MS,
} from "/config/constants.js";
import { readFlags, writeFlags } from "/lib/flags.js";
import { publishStatus } from "/lib/status.js";
import { renderTail } from "/lib/tail-ui.js";

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
    { file: PILOT_MANAGER, ramGB: PILOT_MANAGER_RAM, gate: pilotGate },
    { file: LIFECYCLE_MANAGER, ramGB: LIFECYCLE_MANAGER_RAM, gate: pilotGate },
    { file: GANG_MANAGER, ramGB: GANG_MANAGER_RAM, gate: gangGate },
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

/** Hosts this controller PROCESS has already scp'd the workers to. Forces one
 *  overwrite-scp per host per controller run, so worker-code updates propagate
 *  on restart (file presence alone can't detect a stale worker). */
const provisionedThisRun = new Set();

/**
 * Landing-telemetry state (drift diagnosis, CONTROLLER_DEBUG only — see the
 * TELEMETRY_* constants). Every TELEMETRY_SAMPLE-th batch is tagged so its four
 * workers report [opTag, target, expLand, actualLand, ret, threads] on
 * TELEMETRY_PORT; drainTelemetry aggregates per-target rolling stats since
 * admission (cleared on drop). Fields as in booster: n, offSlot, maxErr,
 * hackZero (failed hacks), hackLow (successful hack stole below the plan's
 * expected full-server steal → previous cycle under-restored), growMin.
 */
const telemetry = new Map();
/** Batches fired since start; drives the every-Nth telemetry sampling. */
let telemetrySeq = 0;

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

/** Targets currently in the batching rotation (persistent across ticks). Drives
 *  the keep-hysteresis in classify: an incumbent is judged on the loose windowed
 *  keep-bounds (not the strict prepped check) so its normal per-cycle oscillation
 *  doesn't false-drop it to re-prep. */
const activeBatching = new Set();

/**
 * Locked Formulas BASE plan per batching target: host -> score-optimal bestHackPct
 * result, stamped with the hacking `level` it was computed at. Reused every tick while
 * batching and recomputed (Formulas-exact) ONLY when the level changes — see lockedPlan.
 * Unlike booster's pre-Formulas lock this needs no drift grace: the recompute is exact
 * (growThreads), so a level-up just re-balances h/g in place with no re-prep. The lock
 * exists purely for COST — re-sweeping ~75 hack-% steps for every eligible server every
 * tick was ~100ms/tick of work; locking pins it to admission + level changes.
 * Deleted when a target drifts out (classify) so re-admission recomputes fresh.
 */
const batchPlan = new Map();

/**
 * Locked RAMPED plan per target: host -> the higher-f plan selectBatchers's waterfall
 * gave this target to spend excess pool RAM (see selectBatchers Pass B). Kept STICKY so
 * a running pipeline's f — and thus its RAM footprint — never jitters tick-to-tick as
 * the excess pool wobbles (prep finishing, share starting); an incumbent reuses its
 * locked ramped plan and only re-ramps on re-anchor (fresh admission) or a level-up
 * (lockedPlan clears it when the base recomputes) or a budget collapse that no longer
 * fits. host -> bestHackPct/maximizeHackPct result.
 */
const rampPlan = new Map();

/** Hostnames admitted to batching last tick — drives selectBatchers hysteresis. */
const wasBatching = new Set();
/** host -> consecutive ticks its waterfall capacity has sat below the locked
 *  ramp's band; a ramp-DOWN re-mint only fires past RAMP_DOWN_STABLE_TICKS
 *  (damps the capacity whipsaw — see selectBatchers Pass B). */
const rampDownSince = new Map();

/**
 * Per-target timestamp (ms) when a batching target first went unhealthy (outside the
 * windowed keep-bounds), cleared whenever it reads healthy again. Drives the drift
 * grace: a target is dropped for re-prep only after it stays unhealthy continuously for
 * DRIFT_GRACE_MS. Without it, a single momentary windowed dip (a SLOW engine tick or a
 * level-up) drops a batcher instantly — cheap for a shallow target, but catastrophic for
 * a very deep one (e.g. ecorp, depth ~2000 ⇒ weakenTime ~14 min): its in-flight grid
 * keeps landing for the full weaken time, so it can't cleanly re-prep and flaps "on and
 * on." host -> timestamp. (Steady state is stable via live-time scheduling + locked exact
 * plans, so this only ever fires on genuine transients.)
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
/** One-shot startup purge guard — see the STARTUP PURGE block in the main loop. */
let startupPurged = false;
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
/** Bytes written to the debug log this run, for rotation (see DEBUG_LOG_MAX_BYTES). */
let debugBytes = 0;
/** Append this tick's buffered diagnostic lines to the log file and clear.
 *  Rotates (truncates and restarts) past DEBUG_LOG_MAX_BYTES — an unbounded log
 *  makes every Remote API pull serialize the whole file in the game's main
 *  thread, which at tens of MB freezes the UI (the observed 45MB log). */
function flushDebug(ns) {
    if (CONTROLLER_DEBUG && debugBuf.length > 0) {
        const chunk = debugBuf.join("\n") + "\n";
        if (debugBytes + chunk.length > DEBUG_LOG_MAX_BYTES) {
            const header = `# orbiter debug log — rotated ${new Date().toISOString()} (cap ${DEBUG_LOG_MAX_BYTES}B)\n`;
            ns.write(ORBITER_DEBUG_LOG, header + chunk, "w");
            debugBytes = header.length + chunk.length;
        } else {
            ns.write(ORBITER_DEBUG_LOG, chunk, "a");
            debugBytes += chunk.length;
        }
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

    // Prerequisite: Formulas.exe must be owned — the entire targeting core depends
    // on the Formulas API. (booster is the pre-Formulas controller; this one only
    // makes sense once Formulas.exe exists.)
    if (!ns.fileExists(FORMULAS_EXE, "home")) {
        ns.tprint(`ERROR: ${FORMULAS_EXE} not found on home. orbiter is the Formulas`);
        ns.tprint("stage — run booster.js until Formulas.exe is owned, then re-run orbiter.");
        return;
    }

    // Prerequisite check: all workers (HWGW + share) must exist on home.
    const missing = PLACED_WORKERS.filter((w) => !ns.fileExists(w, "home"));
    if (missing.length > 0) {
        ns.tprint(`ERROR: missing worker script(s): ${missing.join(", ")}`);
        ns.tprint("orbiter does not create workers. Add them, then re-run.");
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
        ns.write(ORBITER_DEBUG_LOG, `# orbiter debug log — ${new Date().toISOString()}\n`, "w");
    }

    // Main control loop. Runs while Formulas.exe is owned (effectively forever once
    // bought); the condition leaves a clean seam for a future station/SF4 handoff.
    while (ns.fileExists(FORMULAS_EXE, "home")) {
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
        const servers = discoverAndRoot(ns);
        ns.write(SERVERS_JSON, JSON.stringify(servers, null, 2), "w");

        const rootedHosts = servers.filter((s) => s.hasRoot).map((s) => s.hostname);

        // STARTUP PURGE (once per controller run): kill every HWGW/share worker on
        // the cluster before the first pool build. A game reload restores in-flight
        // workers but restarts them FROM SCRATCH, so their timing args are
        // meaningless; a fresh controller (empty pipelines) then fires a full new
        // grid on top of that zombie generation — RAM accounting (`reserved`) never
        // sees the zombies and usage runs to 100%. One weakenTime of in-flight
        // throughput is the price of a truthful, empty slate on every restart.
        if (!startupPurged) {
            startupPurged = true;
            const shareFile = stripSlash(SHARE_WORKER);
            let purged = 0;
            for (const host of rootedHosts) {
                for (const proc of ns.ps(host)) {
                    const file = stripSlash(proc.filename);
                    if (!WORKER_FILES.has(file) && file !== shareFile) continue;
                    if (ns.kill(proc.pid)) purged += proc.threads;
                }
            }
            if (purged > 0) {
                ns.print(`startup purge: killed ${purged} stale worker threads`);
                dbg(`T${tickNo} STARTUP-PURGE killed=${purged} stale worker threads`);
            }
        }

        // Reserve home headroom for the next pending manager, then launch it if its
        // gate trips. Done before buildPool so the pool already excludes that reserve.
        const homeReserveExtra = nextManagerReserve(ns);
        launchManagers(ns, servers);
        const pool = buildPool(ns, rootedHosts, homeReserveExtra);
        const inFlight = inFlightByTarget(ns, rootedHosts);

        // Drain worker landing telemetry BEFORE classify, so this tick's DROP/trace
        // lines can include up-to-date per-target landing stats.
        drainTelemetry(ns);

        // One Player snapshot per tick, fed to every Formulas call (hack %, chance,
        // op-times, grow threads). Cheap and constant within a tick.
        const player = ns.getPlayer();
        const { eligible, needsPrep } = classify(ns, servers, player);

        // Admission control: cap the actively-batched set to what the pool can
        // sustain (full pipelines), leaving real headroom for prep. Total pool
        // RAM mirrors buildSnapshot's tally; no extra NS calls.
        const poolTotal =
            servers.reduce((sum, s) => (s.hasRoot ? sum + s.maxRam : sum), 0) -
            HOME_SAFETY_BUFFER_GB;
        const { batchers, reserved, rampSaturated: saturated } = selectBatchers(ns, eligible, poolTotal, player);
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
            const free = poolFree(pool);
            const headroom = poolTotal * REFILL_HEADROOM_FRAC;
            dbg(
                `T${tickNo} elig=${eligible.length} batch=${batchers.length} ` +
                `rooted=${rootedHosts.length} lvl=${lastHackLevel} ` +
                `topF=${batchers.length ? Math.round(batchers[0].f * 100) : 0}%${rampSaturated ? " SAT" : ""} ` +
                `reserved=${ns.format.ram(reserved)}/${ns.format.ram(poolTotal * BATCH_BUDGET_FRAC)} ` +
                `poolFree=${ns.format.ram(free)}/${ns.format.ram(headroom)}floor ` +
                `gap=${tickGap}ms work=${lastWorkMs}ms (sleep=${LOOP_SLEEP}ms)${slow}`
            );
            // RAM attribution: where the USED RAM actually is. If poolFree sits at/below
            // the headroom floor, this line names the bucket eating it — orphan>0 means
            // zombie workers from dropped targets are squatting RAM (the churn fingerprint).
            const batchSet = new Set(batchers.map((t) => t.hostname));
            const prepSet = new Set(needsPrep.map((t) => t.hostname));
            const att = ramAttribution(ns, rootedHosts, batchSet, prepSet);
            const used = poolTotal - free;
            const other = used - att.batch - att.prep - att.shareUse - att.orphan; // managers + controller
            dbg(
                `  RAM used=${ns.format.ram(used)} batch=${ns.format.ram(att.batch)} ` +
                `prep=${ns.format.ram(att.prep)} share=${ns.format.ram(att.shareUse)} ` +
                `orphan=${ns.format.ram(att.orphan)} other=${ns.format.ram(other)}`
            );
            if (att.orphan > 0) {
                const top = [...att.orphanHosts.entries()]
                    .sort((a, b) => b[1] - a[1]).slice(0, 6)
                    .map(([h, r]) => `${h}=${ns.format.ram(r)}`).join(" ");
                dbg(`  RAM orphans: ${top}`);
            }
            // Near-saturation per-batcher detail (only when free is within 1.25× the floor,
            // i.e. when the problem manifests): fill vs depth and actual vs planned RAM, to
            // separate under-fill (RAM-starved refills) from over-fill (plan/RAM mismatch).
            if (free <= headroom * 1.25) {
                for (const t of batchers) {
                    const pipe = pipelines.get(t.hostname);
                    const fill = pipe ? `${pipe.committed.length}/${pipe.depth}` : "-/-";
                    const actualRam = att.byTarget.get(t.hostname) ?? 0;
                    const planRam = Math.ceil(t.weakenTime / BATCH_PERIOD) * t.ramPerBatch;
                    dbg(
                        `    bat ${t.hostname} f=${Math.round(t.f * 100)}% fill=${fill} ` +
                        `ram=${ns.format.ram(actualRam)}/${ns.format.ram(planRam)}plan`
                    );
                }
            }
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
        prepPhase(ns, needsPrep, pool, inFlight, player, prepFloor, refillHeadroom);

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
        // One snapshot feeds both views: the tail window (lib/tail-ui.js) and the
        // status bus for dashboard.js — same numbers, one source of truth. The FULL
        // eligible set (not just batchers) is included so prepped-but-idle targets
        // (those that lost out on RAM this tick) show up too.
        const snap = buildSnapshot(ns, "orbiter", servers, pool, eligible, batchers, needsPrep, player, tickGap);
        renderTail(ns, snap);
        publishStatus(ns, STATUS_PORT_CONTROLLER, snap);

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
    // BFS parent of each discovered host, captured for free during the scan already
    // done here every tick. Stamped into servers.json (via gatherInfo) so pilot.js
    // can reconstruct a home->target hop path (lib/netpath.js) without re-scanning
    // the network itself — see docs/plans/pilot-singularity.md phase 2.
    const parentOf = new Map();
    const result = [];

    while (queue.length > 0) {
        const host = queue.shift();
        for (const next of ns.scan(host)) {
            if (!seen.has(next)) {
                seen.add(next);
                parentOf.set(next, host);
                queue.push(next);
            }
        }

        // home is always rooted and already holds the worker scripts (it's the
        // copy source). Include it as a normal pool host — buildPool keeps the
        // safety + manager reserve free on it — so batches and prep use its RAM.
        // gatherInfo reports maxMoney 0 for home, so classify never targets it.
        if (host === "home") {
            result.push(gatherInfo(ns, "home", true, null));
            continue;
        }

        const rooted = ns.hasRootAccess(host) || tryRoot(ns, host);
        // Self-healing provisioning: scp the workers when the host is missing them
        // (an aug/soft reset wipes copied scripts — file presence re-provisions with
        // no cache to clear) OR once per controller run (provisionedThisRun): file
        // presence alone can't tell an up-to-date worker from a STALE one, so a
        // worker-code change would never reach already-provisioned hosts. The
        // once-per-run scp overwrites them on every controller (re)start instead.
        if (rooted && (!ns.fileExists(HACK_WORKER, host) || !provisionedThisRun.has(host))) {
            provisionWorkers(ns, host);
            provisionedThisRun.add(host);
        }

        result.push(gatherInfo(ns, host, rooted, parentOf.get(host) ?? null));
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

/** Collect static / slow-changing fields for a server. `parent` (this host's BFS
 *  predecessor from home, null for home itself) is stamped purely for pilot.js's
 *  benefit (see lib/netpath.js) — this controller never uses it itself. It is free;
 *  backdoor state deliberately is NOT stamped here (ns.getServer would add ~2 GB
 *  to this controller; pilot checks its few targets itself). */
function gatherInfo(ns, host, rooted, parent) {
    return {
        hostname: host,
        hasRoot: rooted,
        parent,
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
 * Worker threads of `ramPerThread` that can ACTUALLY be placed across the pool —
 * whole threads per host. poolFree's raw sum counts sub-thread slivers (e.g. 1.0 GB
 * free on 30 hosts = 30 GB "free" where no 1.75 GB thread fits), so gating a batch
 * on poolFree alone could half-fire it: hack threads placed, grow threads not,
 * silently unbalancing the batch. Gate on this instead.
 */
function placeableThreads(pool, ramPerThread) {
    let n = 0;
    for (const s of pool) n += Math.floor(s.free / ramPerThread);
    return n;
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

/**
 * DEBUG-ONLY. Attribute every live worker's RAM across the pool into four buckets so
 * a saturated pool reveals WHO is holding the RAM the log otherwise can't name:
 *   batch  — workers on a current batcher (the legitimate pipeline load),
 *   prep   — workers on a current needs-prep target,
 *   share  — ns.share workers,
 *   orphan — workers on a host that is NEITHER a batcher nor a prep target, i.e.
 *            zombies from a target that was dropped/de-eligible but whose in-flight
 *            HWGW workers keep draining and squatting RAM. A large/persistent orphan
 *            bucket is the direct fingerprint of the drop-churn → refill-starvation loop.
 * `byTarget` maps each hack target to its live worker RAM (for the per-batcher detail).
 * No new NS-RAM cost (ns.ps is already in the script footprint); CPU only, debug-gated.
 */
function ramAttribution(ns, rootedHosts, batchSet, prepSet) {
    const hackFile = stripSlash(HACK_WORKER);
    const growFile = stripSlash(GROW_WORKER);
    const weakenFile = stripSlash(WEAKEN_WORKER);
    const shareFile = stripSlash(SHARE_WORKER);
    // NOTE: the share bucket is named shareUse, NOT `share` — a property named after
    // an NS function (ns.share) gets phantom-charged by the RAM analyzer (+2.40 GB).
    let batch = 0, prep = 0, shareUse = 0, orphan = 0;
    const byTarget = new Map();
    const orphanHosts = new Map();
    for (const host of rootedHosts) {
        for (const proc of ns.ps(host)) {
            const file = stripSlash(proc.filename);
            let ram;
            if (file === hackFile) ram = proc.threads * WORKER_RAM.hackRam;
            else if (file === growFile) ram = proc.threads * WORKER_RAM.growRam;
            else if (file === weakenFile) ram = proc.threads * WORKER_RAM.weakenRam;
            else if (file === shareFile) { shareUse += proc.threads * SHARE_RAM; continue; }
            else continue;
            const target = proc.args[0];
            byTarget.set(target, (byTarget.get(target) ?? 0) + ram);
            if (batchSet.has(target)) batch += ram;
            else if (prepSet.has(target)) prep += ram;
            else { orphan += ram; orphanHosts.set(target, (orphanHosts.get(target) ?? 0) + ram); }
        }
    }
    return { batch, prep, shareUse, orphan, byTarget, orphanHosts };
}

// ── Landing telemetry (drift diagnosis) ─────────────────────────────────────

/**
 * Drain TELEMETRY_PORT and fold each record into the per-target rolling stats
 * (see the `telemetry` map doc). Logs a dbg line for each anomalous landing:
 *   off-slot — |actual − expected| > TELEMETRY_ERR_WARN_MS (landing-order risk);
 *   hackLow  — a successful hack stole < 95% of the plan's expected steal from a
 *              FULL server, i.e. money was already below max when it landed.
 * All port ops are 0 GB; runs every tick but the port only ever holds data when
 * CONTROLLER_DEBUG sampling is on (fireBatch tags no batches otherwise).
 */
function drainTelemetry(ns) {
    while (true) {
        const rec = ns.readPort(TELEMETRY_PORT);
        if (rec === "NULL PORT DATA") break;
        if (!Array.isArray(rec) || rec.length < 6) continue;
        const [op, target, expLand, actLand, ret, threads] = rec;
        let s = telemetry.get(target);
        if (!s) {
            s = { n: 0, offSlot: 0, maxErr: 0, hackZero: 0, hackLow: 0, growMin: Infinity, wClamp: 0 };
            telemetry.set(target, s);
        }
        s.n++;
        const err = actLand - expLand;
        if (Math.abs(err) > Math.abs(s.maxErr)) s.maxErr = err;
        if (Math.abs(err) > TELEMETRY_ERR_WARN_MS) {
            s.offSlot++;
            dbg(`  tele ${target} ${op} OFF-SLOT err=${Math.round(err)}ms thr=${threads} ret=${typeof ret === "number" ? ret.toFixed(3) : ret}`);
        }
        if (op === "G" && typeof ret === "number" && ret < s.growMin) s.growMin = ret;
        // A weaken that reduced almost NOTHING landed with security already at ~min,
        // i.e. BEFORE the grow it was scheduled to counter — order-inversion evidence.
        // Only the near-total clamp counts: PARTIAL clamping is normal by design
        // (weakens are over-provisioned by the thread margin, so in a healthy grid
        // the W2 always reduces less than its full 0.05×threads capacity). Counter
        // only, no per-event log.
        if ((op === "W1" || op === "W2") && typeof ret === "number" && threads > 0) {
            if (ret < WEAKEN_SEC * threads * 0.25) s.wClamp++;
        }
        if (op === "H" && typeof ret === "number") {
            if (ret === 0) {
                s.hackZero++;
            } else {
                const plan = batchPlan.get(target);
                if (plan && plan.steal && ret < plan.steal * 0.95) {
                    s.hackLow++;
                    dbg(
                        `  tele ${target} H HACK-LOW stole=${ns.format.number(ret)} ` +
                        `expected=${ns.format.number(plan.steal)} (money below max at landing)`
                    );
                }
            }
        }
    }
}

/** One-line summary of a target's telemetry stats for DROP/trace log lines. */
function teleSummary(target) {
    const s = telemetry.get(target);
    if (!s) return "tele=none";
    const gm = s.growMin === Infinity ? "-" : s.growMin.toFixed(2);
    return `tele n=${s.n} off=${s.offSlot} maxErr=${Math.round(s.maxErr)}ms ` +
        `hLow=${s.hackLow} h0=${s.hackZero} wCl=${s.wClamp} gMin=${gm}`;
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
        const gateOpen = m.gate(servers, ns);
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

/**
 * Pilot gate: player owns SF4 (ns.singularity.* usable outside BN4) OR the current
 * run IS BitNode 4 (singularity is free there even at SF4 level 0). getResetInfo is
 * a cheap top-level NS call (not under singularity), so this costs nothing extra to
 * check every tick while pilot is still pending. ownedSF is a Map<sfNumber, level>;
 * a present, >0 entry for key 4 means SF4 is active. If the gate can never pass this
 * run (no SF4, not BN4), pilot simply stays "pending" forever — launchManagers logs
 * once (gate=closed) and moves on; later managers behind it in the list still launch.
 * Takes `ns` (unlike the other gates) because it's the only one that needs a live NS
 * call rather than pre-gathered topology data — see launchManagers' `m.gate(servers, ns)`.
 */
/**
 * Gang gate: a gang is only ever creatable with SF2 owned or inside BN2, and
 * the manager's rep gate needs singularity (pilotGate). Checked without any
 * ns.gang.* reference so the controller pays no gang-API RAM; the manager
 * itself idles in its karma phase until createGang succeeds.
 */
function gangGate(servers, ns) {
    const info = ns.getResetInfo();
    const sf2 = (info.ownedSF.get(2) ?? 0) > 0 || info.currentNode === 2;
    return sf2 && pilotGate(servers, ns);
}

function pilotGate(servers, ns) {
    const info = ns.getResetInfo();
    const sf4Level = info.ownedSF.get(4) ?? 0;
    return sf4Level > 0 || info.currentNode === 4;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Split viable targets into:
 *  - `eligible`: targets with a Formulas-exact best hack-% plan attached, sorted
 *    by score (most profitable first). No hack-chance floor — `score` already
 *    multiplies in `chance` (see bestHackPct), so a low-chance target is correctly
 *    ranked low rather than excluded; it only wins a batch slot if nothing better
 *    competes for the RAM.
 *  - `needsPrep`: not yet at baseline, sorted by maxMoney (prep value first).
 *
 * Plans are LOCKED (see batchPlan / lockedPlan): computed once at admission and
 * recomputed Formulas-exact only when the hacking level or ramp changes. Because the
 * recompute is exact, a level-up just re-balances h/g in place. Incumbents are kept on a
 * loose WINDOWED keep-test plus a DRIFT_GRACE_MS grace (see unhealthySince), so a brief
 * desync from a SLOW tick or level-up doesn't needlessly drop a deep pipeline. Locking is
 * purely a cost win: re-sweeping the hack-% table for every server every tick cost
 * ~100ms/tick.
 */
function classify(ns, servers, player) {
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

        // Already batching: keep going unless GENUINELY drifted (loose windowed
        // bounds — healthy batches oscillate within each cycle). Judge drift on the
        // grid-aligned WINDOWED baseline (peak money / floor security), not the raw
        // instantaneous read: at high hack-% the raw money legitimately plunges to
        // ~(1−f) of max each cycle and security momentarily spikes, so judging on
        // those troughs would false-drop healthy targets and break their pipeline.
        if (activeBatching.has(s.hostname)) {
            const { moneyFrac, secOver } = displayHealth({
                hostname: s.hostname,
                money,
                maxMoney: s.maxMoney,
                sec,
                minSecurity: s.minSecurity,
            });
            // Security keep-bound: relative with an ABSOLUTE floor — min×0.10 is a
            // hair-trigger on low-minSecurity servers (min=3 → only +0.30 tolerated),
            // where the observed drift-drops clustered. See BATCH_KEEP_SEC_ABS.
            let healthy =
                moneyFrac >= BATCH_KEEP_MONEY_FRAC &&
                secOver <= Math.max(s.minSecurity * BATCH_KEEP_SEC_FRAC, BATCH_KEEP_SEC_ABS);
            // EMPTY-PIPELINE STRICTNESS (deadlock variant 2). The loose keep-bound
            // above tolerates more security than batchPhase's fire gate
            // (min×(1+SEC_MARGIN)) — hysteresis meant for a RUNNING pipeline. A
            // target parked in that gap with an EMPTY pipeline is healthy-but-
            // unfireable forever: no in-flight weaken will ever cool it, batchPhase
            // never fires (hot), and "healthy" keeps it from re-prep (observed:
            // deltaone min=26 at sec +2.34 — over the +1.30 fire gate, under the
            // +2.60 keep bound — frozen at fill=0/1956). An empty pipeline has no
            // workers to protect, so strictness costs nothing: when empty, health
            // also requires FIREABLE security, letting the normal grace → drop →
            // re-prep path clear the hot residue with a weaken wave.
            const pipeNow = pipelines.get(s.hostname);
            if (healthy && pipeNow && pipeNow.committed.length === 0 &&
                sec > s.minSecurity * (1 + SEC_MARGIN)) {
                healthy = false;
            }
            // A pipeline still FILLING toward depth (RAM-starved while a flood of newly-
            // eligible servers contends for the pool — e.g. just after bulk-buying the port
            // openers) hasn't reached the steady state this keep-test judges; its low
            // windowed money is the ramp, not drift. Dropping it destroys the partial
            // pipeline and orphans its in-flight HWGW workers as RAM-squatting zombies that
            // starve every other pipeline's refill, snowballing into a churn the scheduler
            // can't climb out of. So protect a ramping pipeline from the drop; the keep-test
            // only governs FULL pipelines (≥ BATCH_DROP_MIN_FILL × depth). Inert in steady
            // state (full pipelines sit at ~100% fill), so throughput is unchanged.
            const pipe = pipelines.get(s.hostname);
            // EMPTY pipelines are NOT protected: the protection exists to avoid
            // orphaning in-flight workers, and an empty pipeline has none — while
            // protecting it can deadlock. A crash/reload leaves targets drained
            // and hot (startup purge kills workers mid-cycle); batchPhase's
            // security deferral then never fires (security only falls when a
            // weaken LANDS — an empty pipeline has none coming), and the old
            // blanket protection kept classify from ever dropping the target to
            // re-prep. Three-way deadlock, observed as every batcher frozen at
            // fill=0/N with money=4% and chronic FIRE-HOT. Empty+unhealthy now
            // falls through to the normal keep-test/grace and re-preps.
            const ramping = pipe
                ? pipe.committed.length > 0 &&
                  pipe.committed.length < pipe.depth * BATCH_DROP_MIN_FILL
                : true;
            // Drift grace: keep batching through a brief unhealthy blip (a SLOW engine
            // tick or a level-up momentarily desyncs the windowed baseline); only drop
            // once unhealthy continuously past DRIFT_GRACE_MS. Critical for deep targets
            // whose multi-minute weaken time makes a needless drop very expensive.
            let keep = healthy || ramping;
            if (healthy || ramping) {
                unhealthySince.delete(s.hostname);
            } else {
                const since = unhealthySince.get(s.hostname) ?? now;
                unhealthySince.set(s.hostname, since);
                keep = now - since < DRIFT_GRACE_MS;
            }
            if (keep) {
                const best = lockedPlan(ns, s, player, level);
                if (best) {
                    eligible.push({ ...s, sec, money, ...best });
                    continue;
                }
                // No plan (hackPercent 0 — rare) → the pipeline cannot continue; fall
                // into the drop cleanup below. Without this the target stayed in
                // activeBatching with a live pipeline while classify pushed it to
                // needsPrep, leaving zombie workers no one ever killed.
                keep = false;
            }
            {
                // Genuinely drifted (unhealthy past the grace window) → drop to re-prep.
                // Kill the stale pipeline's in-flight workers FIRST so they can't keep
                // draining for a weaken time and stack on the re-admitted generation.
                const killed = killWorkersFor(ns, rootedHosts, s.hostname);
                dbg(
                    `  classify DROP ${s.hostname}: moneyFrac=${moneyFrac.toFixed(3)} ` +
                    `(keep≥${BATCH_KEEP_MONEY_FRAC}) secOver=${secOver.toFixed(2)} ` +
                    `(keep≤${Math.max(s.minSecurity * BATCH_KEEP_SEC_FRAC, BATCH_KEEP_SEC_ABS).toFixed(2)}) ` +
                    `fill=${pipe ? pipe.committed.length + "/" + pipe.depth : "-/-"} ramping=${ramping} ` +
                    `killed=${killed} graceMs=${now - (unhealthySince.get(s.hostname) ?? now)} ` +
                    teleSummary(s.hostname)
                );
                unhealthySince.delete(s.hostname);  // clear grace state
                activeBatching.delete(s.hostname);
                batchPlan.delete(s.hostname);  // recompute a fresh plan on re-admission
                rampPlan.delete(s.hostname);   // drop the sticky ramp so re-admission re-ramps fresh
                pipelines.delete(s.hostname);  // re-anchor the pipeline on re-admission
                telemetry.delete(s.hostname);  // stats belong to the dropped generation
            }
        }

        // Not batching: STRICT prepped check before admitting, so the first batches
        // land on a true baseline.
        if (!isPrepped(s, sec, money)) {
            needsPrep.push({ ...s, sec, money });
            continue;
        }
        const best = lockedPlan(ns, s, player, level);
        if (best) {
            activeBatching.add(s.hostname);
            eligible.push({ ...s, sec, money, ...best });
            // Log the FULL minted plan (Formulas-exact against the prepped snapshot,
            // so — unlike booster — it CANNOT be security-skewed; if drift still shows
            // here the cause is elsewhere). steal = expected $ per successful hack from
            // a FULL server (the telemetry HACK-LOW reference); growMult = the restore
            // multiplier g was sized for.
            dbg(
                `  classify ADMIT-NEW ${s.hostname} (was re-prepped or fresh): ` +
                `money=${((money / s.maxMoney) * 100).toFixed(1)}% sec=+${(sec - s.minSecurity).toFixed(2)} ` +
                `(min=${s.minSecurity.toFixed(2)}) plan f=${best.f.toFixed(2)} h=${best.h} g=${best.g} ` +
                `w1=${best.w1} w2=${best.w2} chance=${(best.chance * 100).toFixed(0)}% ` +
                `steal=${ns.format.number(best.steal)} growMult=${best.growMult.toFixed(3)} ` +
                `wt=${(best.weakenTime / 1000).toFixed(1)}s`
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
 * full computed ramp immediately; a level-up re-ramps via lockedPlan clearing rampPlan.
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
function selectBatchers(ns, eligible, poolTotal, player) {
    const budget = poolTotal * BATCH_BUDGET_FRAC;
    const concurrency = (t) => Math.ceil(t.weakenTime / BATCH_PERIOD);

    // Pick the ranking metric by the BINDING constraint. `potential` = maxMoney × chance,
    // a target's absolute earning power once it ramps to max hack-% (∝ its steady $/s). If
    // the top-MAX_BATCH_TARGETS earners' full base pipelines ALL fit the budget, RAM is not
    // the bottleneck — the count cap is — so rank by potential (biggest earners win the
    // slots). Otherwise RAM is scarce, so $/GB/s `score` (more income per limited GB) wins.
    // The mode is sticky with a 5% hysteresis band (ramAbundantMode) so a pool wobble at the
    // boundary can't flap the metric and churn deep pipelines.
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

    // PER-BATCH RAM CAP (stall variant 3, mirrors booster). No admitted plan may
    // cost more per batch than this — batchPhase's placeable gate needs one whole
    // batch free at fire time, and the REFILL_HEADROOM invariant only guarantees
    // that while a batch costs less than the floor. On a small pool a plan fitted
    // to the BUDGET (a pipeline-total number) can exceed what is ever free,
    // deferring forever at fill=0 while its phantom reservation starves prep
    // (observed on booster: n00dles 105.65GB/batch vs 100GB poolFree, fresh BN).
    // Stable tick-to-tick (depends only on poolTotal), so no gate interaction.
    const perBatchCap = poolTotal * BATCH_RAM_CAP_FRAC;

    // Pass A — pack every target at its base (score-optimal) plan.
    const admitted = [];
    let used = 0;
    for (const t of order) {
        if (admitted.length >= MAX_BATCH_TARGETS) break;
        const remaining = budget - used;
        const baseCost = concurrency(t) * t.ramPerBatch;
        if (remaining >= baseCost && t.ramPerBatch <= perBatchCap) {
            admitted.push({ t, plan: t, baseCost }); // full base pipeline fits
            used += baseCost;
        } else {
            // Marginal target: step the hack-% down to fit `remaining` (and the
            // per-batch cap), claim the rest.
            const fitted = bestHackPct(ns, t, player, Math.min(remaining, perBatchCap));
            if (!fitted) continue; // not even the smallest batch fits → try the next
            const claimed = Math.min(remaining, concurrency(t) * fitted.ramPerBatch);
            admitted.push({ t, plan: { ...t, ...fitted, score: t.score }, baseCost: claimed, capped: true });
            used += claimed;
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
            // instant-drains, see REANCHOR_DROP_FRAC). Keeping a plan slightly over
            // capacity is fine — `reserved` reflects it (matches the live pipeline) and
            // the small overcommit is absorbed by the refill headroom.
            let ramped = rampPlan.get(t.hostname);
            const lockedCost = ramped ? conc * ramped.ramPerBatch : 0;
            const withinBand = ramped &&
                lockedCost <= capacity * (1 + RAMP_HYSTERESIS_FRAC) &&
                lockedCost >= capacity * (1 - RAMP_HYSTERESIS_FRAC);
            if (!(wasBatching.has(t.hostname) && withinBand)) {
                // RAMP-DOWN DAMPING (mirrors booster): a re-mint with capacity BELOW
                // the locked band shrinks f — and when the capacity whipsaws
                // tick-to-tick, that instant down-mint feeds the every-other-tick
                // f-flip that REANCHOR then turns into pipeline massacres. A genuine
                // capacity loss persists; a flap reverses in a tick or two. So the
                // deficit must hold RAMP_DOWN_STABLE_TICKS consecutive ticks before
                // the down-mint fires; until then keep the locked plan at its real
                // (counted) cost. Up-mints stay immediate — they kill nothing.
                const deficit = ramped && wasBatching.has(t.hostname) &&
                    lockedCost > capacity * (1 + RAMP_HYSTERESIS_FRAC);
                const held = (rampDownSince.get(t.hostname) ?? 0) + 1;
                if (deficit && held < RAMP_DOWN_STABLE_TICKS) {
                    rampDownSince.set(t.hostname, held);
                    if (CONTROLLER_DEBUG) {
                        dbg(
                            `  ramp-hold ${t.hostname} locked=${ns.format.ram(lockedCost)} ` +
                            `cap=${ns.format.ram(capacity)} n=${held}`
                        );
                    }
                } else {
                    rampDownSince.delete(t.hostname);
                    // Per-batch cap also bounds the ramp: a ramped plan too big
                    // to ever fire is worse than a smaller one that flows.
                    ramped = maximizeHackPct(ns, t, player, Math.min(capacity / conc, perBatchCap), t.f);
                    if (ramped) rampPlan.set(t.hostname, ramped);
                }
            } else {
                rampDownSince.delete(t.hostname); // capacity back within band → deficit over
            }
            if (!ramped) { allAtMax = false; break; }
            a.plan = { ...t, ...ramped, score: t.score }; // keep base score for rank
            const rampedCost = conc * ramped.ramPerBatch;
            used += rampedCost - a.baseCost; // base already counted in Pass A
            // Clamp at 0: a locked incumbent plan may sit up to +RAMP_HYSTERESIS_FRAC
            // above its capacity (allowed — the headroom absorbs it), but letting the
            // negative propagate would silently shrink the NEXT target's capacity below
            // its base cost and break its ramp for no reason.
            excess = Math.max(0, capacity - rampedCost);
            if (ramped.f < HACK_PCT_RAMP_MAX - 1e-9) allAtMax = false;
        }
        // Saturated only when every placeable target is admitted (none RAM-starved),
        // all are at the cap, and budget still remains — then the rest is true surplus.
        const allPlaced = admitted.length === Math.min(eligible.length, MAX_BATCH_TARGETS);
        saturated = allAtMax && excess > 0 && allPlaced && admitted.length > 0;
    }

    // Transient overshoot is allowed (a held locked plan is counted at its real
    // cost), but it must be brief — chronic OVERBUDGET means the ramp-down damping
    // is not converging and the capacity feed is still unstable. Locked plans
    // legitimately sit up to +RAMP_HYSTERESIS_FRAC over their capacity, so a
    // sub-1% steady overshoot is normal — only log past 5%, where it's signal.
    if (CONTROLLER_DEBUG && used > budget * 1.05) {
        dbg(`  OVERBUDGET reserved=${ns.format.ram(used)} budget=${ns.format.ram(budget)}`);
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
 * DEPTH is derived from the STABLE prepped-snapshot weaken time carried in the plan
 * (`t.weakenTime`, min security), so the pipeline target stays constant and never
 * overfills on a transient security bump. LANDING TIMES, however, use FRESH live
 * op-times (current security) so each op lands exactly on its slot regardless of
 * security — see fireBatch. (An earlier version scheduled with the prepped plan
 * times too; whenever the live server sat above min that delayed each weaken ~4× more
 * than its hack, so counter-weakens fell behind and the grid ran away. Live times
 * match booster's proven scheduler.) Validated in an isolated rig at full depth:
 * +0.00 security, ~2ms landing error, ~full throughput indefinitely.
 */
function batchPhase(ns, eligible, pool, rootedHosts) {
    const now = Date.now();

    for (const t of eligible) {
        const target = t.hostname;
        const ramPerBatch = t.ramPerBatch;

        // Depth comes from the STABLE plan weaken time (prepped, min security) so the
        // pipeline target doesn't wobble as live security oscillates. Lag is governed
        // by MAX_BATCH_TARGETS (number of targets), not per-target depth.
        const depth = Math.ceil(t.weakenTime / BATCH_PERIOD);

        // LANDING math uses LIVE op-times (current security), NOT the prepped plan
        // times. An op lands at base + (actualTime − scheduledTime); if we scheduled
        // with the min-security plan times while the server sits even slightly above
        // min, weaken (4× hack's duration) is delayed ~4× more than its paired hack,
        // so the counter-weaken falls behind, security creeps, and the grid runs away
        // (observed: money draining at sec 0, or sec spiking to +3 at full money).
        // Reading live times here keeps each op on its slot regardless of security —
        // this matches booster's proven scheduler.
        //
        // SECURITY-PHASE DEFERRAL (the central limit-cycle fix, mirrored from
        // booster). An op's duration is fixed when the WORKER calls
        // ns.hack/grow/weaken — about one engine tick AFTER this exec — but the
        // landing delays are computed from op-times read NOW. If security changes in
        // that gap (the grid's 100ms G→W2 hot window), the real duration differs
        // from the estimate by seconds, the ops land off-slot, and the error
        // self-sustains. Never fire while the target reads above min security; the
        // scheduler is self-pacing, so the slot is not lost and a cold phase comes
        // every BATCH_PERIOD. The landing clock never stalls: lastLand keeps advancing.
        const secNow = ns.getServerSecurityLevel(target);
        const hot = secNow > t.minSecurity * (1 + SEC_MARGIN);

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
        // this tick. f-UP needs no kill (old small + new big drains safely). Rare,
        // because RAMP_HYSTERESIS_FRAC keeps f from wobbling.
        //
        // PERSISTENCE GATE: the drop must hold for REANCHOR_STABLE_TICKS consecutive
        // ticks before the kill fires. When the waterfall's leftover budget whipsaws
        // (upstream locked plans kept on hot ticks, re-minted on cold ones), f can
        // flip between two values every other tick — the instant kill then massacred
        // the pipeline every ~20 ticks forever. While the drop is pending, pipe.f is
        // deliberately NOT updated: it stays anchored at the in-flight generation's f
        // so a genuine sustained drop keeps counting up, while a flap back to the old
        // f resets the count (and the massacre never happens).
        if (pipe.committed.length > 0 && t.f < pipe.f * (1 - REANCHOR_DROP_FRAC)) {
            pipe.reanchorTicks = (pipe.reanchorTicks ?? 0) + 1;
            if (pipe.reanchorTicks >= REANCHOR_STABLE_TICKS) {
                const killed = killWorkersFor(ns, rootedHosts, target);
                if (CONTROLLER_DEBUG) {
                    dbg(`  batch ${target} REANCHOR f ${Math.round(pipe.f * 100)}%->${Math.round(t.f * 100)}% killed=${killed}`);
                }
                pipe.committed = [];
                pipe.lastLand = 0;
                pipe.reanchorTicks = 0;
                pipe.f = t.f;
            }
        } else {
            pipe.reanchorTicks = 0;
            pipe.f = t.f;
        }

        // Drop landings that have already passed; what remains is the live depth.
        pipe.committed = pipe.committed.filter((land) => land > now);

        // Top up to depth. Each new batch lands one BATCH_PERIOD after the last committed one,
        // or a fresh weaken-time + safety ahead if the pipeline drained. A momentarily
        // full pool just defers the rest to a later tick (no skipped slots).
        let k = 0;
        let deferred = false;
        // Gate each fire on PLACEABLE threads (whole threads per host), not raw free
        // RAM: fragmented slivers below one thread inflate poolFree and would let a
        // batch half-fire. Sized at weakenRam (1.75) for all four ops — hack threads
        // are 1.70, so this is marginally conservative, never optimistic.
        const threadsPerBatch = t.h + t.g + t.w1 + t.w2;
        while (!hot && pipe.committed.length < depth && k < MAX_FIRES_PER_TICK) {
            if (placeableThreads(pool, WORKER_RAM.weakenRam) < threadsPerBatch) { deferred = true; break; }
            const land = Math.max(now + weakenTime + BATCH_SAFETY_MS, pipe.lastLand + BATCH_PERIOD);
            fireBatch(ns, pool, t, land, now, hackTime, growTime, weakenTime);
            pipe.committed.push(land);
            pipe.lastLand = land;
            k++;
        }

        // FIRE-HOT: a refill was wanted but the target read above min security (see
        // the security-phase deferral above). Expected occasionally (the hot window
        // is ~100ms of every BATCH_PERIOD); chronic FIRE-HOT with rising secOver
        // means the grid itself is unhealthy.
        if (CONTROLLER_DEBUG && hot && pipe.committed.length < depth) {
            dbg(
                `  batch ${target} FIRE-HOT sec=+${(secNow - t.minSecurity).toFixed(2)} ` +
                `fill=${pipe.committed.length}/${depth}`
            );
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

    // Landing telemetry: tag every Nth batch so its workers report actual landings
    // (0 GB port write). exp(offset) is the op's expected landing on the grid; 0
    // disables reporting in the worker. Debug-gated so a quiet build stays silent.
    const sample = CONTROLLER_DEBUG && ++telemetrySeq % TELEMETRY_SAMPLE === 0;
    const exp = (offset) => (sample ? base + offset : 0);

    const ph = placeThreads(ns, pool, HACK_WORKER, WORKER_RAM.hackRam, t.h, target, addH, exp(-D_GAP), "H");
    const pw1 = placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, t.w1, target, addW1, exp(0), "W1");
    const pg = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, t.g, target, addG, exp(D_GAP), "G");
    const pw2 = placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, t.w2, target, addW2, exp(2 * D_GAP), "W2");
    // The placeableThreads gate should make a shortfall impossible; if one ever shows
    // up here it means the gate math and reality disagree — worth a debug line.
    if (CONTROLLER_DEBUG && (ph < t.h || pg < t.g || pw1 < t.w1 || pw2 < t.w2)) {
        dbg(
            `  batch ${target} HALF-FIRE h=${ph}/${t.h} w1=${pw1}/${t.w1} ` +
            `g=${pg}/${t.g} w2=${pw2}/${t.w2}`
        );
    }
}

// ── Prep phase ──────────────────────────────────────────────────────────────

/**
 * Drive needs-prep targets toward baseline (min security, max money), most
 * valuable first, one corrective wave per target at a time (skip targets that
 * already have workers in flight).
 */
function prepPhase(ns, needsPrep, pool, inFlight, player, prepFloor = 0, refillHeadroom = 0) {
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
        prepWave(ns, t, pool, player, poolFree(pool) - prepStop);
    }
}

/**
 * Fire one COMBINED corrective wave for a target — weaken and grow overlapped via
 * additionalMsec (the same landing-order technique fireBatch uses):
 *  - W1 (delay 0) lands first at weakenTime, taking security to min;
 *  - G  (delay weakenTime − growTime + D_GAP) lands D_GAP after W1, growing at the
 *    just-restored min security;
 *  - W2 (delay 2·D_GAP) lands D_GAP after G, countering grow's security rise.
 * The old serial version fired the weaken, waited the full weaken time for it to
 * drain (prepPhase skips targets with workers in flight), and only then fired the
 * grow — ~2× weakenTime per prep. The combined wave drains in one weakenTime.
 * Grow threads are Formulas-exact for where the grow LANDS: computed against the
 * live snapshot with security forced to min when a weaken flies ahead of it,
 * over-provisioned by ORBITER_THREAD_MARGIN (same cushion as batching).
 *
 * `ramBudget` caps the RAM this single wave may consume so one large grow can't
 * blow past the prep floor (and into the batchers' reserved RAM). If the weaken
 * doesn't fully fit, the grow is NOT fired (it would land on still-elevated
 * security); the wave makes partial progress and finishes on later ticks.
 */
function prepWave(ns, t, pool, player, ramBudget = Infinity) {
    const target = t.hostname;
    let remaining = ramBudget;

    let weakenPlaced = 0;
    if (t.sec > t.minSecurity * (1 + SEC_MARGIN)) {
        const need = Math.ceil((t.sec - t.minSecurity) / WEAKEN_SEC * ORBITER_THREAD_MARGIN);
        const capped = Math.min(need, Math.floor(remaining / WORKER_RAM.weakenRam));
        weakenPlaced = placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, capped, target, 0);
        // Partial weaken (budget/pool bound): stop here — a grow landing on
        // still-elevated security wastes threads; retry the rest next tick.
        if (weakenPlaced < need) return;
        remaining -= weakenPlaced * WORKER_RAM.weakenRam;
    }

    if (t.money >= t.maxMoney * (1 - MONEY_EPSILON)) return; // money already full

    // Overlap: when a weaken was just fired, delay the grow to land D_GAP after it
    // (at min security) and the counter-weaken D_GAP after the grow. With no weaken
    // in this wave both fire undelayed, exactly like the old money-only wave.
    const growDelay = weakenPlaced > 0
        ? Math.max(0, ns.getWeakenTime(target) - ns.getGrowTime(target) + D_GAP)
        : 0;
    const w2Delay = weakenPlaced > 0 ? 2 * D_GAP : 0;

    // Formulas-exact growThreads for the state the grow lands on: live money, and min
    // security when this wave's weaken lands first. Cap grow to the remaining budget,
    // leaving a little for the counter-weaken.
    const snap = ns.getServer(target); // live money/security
    if (weakenPlaced > 0) snap.hackDifficulty = snap.minDifficulty;
    let growNeed = Math.ceil(ns.formulas.hacking.growThreads(snap, player, t.maxMoney) * ORBITER_THREAD_MARGIN);
    growNeed = Math.min(growNeed, Math.floor((remaining * 0.9) / WORKER_RAM.growRam));
    const placed = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, growNeed, target, growDelay);
    if (placed > 0) {
        const counter = Math.ceil((placed * GROW_SEC) / WEAKEN_SEC * ORBITER_THREAD_MARGIN);
        placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, counter, target, w2Delay);
    }
}

// ── Thread placement ────────────────────────────────────────────────────────

/**
 * Greedily place up to `threads` worker instances across the pool, largest free
 * host first. Mutates pool free RAM. Returns the number of threads actually
 * placed (may be less than requested if RAM runs out).
 */
function placeThreads(ns, pool, script, ramPerThread, threads, target, delay, expLand = 0, opTag = "") {
    let remaining = threads;
    for (const server of pool) {
        if (remaining <= 0) break;
        const fit = Math.floor(server.free / ramPerThread);
        const n = Math.min(fit, remaining);
        if (n <= 0) continue;
        // Trailing args are the landing-telemetry contract (see workers/*.js):
        // expLand > 0 makes the worker report [opTag, target, expLand, actual, ret, n].
        ns.exec(script, server.host, n, target, delay, batchSeq++, expLand, opTag, n);
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

// ── Scoring (Formulas-exact) ─────────────────────────────────────────────────

/**
 * Return the locked BASE plan (score-optimal, un-ramped) for a target, recomputing it
 * (Formulas-exact) only when the hacking `level` differs from the cached plan's stamp.
 * This is the cost lock: between level-ups it returns the cached plan with zero NS
 * calls, instead of re-sweeping the hack-% table for every batcher every tick. The
 * recompute is exact, so a level change just re-balances h/g with no drift/re-prep.
 * On a recompute the sticky ramp plan is dropped so the waterfall re-ramps from the
 * fresh base next admission.
 */
function lockedPlan(ns, s, player, level) {
    const cached = batchPlan.get(s.hostname);
    if (cached && cached.level === level) return cached;
    const best = bestHackPct(ns, s, player);
    if (best) {
        best.level = level;
        batchPlan.set(s.hostname, best);
        rampPlan.delete(s.hostname); // base changed → waterfall re-ramps fresh
    }
    return best;
}

/** Build a HYPOTHETICAL prepped Server snapshot — the target at min security and
 *  max money — so the Formulas calls return the exact baseline numbers a batch
 *  will actually see, regardless of the server's live state. This is the whole
 *  reason orbiter needs no prep-before-plan and never drifts on a level-up. */
function preppedSnapshot(ns, host) {
    const snap = ns.getServer(host);
    snap.hackDifficulty = snap.minDifficulty; // baseline security
    snap.moneyAvailable = snap.moneyMax;      // baseline money
    return snap;
}

/**
 * Build a per-target plan factory. Resolves the f-independent Formulas baseline once
 * (hack-per-thread, op-times, chance, maxMoney) from a prepped snapshot + the live
 * Player, then returns `atF(f)` which costs a single HWGW batch at hack-fraction `f`.
 * Both bestHackPct (sweep up for best $/GB/s) and maximizeHackPct (sweep down for the
 * highest f that fits) share this so neither re-resolves the baseline per candidate.
 *
 * Formulas-exact: thread counts and op-times are correct even when the live server is
 * off baseline and stay correct as the hacking level rises. Grow + the counter-weakens
 * are over-provisioned by ORBITER_THREAD_MARGIN: growThreads is exact for a single batch
 * starting at maxMoney*(1-f), but a deep rolling pipeline (depth = weakenTime/BATCH_PERIOD,
 * hundreds on big servers) lands each grow on the money the PREVIOUS grow left, so any
 * sub-thread shortfall compounds geometrically and ratchets money down to the (1-f) hack
 * floor (observed: zb-def/4sigma pinned at ~0.25). The slight over-grow clamps harmlessly
 * at max and breaks that ratchet. Hack threads stay exact. Returns null if hackPercent is 0.
 */
function buildPlanner(ns, server, player) {
    const snap = preppedSnapshot(ns, server.hostname);
    const fm = ns.formulas.hacking;

    const hackFrac = fm.hackPercent(snap, player); // fraction stolen per thread
    if (hackFrac <= 0) return null;

    const chance = fm.hackChance(snap, player);
    const weakenTime = fm.weakenTime(snap, player);
    const growTime = fm.growTime(snap, player);
    const hackTime = fm.hackTime(snap, player);
    const maxMoney = snap.moneyMax;

    const atF = (f) => {
        const h = Math.ceil(f / hackFrac);
        // h is rounded UP, so the batch actually steals h*hackFrac, which can exceed the
        // requested f — negligibly on big servers (tiny per-thread hackFrac) but badly on a
        // small/high-level server where one thread steals a large chunk (e.g. f=0.75 but
        // h*hackFrac≈0.80). Size the grow to the ACTUAL post-hack money, not maxMoney*(1−f):
        // sizing it to f under-restores by the rounding gap, and the rolling pipeline lands
        // each grow on what the last left, pinning money at a fixed point below max
        // (foodnstuff at ~0.815) that trips the keep-test into an endless drop/re-prep churn.
        // Cap the steal at the full-drain floor (one thread can steal ≥100%).
        const actualF = Math.min(h * hackFrac, 1 - 1 / maxMoney);
        snap.moneyAvailable = maxMoney * (1 - actualF);
        const g = Math.ceil(fm.growThreads(snap, player, maxMoney) * ORBITER_THREAD_MARGIN);
        const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC * ORBITER_THREAD_MARGIN); // counter hack sec
        const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC * ORBITER_THREAD_MARGIN); // counter grow sec
        const ramPerBatch =
            h * WORKER_RAM.hackRam + g * WORKER_RAM.growRam + (w1 + w2) * WORKER_RAM.weakenRam;
        const moneyPerBatch = maxMoney * f * chance;
        const score = moneyPerBatch / (weakenTime * ramPerBatch);
        // Telemetry references: `steal` = expected $ per successful hack from a FULL
        // server (drainTelemetry's HACK-LOW baseline); `growMult` = the restore
        // multiplier g was sized for. Formulas-exact (prepped snapshot), so unlike
        // booster's these cannot be security-skewed at plan time.
        const steal = maxMoney * actualF;
        const growMult = 1 / (1 - actualF);
        return { f, h, g, w1, w2, ramPerBatch, weakenTime, growTime, hackTime, chance, score, steal, growMult };
    };
    return { atF };
}

/**
 * Sweep hack fractions HACK_PCT_MIN..HACK_PCT_RAMP_MAX and return the score-optimal
 * ($/GB/s) plan whose single-batch RAM is ≤ `ramCap`. With the default (Infinity) this
 * is the global optimum (the base plan). With a finite cap it's the best batch that
 * *fits* — used to step the hack-% down on a small pool so a target can still batch.
 * Returns null if hackPercent is 0 or no batch fits the cap.
 */
function bestHackPct(ns, server, player, ramCap = Infinity) {
    const p = buildPlanner(ns, server, player);
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
function maximizeHackPct(ns, server, player, ramCapPerBatch, minF) {
    const p = buildPlanner(ns, server, player);
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
 * Build the status snapshot consumed by BOTH views — the tail window (via
 * lib/tail-ui.js) and dashboard.js (via the status bus) — as a plain JSON-able
 * object. `allEligible` is classify's full ranked list (batching AND prepped-but-
 * idle targets that lost out on RAM this tick); `batchers` is the admitted subset
 * actually running. Each target is tagged `isBatching` so the dashboard can colour
 * idle (blue) rows differently from active ones (green/amber). Reuses pure helpers
 * (displayHealth, expectedIncome, poolFree) and module state (pipelines,
 * rampSaturated, shareThreads), so it adds no NS calls beyond the cheap
 * getHackingLevel already in the RAM budget. `stage` labels which controller is
 * live; `tickGap` is the engine-lag signal.
 */
function buildSnapshot(ns, stage, servers, pool, allEligible, batchers, needsPrep, player, tickGap) {
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
    // work: take the highest-maxMoney prep candidates (free proxy; a server outside the
    // top-20 by maxMoney won't out-earn one inside it) and preview only those. The
    // preview plan is THROWAWAY — bestHackPct never writes batchPlan/rampPlan, so the
    // real admission caches are untouched.
    const prepRanked = [...needsPrep].sort((a, b) => b.maxMoney - a.maxMoney).slice(0, 20);
    for (const t of prepRanked) {
        const preview = bestHackPct(ns, t, player);
        rows.push({
            host: t.hostname, moneyFrac: t.money / t.maxMoney, secOver: t.sec - t.minSecurity,
            f: 0, committed: 0, depth: 0,
            income: preview ? expectedIncome({ ...t, ...preview }) : 0,
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
        prepCount: needsPrep.length, // total servers still needing prep (tail header)
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

/** Strip a leading slash so script paths compare consistently. */
function stripSlash(path) {
    return path.startsWith("/") ? path.slice(1) : path;
}
