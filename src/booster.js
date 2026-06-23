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
    DRIFT_GRACE_MS,
    HACK_PCT_MIN,
    HACK_PCT_MAX,
    HACK_PCT_STEP,
    HACK_PCT_RAMP_MAX,
    RAMP_STEP,
    RAMP_UTIL_LOW,
    RAMP_UTIL_HIGH,
    RAMP_BUDGET_MIN,
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
    THREAD_MARGIN,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
    BATCH_BUDGET_FRAC,
    MAX_FIRES_PER_TICK,
    MAX_BATCH_TARGETS,
    SELECT_KEEP_BIAS,
    PREP_LOOKAHEAD,
    D_GAP,
    BATCH_PERIOD,
    BATCH_SAFETY_MS,
    BOOSTER_DEBUG,
    BOOSTER_DEBUG_LOG,
    CONTRACTS_MANAGER,
    PSERVER_MANAGER,
    HACKNET_MANAGER,
    CONTRACTS_MANAGER_RAM,
    PSERVER_MANAGER_RAM,
    HACKNET_MANAGER_RAM,
    PSERVER_PREFIX,
    HACKNET_GATE,
} from "/config/constants.js";

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
 *  1. contracts — solves coding contracts for free money/rep; trivial cost, no
 *     prerequisites (network is rooted), so it leads the order. Gate always true.
 *  2. pserver — grows the RAM pool; launch immediately (it waits internally to
 *     afford). Highest compounding ROI: purchased servers feed the batch pool.
 *  3. hacknet — weak ROI; deferred until the pserver fleet is fully built (counted
 *     from topology data booster already has — no extra NS call).
 */
const MANAGERS = [
    { file: CONTRACTS_MANAGER, ramGB: CONTRACTS_MANAGER_RAM, gate: () => true },
    { file: PSERVER_MANAGER, ramGB: PSERVER_MANAGER_RAM, gate: () => true },
    { file: HACKNET_MANAGER, ramGB: HACKNET_MANAGER_RAM, gate: pserverFleetBuilt },
];

/**
 * Manager filenames booster has seen running during THIS run (in-memory, cleared on a
 * fresh booster start). A manager that was seen running and is now gone was either
 * stopped by the user or self-killed because it had nothing left worth buying — booster
 * will not relaunch it for the rest of this run. A fresh booster start (e.g. after an
 * aug install, which wipes pservers/hacknet nodes) clears the set, so the managers
 * relaunch and rebuild. See launchManagers.
 */
const launchedManagers = new Set();

/** Monotonic id appended to every worker exec so concurrent workers are unique. */
let batchSeq = 0;

/** Hosts we've already copied the workers onto this run (avoid re-scp each tick). */
const provisioned = new Set();

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
 * Locked batch plan per batching target: the bestHackPct result captured when the
 * target was admitted. Reused every tick while batching (never recomputed) so the
 * HWGW grid shape and its RAM footprint stay constant — recomputing each tick
 * desyncs the in-flight grid and wobbles the admission estimate, causing flap.
 * Deleted when a target drifts out and must re-prep. host -> bestHackPct result.
 */
const batchPlan = new Map();

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

/**
 * Global hack-% ramp floor (idle-RAM absorber). Sticky across ticks; moves at
 * most one RAMP_STEP per tick under the controller in main(). Each batching plan
 * is computed at max(score-optimal f, rampLevel) capped at HACK_PCT_RAMP_MAX, so
 * raising it pulls low-% targets up to spend otherwise-idle pool RAM. 0 = off
 * (pure $/GB/s efficiency). See the "Hack-% ramp-up" block in constants.js.
 */
let rampLevel = 0;

/** Active share-worker thread count and manual-pause state, for the status line.
 *  Updated by sharePhase each tick. */
let shareThreads = 0;
let shareOff = false;

/** Diagnostic log buffer (flushed once per tick) and a monotonic tick counter so
 *  log lines from the same tick can be grouped. See BOOSTER_DEBUG in constants. */
let debugBuf = [];
let tickNo = 0;
/** Buffer one diagnostic line for this tick (no-op unless BOOSTER_DEBUG). */
function dbg(line) {
    if (BOOSTER_DEBUG) debugBuf.push(line);
}
/** Append this tick's buffered diagnostic lines to the log file and clear. */
function flushDebug(ns) {
    if (BOOSTER_DEBUG && debugBuf.length > 0) {
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
    ns.ui.openTail();

    // Prerequisite check: all workers (HWGW + share) must exist on home.
    const missing = PLACED_WORKERS.filter((w) => !ns.fileExists(w, "home"));
    if (missing.length > 0) {
        ns.tprint(`ERROR: missing worker script(s): ${missing.join(", ")}`);
        ns.tprint("booster does not create workers. Add them, then re-run.");
        return;
    }

    // Fresh diagnostic log per run (truncate). No-op cost when BOOSTER_DEBUG off.
    if (BOOSTER_DEBUG) {
        ns.write(BOOSTER_DEBUG_LOG, `# booster debug log — ${new Date().toISOString()}\n`, "w");
    }

    // Main control loop. Stage 3a: discover/root + prep.
    // NOTE: stage 5 will restore the Formulas.exe handoff as the loop's exit
    // condition. For now it runs unconditionally so it's testable on saves that
    // already own Formulas.exe.
    while (true) {
        tickNo++;
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
        const { batchers, reserved } = selectBatchers(ns, eligible, poolTotal);

        // Per-tick summary: eligible vs admitted, so a drop is attributable to either
        // classify (host absent from `eligible`) or selectBatchers (in `eligible`,
        // absent from `batchers` → budget/cap). dropEligible/dropAdmit logged inside.
        if (BOOSTER_DEBUG) {
            const elig = eligible.map((t) => t.hostname);
            const batched = new Set(batchers.map((t) => t.hostname));
            const notAdmitted = elig.filter((h) => !batched.has(h));
            dbg(
                `T${tickNo} elig=${eligible.length} batch=${batchers.length} ` +
                `ramp=${Math.round(rampLevel * 100)}% ` +
                `reserved=${ns.format.ram(reserved)}/${ns.format.ram(poolTotal * BATCH_BUDGET_FRAC)} ` +
                `poolFree=${ns.format.ram(poolFree(pool))}`
            );
            if (notAdmitted.length > 0) dbg(`  selectBatchers excluded: ${notAdmitted.join(", ")}`);
        }

        // Batch the admitted targets first (consumes RAM by rank), then spend
        // whatever's left prepping the next-best targets.
        batchPhase(ns, batchers, pool);

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
        prepPhase(ns, needsPrep, pool, inFlight, prepFloor);

        // Hack-% ramp controller (idle-RAM absorber). Move the global ramp floor
        // at most one step/tick. Two signals must BOTH say "spend more" to ramp up:
        //  - actual POOL UTILIZATION (1 − free/total) below RAMP_UTIL_LOW, and
        //  - admission-BUDGET headroom (1 − reserved/budget) above RAMP_BUDGET_MIN.
        // The budget signal is the key fix for the limit cycle: selectBatchers reserves
        // the full pipeline RAM immediately, but pipelines fill gradually, so actual
        // utilization lags far behind committed budget. Using utilization alone, the
        // ramp read the not-yet-filled RAM as "idle" and kept pushing hack-% up even
        // though the budget was 100% reserved — which can't add throughput, it just
        // grows batches until the marginal target no longer fits and drops out
        // (ramp 40↔42%, batchers 10↔8, every tick). Requiring real budget headroom
        // makes it settle at the highest hack-% where the full admitted set still fits.
        // Ramp DOWN when admission is starved (fewer targets than it could place) or
        // the pool is genuinely near-full. The wide LOW..HIGH deadband and the budget
        // gate together hold it steady. Plans pick up the new floor next tick (classify).
        const poolUsedFrac = poolTotal > 0 ? 1 - poolFree(pool) / poolTotal : 1;
        const budget = poolTotal * BATCH_BUDGET_FRAC;
        const budgetHeadroom = budget > 0 ? 1 - reserved / budget : 0;
        // "All batching" means admission placed as many targets as it possibly could
        // given BOTH ceilings — the RAM budget AND MAX_BATCH_TARGETS.
        const allBatching = batchers.length === Math.min(eligible.length, MAX_BATCH_TARGETS);
        if (allBatching && poolUsedFrac < RAMP_UTIL_LOW && budgetHeadroom > RAMP_BUDGET_MIN) {
            rampLevel = Math.min(HACK_PCT_RAMP_MAX, rampLevel + RAMP_STEP);
        } else if (!allBatching || poolUsedFrac > RAMP_UTIL_HIGH) {
            rampLevel = Math.max(0, rampLevel - RAMP_STEP);
        }

        // Share phase (idle-RAM → faction reputation). Once rampLevel is maxed and
        // prep is clear, the free RAM still left over beyond the reserved
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

        // Remember this tick's admitted set for next tick's admission hysteresis.
        wasBatching.clear();
        for (const t of batchers) wasBatching.add(t.hostname);

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
        if (rooted && !provisioned.has(host)) {
            provisionWorkers(ns, host); // copy workers once per host
            provisioned.add(host);
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

// ── Manager orchestration ───────────────────────────────────────────────────

/**
 * Launch managers in fixed dependency order. Each tick, find the FIRST manager that is
 * not running and hasn't already been accounted for this run, and if its gate passes,
 * exec it. A later manager is never launched until every earlier one is accounted for,
 * which makes the order "fixed." Checks ns.ps("home") (not just in-memory state) so a
 * booster restart never double-launches a persistent manager.
 *
 * In-memory `launchedManagers` suppresses relaunch: a manager booster saw running that
 * is now gone was either stopped by the user or self-killed (nothing worth buying), so
 * it stays down for the rest of this booster run. A fresh booster start clears the set,
 * so the managers relaunch (and, after an aug install that wipes their infra, rebuild).
 * A suppressed manager is treated as "accounted for" so the loop moves past it to later
 * managers (e.g. hacknet still launches after pserver finishes).
 */
function launchManagers(ns, servers) {
    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) {
            launchedManagers.add(m.file); // remember it's up so a later kill is detectable
            dbg(`  mgr ${m.file}: running`);
            continue;
        }
        if (launchedManagers.has(m.file)) {
            dbg(`  mgr ${m.file}: SUPPRESSED (seen running earlier this run, now gone)`);
            continue; // was running, now gone → stopped/done
        }
        const gateOpen = m.gate(servers);
        if (gateOpen) {
            const pid = ns.exec(m.file, "home");
            dbg(`  mgr ${m.file}: gate=open exec pid=${pid}`);
            // Only mark it accounted-for if the exec actually started a process.
            // exec() fails silently (returns 0, no exception) when home doesn't have
            // enough free RAM at that instant — e.g. right after a soft reset, before
            // the reserve has caught up. Without this check, a single failed launch
            // was indistinguishable from "user stopped it" and was never retried.
            if (pid !== 0) {
                launchedManagers.add(m.file);
            } else {
                ns.print(`WARN: failed to launch ${m.file} (insufficient RAM on home?) — will retry`);
            }
        } else {
            dbg(`  mgr ${m.file}: gate=closed`);
        }
        return; // first pending manager is the only candidate this tick
    }
}

/** RAM to reserve on home for the next pending manager, GB. Skips managers that are
 *  running or already accounted for (stopped/done) — none of those will be (re)launched,
 *  so reserving for them would needlessly shrink the worker pool. */
function nextManagerReserve(ns) {
    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) continue;
        if (launchedManagers.has(m.file)) continue;
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
            // Drift grace: keep batching through a brief unhealthy blip (a
            // bump-fired batch landing late self-heals in a few seconds); only
            // drop to re-prep once unhealthy continuously past DRIFT_GRACE_MS.
            let keep = healthy;
            if (healthy) {
                unhealthySince.delete(s.hostname);
            } else {
                const since = unhealthySince.get(s.hostname) ?? now;
                unhealthySince.set(s.hostname, since);
                keep = now - since < DRIFT_GRACE_MS;
            }
            if (keep) {
                // Reuse the locked plan (don't re-optimise mid-pipeline) UNLESS
                // the global ramp floor has moved since it was locked — then the
                // target's hack-% target changed and the plan must be recomputed.
                const locked = batchPlan.get(s.hostname);
                const best = locked && locked.ramp === rampLevel
                    ? locked
                    : bestHackPct(ns, s, chance, Infinity, rampLevel);
                if (best) {
                    best.ramp = rampLevel;
                    batchPlan.set(s.hostname, best);
                    eligible.push({ ...s, chance, sec, money, ...best });
                    continue;
                }
            }
            // Drifted out → drop to re-prep below.
            dbg(
                `  classify DROP ${s.hostname}: moneyFrac=${moneyFrac.toFixed(3)} ` +
                `(keep≥${BATCH_KEEP_MONEY_FRAC}) secOver=${secOver.toFixed(2)} ` +
                `(keep≤${(s.minSecurity * BATCH_KEEP_SEC_FRAC).toFixed(2)}) ` +
                `graceMs=${now - (unhealthySince.get(s.hostname) ?? now)}`
            );
            unhealthySince.delete(s.hostname); // clear grace state
            activeBatching.delete(s.hostname);
            batchPlan.delete(s.hostname); // recompute a fresh plan on re-admission
            pipelines.delete(s.hostname); // re-anchor the pipeline on re-admission
        }

        // Not batching: STRICT prepped check to start (ensures table accuracy).
        if (!isPrepped(s, sec, money)) {
            needsPrep.push({ ...s, sec, money });
            continue;
        }
        const chance = ns.hackAnalyzeChance(s.hostname);
        const best = bestHackPct(ns, s, chance, Infinity, rampLevel);
        if (best) {
            best.ramp = rampLevel;
            activeBatching.add(s.hostname);
            batchPlan.set(s.hostname, best); // lock the plan (+ ramp) for this run
            eligible.push({ ...s, chance, sec, money, ...best });
            dbg(`  classify ADMIT-NEW ${s.hostname} (was re-prepped or fresh)`);
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
 * Admission control + depth-first RAM allocation. Walks the prepped, eligible
 * targets in rank order and gives each, greedily, the RAM it can use before moving
 * to the next — so the best target is filled toward its full pipeline before a
 * lower-ranked one starts. The rest idle (prepped, zero RAM cost since un-hacked).
 *
 * Per target, given the `remaining` budget:
 *  - if a single *optimal* batch fits, use the locked optimal plan (`t`) — stable,
 *    the normal big-pool path;
 *  - else step the hack-% DOWN to the best batch that fits `remaining`
 *    (`bestHackPct(..., remaining)`), so a small early pool can still batch;
 *  - reserve `min(full pipeline, remaining)`. A stepped-down target therefore
 *    claims the *whole* remaining budget (the next target waits) and runs a shallow
 *    pipeline that batchPhase deepens automatically as free RAM grows. As the pool
 *    grows the hack-% climbs back to optimal, then depth fills, then the pipeline
 *    completes and the leftover budget overflows to the next-best target.
 *
 * Hysteresis: admission walks targets in score order, but an incumbent (last tick's
 * batcher) gets a SELECT_KEEP_BIAS score bonus for ordering only — so a marginally
 * higher newcomer can't evict a running pipeline, while a clearly higher one still
 * can. (An earlier two-pass "all incumbents first, then newcomers" rule let a
 * low-score squatter like n00dles, admitted early, hold a capped slot forever and
 * lock out higher-value servers — the set could never improve.) Two ceilings: the
 * RAM budget (early, RAM-limited) and MAX_BATCH_TARGETS (late, lag-limited);
 * whichever binds first wins.
 */
function selectBatchers(ns, eligible, poolTotal) {
    const budget = poolTotal * BATCH_BUDGET_FRAC;
    // Reserve the same full-pipeline depth batchPhase actually runs, so the estimate
    // matches real usage (a mismatch here would over- or under-reserve the budget).
    const concurrency = (t) => Math.ceil(t.weakenTime / BATCH_PERIOD);

    // Order by score, giving incumbents a small bonus (anti-flap, anti-squat).
    const effScore = (t) => t.score * (wasBatching.has(t.hostname) ? 1 + SELECT_KEEP_BIAS : 1);
    const order = [...eligible].sort((a, b) => effScore(b) - effScore(a));

    const admitted = [];
    let used = 0;
    for (const t of order) {
        if (admitted.length >= MAX_BATCH_TARGETS) break;
        const remaining = budget - used;

        let entry, ramPerBatch;
        if (remaining >= t.ramPerBatch) {
            entry = t; // optimal batch fits → use the locked optimal plan
            ramPerBatch = t.ramPerBatch;
        } else {
            const fitted = bestHackPct(ns, t, t.chance, remaining); // step down
            if (!fitted) continue; // not even the smallest batch fits → try the next
            entry = { ...t, ...fitted, score: t.score }; // keep optimal score for rank
            ramPerBatch = fitted.ramPerBatch;
        }

        used += Math.min(concurrency(t) * ramPerBatch, remaining);
        admitted.push(entry);
    }

    admitted.sort((a, b) => b.score - a.score); // restore global rank order
    return { batchers: admitted, reserved: used };
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
function batchPhase(ns, eligible, pool) {
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
            pipe = { committed: [], lastLand: 0, depth };
            pipelines.set(target, pipe);
        }
        pipe.depth = depth;

        // Drop landings that have already passed; what remains is the live depth.
        pipe.committed = pipe.committed.filter((land) => land > now);

        // Top up to depth. Each new batch lands one BATCH_PERIOD after the last committed one,
        // or a fresh weaken-time + safety ahead if the pipeline drained. A momentarily
        // full pool just defers the rest to a later tick (no skipped slots).
        let k = 0;
        while (pipe.committed.length < depth && k < MAX_FIRES_PER_TICK) {
            if (ramPerBatch > poolFree(pool)) break;
            const land = Math.max(now + weakenTime + BATCH_SAFETY_MS, pipe.lastLand + BATCH_PERIOD);
            fireBatch(ns, pool, t, land, now, hackTime, growTime, weakenTime);
            pipe.committed.push(land);
            pipe.lastLand = land;
            k++;
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
function prepPhase(ns, needsPrep, pool, inFlight, prepFloor = 0) {
    // Breadth guard: when the batch cap is active, don't prep more servers than
    // could earn a slot soon (cap + lookahead). needsPrep is easiest-first, so
    // this preps the cheapest candidates. Inert when MAX_BATCH_TARGETS is large.
    const prepBudget = MAX_BATCH_TARGETS + PREP_LOOKAHEAD;
    let considered = 0;
    for (const t of needsPrep) {
        if (considered >= prepBudget) break;
        considered++;
        // Stop once free RAM hits the batchers' reserved-but-unclaimed floor —
        // that RAM belongs to ramping pipelines, not prep.
        if (poolFree(pool) <= prepFloor) break;
        if ((inFlight.get(t.hostname) ?? 0) > 0) continue; // wave already running
        prepWave(ns, t, pool, poolFree(pool) - prepFloor);
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
 *  - paused if the manual SHARE_OFF_FLAG file exists (free fileExists read);
 *  - otherwise only once the hack-% ramp is maxed AND prep is clear, i.e. every
 *    target is hacking as hard as we allow and the pool still has idle RAM.
 * Spends SHARE_BUDGET_FRAC of the residual (free RAM beyond the reserved
 * prep/jitter headroom). Tops the share-thread count up to target each tick with
 * single-shot 10s workers; when demand returns it launches fewer and the running
 * workers free their RAM within ~10s, so no kill is needed. Updates the display
 * vars (shareThreads / shareOff).
 */
function sharePhase(ns, pool, poolTotal, needsPrep, rootedHosts) {
    // Paused when the flag file's content is "1" (set by /utils/share-off.js;
    // share-on.js overwrites it with "0"). ns.read is free RAM and returns "" for a
    // missing file, so the default (no file) reads as on. A content toggle avoids
    // relying on ns.rm to clear the pause.
    shareOff = ns.read(SHARE_OFF_FLAG).trim() === "1";
    if (shareOff) { shareThreads = 0; return; }

    // Gate: only spend surplus that batching/prep provably don't want.
    if (rampLevel < HACK_PCT_RAMP_MAX || needsPrep.length > 0) {
        shareThreads = 0;
        return;
    }

    const residual = poolFree(pool) - poolTotal * (1 - BATCH_BUDGET_FRAC);
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
 * Sweep hack fractions and return the row with the best score ($/GB/s) whose
 * single-batch RAM is ≤ `ramCap`. With the default (Infinity) this is the global
 * optimum. With a finite cap it's the best batch that *fits* — used to step the
 * hack-% down on a small pool so a target can still batch (a single optimal batch
 * may not fit early, when low hacking level makes weakenTime long and batches
 * large). Returns null if not even the smallest (1%) batch fits the cap.
 *
 * The fitted choice is stable tick-to-tick: `chance` is a common factor across all
 * f, so it never changes which f wins — only hackFrac/weakenTime/ramPerBatch (all
 * stable for a given hacking level) and the cap do. All NS calls here are free RAM.
 */
function bestHackPct(ns, server, chance, ramCap = Infinity, floor = 0) {
    const target = server.hostname;
    const hackFrac = ns.hackAnalyze(target);
    if (hackFrac <= 0) return null;

    const weakenTime = ns.getWeakenTime(target);
    let best = null;

    // The ramp floor raises the search's lower bound (spend idle RAM at higher
    // hack-%); HACK_PCT_RAMP_MAX caps the upper bound so no target ever exceeds
    // the share-residual boundary. ramCap (small-pool step-down) is applied per
    // candidate below and wins over the floor — a batch must always fit.
    const lo = Math.max(HACK_PCT_MIN, floor);
    const hi = Math.min(HACK_PCT_MAX, HACK_PCT_RAMP_MAX);
    for (let f = lo; f <= hi + 1e-9; f += HACK_PCT_STEP) {
        const h = Math.ceil(f / hackFrac);
        // Over-provision grow/weaken (not hack) to absorb per-cycle drift.
        const g = Math.ceil(ns.growthAnalyze(target, 1 / (1 - f)) * THREAD_MARGIN);
        const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC * THREAD_MARGIN);
        const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
        const ramPerBatch =
            h * WORKER_RAM.hackRam + g * WORKER_RAM.growRam + (w1 + w2) * WORKER_RAM.weakenRam;
        if (ramPerBatch > ramCap) continue; // batch too big for the available RAM
        const moneyPerBatch = server.maxMoney * f * chance;
        const score = moneyPerBatch / (weakenTime * ramPerBatch);
        if (!best || score > best.score) {
            best = { f, h, g, w1, w2, ramPerBatch, weakenTime, score };
        }
    }
    return best;
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
    const ramp = rampLevel > 0 ? `  |  Ramp ${Math.round(rampLevel * 100)}%` : "";
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
