/**
 * booster.js — early-game bootstrap hacking controller.
 *
 * The cheap "first stage" controller that runs at the start of a BitNode cycle,
 * before Formulas.exe. See docs/devlog/02-booster.md for the full design.
 *
 * BUILD STATUS: Stage 4 — orchestrates the pserver + hacknet managers (gated
 * launch on home, no double-launch) on top of the 3a–3e batcher and status table.
 * Formulas.exe handoff (stage 5) still follows.
 *
 * Prerequisites: the three worker scripts must already exist on home. booster
 * does NOT create them; it errors out and exits if any is missing.
 */

import {
    HACK_WORKER,
    GROW_WORKER,
    WEAKEN_WORKER,
    SERVERS_JSON,
    SEC_MARGIN,
    MONEY_EPSILON,
    BATCH_KEEP_MONEY_FRAC,
    BATCH_KEEP_SEC_OVER,
    RECOVER_MONEY_FRAC,
    RECOVER_SEC_OVER,
    HACK_PCT_MIN,
    HACK_PCT_MAX,
    HACK_PCT_STEP,
    HACK_PCT_RAMP_MAX,
    RAMP_STEP,
    RAMP_UTIL_LOW,
    RAMP_UTIL_HIGH,
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
    THREAD_MARGIN,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
    CHANCE_BATCH,
    BATCH_BUDGET_FRAC,
    MAX_FIRES_PER_TICK,
    MAX_BATCH_TARGETS,
    PREP_LOOKAHEAD,
    D_GAP,
    BATCH_PERIOD,
    BATCH_SAFETY_MS,
    PSERVER_MANAGER,
    HACKNET_MANAGER,
    PSERVER_MANAGER_RAM,
    HACKNET_MANAGER_RAM,
    PSERVER_PREFIX,
    HACKNET_GATE,
} from "/config/constants.js";

/** Worker paths that must exist on home and get copied to every rooted server. */
const WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

/** Normalized worker filenames for matching against ns.ps() output. */
const WORKER_FILES = new Set(WORKERS.map(stripSlash));

/**
 * Managers booster orchestrates, in fixed dependency order. Each tick booster
 * launches the FIRST not-yet-running manager whose gate passes, and won't consider
 * a later one until every earlier one is already running (see launchManagers).
 * `ramGB` (hardcoded in constants) is reserved on home so the exec always fits.
 *
 *  1. pserver — grows the RAM pool; launch immediately (it waits internally to
 *     afford). Highest compounding ROI: purchased servers feed the batch pool.
 *  2. hacknet — weak ROI; deferred until the pserver fleet is fully built (counted
 *     from topology data booster already has — no extra NS call).
 */
const MANAGERS = [
    { file: PSERVER_MANAGER, ramGB: PSERVER_MANAGER_RAM, gate: () => true },
    { file: HACKNET_MANAGER, ramGB: HACKNET_MANAGER_RAM, gate: pserverFleetBuilt },
];

/** Monotonic id appended to every worker exec so concurrent workers are unique. */
let batchSeq = 0;

/** Hosts we've already copied the workers onto this run (avoid re-scp each tick). */
const provisioned = new Set();

/** Per-target launch clock: target -> { nextLaunch } timestamp (ms). */
const clocks = new Map();

/**
 * Per-target recovery cooldown: target -> earliest timestamp (ms) a new recovery
 * wave may fire. A recovery grow takes growTime to land; without this gate
 * maybeRecover re-fires a full deficit-sized grow every tick, stacking many
 * in-flight grows that drain the pool and starve normal batches.
 */
const recoverClock = new Map();

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
 * Global hack-% ramp floor (idle-RAM absorber). Sticky across ticks; moves at
 * most one RAMP_STEP per tick under the controller in main(). Each batching plan
 * is computed at max(score-optimal f, rampLevel) capped at HACK_PCT_RAMP_MAX, so
 * raising it pulls low-% targets up to spend otherwise-idle pool RAM. 0 = off
 * (pure $/GB/s efficiency). See the "Hack-% ramp-up" block in constants.js.
 */
let rampLevel = 0;

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

    // Prerequisite check: all three workers must exist on home.
    const missing = WORKERS.filter((w) => !ns.fileExists(w, "home"));
    if (missing.length > 0) {
        ns.tprint(`ERROR: missing worker script(s): ${missing.join(", ")}`);
        ns.tprint("booster does not create workers. Add them, then re-run.");
        return;
    }

    // Main control loop. Stage 3a: discover/root + prep.
    // NOTE: stage 5 will restore the Formulas.exe handoff as the loop's exit
    // condition. For now it runs unconditionally so it's testable on saves that
    // already own Formulas.exe.
    while (true) {
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
        // at most one step/tick. Signal: actual POOL UTILIZATION (1 − free/total),
        // measured after this tick's batch + prep placements, so it already counts
        // whatever prep is consuming — a one-server prep trickle leaves the pool
        // ~all-free (ramp up), while a fresh-save bootstrap where prep eats the
        // small pool leaves it nearly full (no ramp). Raise the floor while the
        // pool is under-used AND every batch-worthy target already has a slot;
        // lower it when the pool is heavily used or admission is RAM/lag-starved.
        // The wide LOW..HIGH deadband holds it steady through mid-cycle
        // oscillation. Plans pick up the new floor next tick (classify).
        const poolUsedFrac = poolTotal > 0 ? 1 - poolFree(pool) / poolTotal : 1;
        const allBatching = batchers.length === eligible.length;
        if (allBatching && poolUsedFrac < RAMP_UTIL_LOW) {
            rampLevel = Math.min(HACK_PCT_RAMP_MAX, rampLevel + RAMP_STEP);
        } else if (!allBatching || poolUsedFrac > RAMP_UTIL_HIGH) {
            rampLevel = Math.max(0, rampLevel - RAMP_STEP);
        }

        // Share boundary (definition only; sharePhase not built yet). Once
        // rampLevel == HACK_PCT_RAMP_MAX and needsPrep is empty, every target is
        // hacking as hard as we allow, so the free RAM still left over —
        //   residual = poolFree(pool) - poolTotal * (1 - BATCH_BUDGET_FRAC)
        // (free RAM beyond the reserved prep/jitter headroom) — is the genuine
        // share residual. A future sharePhase(ns, pool, residual) would place
        // ns.share() workers there only when residual > 0, recomputed each tick so
        // it yields the instant batch/prep demand (or a ramp-down) reclaims it.

        updateDisplayStats(batchers);
        renderStatus(ns, servers, pool, batchers, needsPrep);

        // Remember this tick's admitted set for next tick's admission hysteresis.
        wasBatching.clear();
        for (const t of batchers) wasBatching.add(t.hostname);

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

        if (host === "home") continue;

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

/** Copy the three workers onto a rooted host so it can run them. */
function provisionWorkers(ns, host) {
    ns.scp(WORKERS, host, "home");
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
    for (const host of rootedHosts.concat("home")) {
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
 * Launch managers in fixed dependency order. Each tick, find the FIRST manager not
 * already running; if its gate passes, exec it. Stop there regardless — a later
 * manager is never launched until every earlier one is already running, which is
 * what makes the order "fixed." Checks ns.ps("home") (not just in-memory state) so
 * a booster restart never double-launches a persistent manager.
 */
function launchManagers(ns, servers) {
    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) continue; // already up → move past it
        if (m.gate(servers)) ns.exec(m.file, "home");
        return; // first not-running manager is the only candidate this tick
    }
}

/** RAM to reserve on home for the next pending (not-yet-running) manager, GB. */
function nextManagerReserve(ns) {
    for (const m of MANAGERS) {
        if (!isRunning(ns, m.file)) return m.ramGB;
    }
    return 0; // all managers running → no reserve needed
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
 *  - `eligible`: prepped + batch-worthy (chance ≥ CHANCE_BATCH), each with its
 *    best hack-% table row attached, sorted by score (most profitable first).
 *  - `needsPrep`: not yet at baseline, sorted by maxMoney (prep value first).
 *
 * The expensive hack-% table is only built for prepped eligible targets (few),
 * never for the whole network.
 */
function classify(ns, servers) {
    const level = ns.getHackingLevel();
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
                secOver <= BATCH_KEEP_SEC_OVER;
            if (healthy) {
                // Reuse the locked plan (don't re-optimise mid-pipeline) UNLESS
                // the global ramp floor has moved since it was locked — then the
                // target's hack-% target changed and the plan must be recomputed.
                const locked = batchPlan.get(s.hostname);
                const best =
                    locked && locked.ramp === rampLevel
                        ? locked
                        : bestHackPct(ns, s, chance, Infinity, rampLevel);
                if (best) {
                    best.ramp = rampLevel;
                    batchPlan.set(s.hostname, best);
                    eligible.push({ ...s, chance, sec, money, ...best });
                    continue;
                }
            }
            activeBatching.delete(s.hostname); // drifted out → re-prep below
            batchPlan.delete(s.hostname); // recompute a fresh plan on re-admission
        }

        // Not batching: STRICT prepped check to start (ensures table accuracy).
        if (!isPrepped(s, sec, money)) {
            needsPrep.push({ ...s, sec, money });
            continue;
        }
        const chance = ns.hackAnalyzeChance(s.hostname);
        if (chance < CHANCE_BATCH) continue; // prepped but not worth batching

        const best = bestHackPct(ns, s, chance, Infinity, rampLevel);
        if (best) {
            best.ramp = rampLevel;
            activeBatching.add(s.hostname);
            batchPlan.set(s.hostname, best); // lock the plan (+ ramp) for this run
            eligible.push({ ...s, chance, sec, money, ...best });
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
 * Hysteresis: last tick's batchers (`wasBatching`) get first claim so the active
 * set doesn't flap. Two ceilings: the RAM budget (early, RAM-limited) and
 * MAX_BATCH_TARGETS (late, lag-limited); whichever binds first wins.
 */
function selectBatchers(ns, eligible, poolTotal) {
    const budget = poolTotal * BATCH_BUDGET_FRAC;
    const concurrency = (t) => Math.ceil(t.weakenTime / BATCH_PERIOD);

    const admitted = [];
    let used = 0;
    // Pass 1 keeps already-batching targets; pass 2 admits new ones with whatever
    // budget is left. Each pass walks `eligible` in its existing rank order.
    for (const keepPass of [true, false]) {
        for (const t of eligible) {
            if (admitted.length >= MAX_BATCH_TARGETS) break;
            if (wasBatching.has(t.hostname) !== keepPass) continue;
            const remaining = budget - used;

            let entry, ramPerBatch;
            if (remaining >= t.ramPerBatch) {
                entry = t; // optimal batch fits → use the locked optimal plan
                ramPerBatch = t.ramPerBatch;
            } else {
                const fitted = bestHackPct(ns, t, t.chance, remaining); // step down
                if (!fitted) continue; // not even the smallest batch fits → skip
                entry = { ...t, ...fitted, score: t.score }; // keep optimal score for rank
                ramPerBatch = fitted.ramPerBatch;
            }

            used += Math.min(concurrency(t) * ramPerBatch, remaining);
            admitted.push(entry);
        }
    }

    admitted.sort((a, b) => b.score - a.score); // restore global rank order
    return { batchers: admitted, reserved: used };
}

// ── Batch phase (rolling HWGW grid scheduler) ───────────────────────────────

/**
 * Launch rolling HWGW batches for each eligible target, in rank order, until
 * RAM runs out. Pipeline depth is regulated by a per-target launch clock that
 * advances by BATCH_PERIOD, so steady-state in-flight ≈ weakenTime/BATCH_PERIOD
 * without needing to count batches.
 */
function batchPhase(ns, eligible, pool) {
    const now = Date.now();

    for (const t of eligible) {
        const target = t.hostname;
        const ramPerBatch = t.ramPerBatch;
        if (ramPerBatch > poolFree(pool)) continue; // can't even fit one batch

        // Fetch ALL three op times fresh and from the same instant. Using the
        // locked plan's stale weakenTime here (while grow/hack are fresh) was the
        // root cause of the high-hack-% desync: as the hacking level climbs the real
        // weaken time shrinks, so a stale (too-large) value makes W1/W2 land earlier
        // than their H/G; once the gap exceeds D_GAP the order flips (W2 before G)
        // and the grow's security is never cleared → runaway security → drift.
        // RAM-free: ns.getWeakenTime is already charged via bestHackPct.
        const weakenTime = ns.getWeakenTime(target);
        const growTime = ns.getGrowTime(target);
        const hackTime = ns.getHackTime(target);

        // Clock setup / re-anchor if it fell more than a full cycle behind.
        let clock = clocks.get(target);
        if (!clock || clock.nextLaunch < now - weakenTime) {
            clock = { nextLaunch: now };
            clocks.set(target, clock);
        }

        // Fire due batches, capped to a few per tick so a clock that fell behind
        // refills gradually instead of dumping its whole pipeline at once.
        const maxFires = Math.min(MAX_FIRES_PER_TICK, Math.ceil(weakenTime / BATCH_PERIOD));
        let k = 0;
        while (
            clock.nextLaunch <= now &&
            k < maxFires &&
            ramPerBatch <= poolFree(pool)
        ) {
            const base = now + weakenTime + k * BATCH_PERIOD + BATCH_SAFETY_MS;
            fireBatch(ns, pool, t, base, now, hackTime, growTime, weakenTime);
            clock.nextLaunch += BATCH_PERIOD;
            k++;
        }

        // Pull the target back to baseline if it has drifted below max (the
        // batch alone maintains but never recovers lost ground).
        maybeRecover(ns, t, pool, growTime);
    }
}

/**
 * Supplemental correction for a batching target that has drifted off baseline.
 * Fires extra grow (and counter-weaken) to climb money back to max, and extra
 * weaken if security has crept above min. Grow/weaken clamp at max/min, so
 * over-firing is harmless. Delays are 0; grow lands at growTime and the weaken
 * at the longer weakenTime, so the weaken cleans up after the grow.
 *
 * Rate-limited per target: after a wave fires we wait ~growTime (the time for it
 * to land) before firing another, so a persistently-drifted target doesn't stack
 * a fresh deficit-sized grow every tick and drain the pool.
 */
function maybeRecover(ns, t, pool, growTime) {
    const target = t.hostname;
    const now = Date.now();
    if ((recoverClock.get(target) ?? 0) > now) return; // a wave is still landing

    // Gate and size recovery on the grid-aligned WINDOWED baseline (peak money /
    // floor security), not the raw read. Raw money on a healthy high-hack-% target
    // sits below RECOVER_MONEY_FRAC almost every tick (it dips to ~(1−f) each
    // cycle), so a raw gate fires supplemental grows constantly — off-grid grows
    // that raise security and desync the pipeline. The window's peak is the true
    // baseline: only fire when even that hasn't returned to max.
    const { moneyFrac, secOver } = displayHealth({
        hostname: target,
        money: t.money,
        maxMoney: t.maxMoney,
        sec: t.sec,
        minSecurity: t.minSecurity,
    });

    let fired = false;

    if (moneyFrac < RECOVER_MONEY_FRAC) {
        const mult = 1 / Math.max(moneyFrac, 0.01);
        const need = Math.ceil(ns.growthAnalyze(target, mult) * THREAD_MARGIN);
        const placed = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, need, target, 0);
        if (placed > 0) {
            const counter = Math.ceil((placed * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
            placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, counter, target, 0);
            fired = true;
        }
    }

    if (secOver > RECOVER_SEC_OVER) {
        const need = Math.ceil((secOver / WEAKEN_SEC) * THREAD_MARGIN);
        const placed = placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, need, target, 0);
        if (placed > 0) fired = true;
    }

    if (fired) recoverClock.set(target, now + growTime);
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

/** Expected income for a batching target, $/s. */
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
    ns.print(`║ Batching ${eligible.length}  |  Prepping ${needsPrep.length}${ramp}  |  Est income $${ns.format.number(income)}/s`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(
        "║ " +
        "TARGET".padEnd(16) +
        "MON%".padStart(5) +
        "SEC".padStart(7) +
        "HK%".padStart(5) +
        "BATCH".padStart(7) +
        "$/s".padStart(11)
    );
    for (const t of eligible) {
        const { moneyFrac, secOver: secOverNum } = displayHealth(t);
        const monPct = Math.round(moneyFrac * 100);
        const secOver = secOverNum.toFixed(2);
        const conc = Math.ceil(t.weakenTime / BATCH_PERIOD);
        ns.print(
            "║ " +
            t.hostname.padEnd(16) +
            `${monPct}%`.padStart(5) +
            `+${secOver}`.padStart(7) +
            `${(t.f * 100).toFixed(0)}%`.padStart(5) +
            `x${conc}`.padStart(7) +
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
