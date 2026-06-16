/**
 * booster.js — early-game bootstrap hacking controller.
 *
 * The cheap "first stage" controller that runs at the start of a BitNode cycle,
 * before Formulas.exe. See docs/devlog/02-booster.md for the full design.
 *
 * BUILD STATUS: Stage 3a — persistent loop, cross-server RAM pool, thread
 * placement, and prep execution (drive targets to min security / max money).
 * HWGW batching (3b), self-heal (3c), managers (4), and status table (5) follow.
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
    HACK_PCT_MIN,
    HACK_PCT_MAX,
    HACK_PCT_STEP,
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
} from "/config/constants.js";

/** Worker paths that must exist on home and get copied to every rooted server. */
const WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

/** Normalized worker filenames for matching against ns.ps() output. */
const WORKER_FILES = new Set(WORKERS.map(stripSlash));

/** Monotonic id appended to every worker exec so concurrent workers are unique. */
let batchSeq = 0;

/** Hosts we've already copied the workers onto this run (avoid re-scp each tick). */
const provisioned = new Set();

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
        const pool = buildPool(ns, rootedHosts);
        const inFlight = inFlightByTarget(ns, rootedHosts);

        const prepped = prepPhase(ns, servers, pool, inFlight);

        printStatus(ns, servers, pool, prepped);
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
function buildPool(ns, rootedHosts) {
    const pool = [];
    for (const host of rootedHosts) {
        const max = ns.getServerMaxRam(host);
        if (max <= 0) continue;
        let free = max - ns.getServerUsedRam(host);
        if (host === "home") free -= HOME_SAFETY_BUFFER_GB;
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

// ── Prep phase ──────────────────────────────────────────────────────────────

/**
 * Drive needs-prep targets toward baseline (min security, max money), most
 * valuable first, one corrective wave per target at a time (skip targets that
 * already have workers in flight). Returns the list of prepped hostnames.
 */
function prepPhase(ns, servers, pool, inFlight) {
    const level = ns.getHackingLevel();
    const prepped = [];
    const needsPrep = [];

    for (const s of servers) {
        if (!s.hasRoot || s.maxMoney <= 0 || s.hackLevelReq > level) continue;
        const sec = ns.getServerSecurityLevel(s.hostname);
        const money = ns.getServerMoneyAvailable(s.hostname);
        if (isPrepped(s, sec, money)) {
            prepped.push(s.hostname);
        } else {
            needsPrep.push({ ...s, sec, money });
        }
    }

    // Most valuable targets get prepped first.
    needsPrep.sort((a, b) => b.maxMoney - a.maxMoney);

    for (const t of needsPrep) {
        if (poolFree(pool) <= 0) break;
        if ((inFlight.get(t.hostname) ?? 0) > 0) continue; // wave already running
        prepWave(ns, t, pool);
    }

    return prepped;
}

/** True when a server is at (near) min security and (near) max money. */
function isPrepped(s, sec, money) {
    return (
        sec <= s.minSecurity * (1 + SEC_MARGIN) &&
        money >= s.maxMoney * (1 - MONEY_EPSILON)
    );
}

/**
 * Fire one corrective wave for a target:
 *  - if security is above min, weaken it down;
 *  - else grow money toward max, plus weaken to counter grow's security rise
 *    (grow lands at growTime, the counter-weaken at the longer weakenTime, so
 *    the weaken naturally lands after the grow it offsets).
 */
function prepWave(ns, t, pool) {
    const target = t.hostname;

    if (t.sec > t.minSecurity * (1 + SEC_MARGIN)) {
        const need = Math.ceil((t.sec - t.minSecurity) / WEAKEN_SEC);
        placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, need, target, 0);
        return;
    }

    // Security is fine; restore money.
    const mult = t.maxMoney / Math.max(t.money, 1);
    const growNeed = Math.ceil(ns.growthAnalyze(target, mult));
    const placed = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, growNeed, target, 0);
    if (placed > 0) {
        const counter = Math.ceil((placed * GROW_SEC) / WEAKEN_SEC);
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
 * Sweep hack fractions and return the row with the best score ($/GB/s).
 * All hackAnalyze/growthAnalyze calls are free RAM.
 */
function bestHackPct(ns, server, chance) {
    const target = server.hostname;
    const hackFrac = ns.hackAnalyze(target);
    if (hackFrac <= 0) return null;

    const weakenTime = ns.getWeakenTime(target);
    let best = null;

    for (let f = HACK_PCT_MIN; f <= HACK_PCT_MAX + 1e-9; f += HACK_PCT_STEP) {
        const h = Math.ceil(f / hackFrac);
        const g = Math.ceil(ns.growthAnalyze(target, 1 / (1 - f)));
        const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC);
        const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC);
        const ramPerBatch =
            h * WORKER_RAM.hackRam + g * WORKER_RAM.growRam + (w1 + w2) * WORKER_RAM.weakenRam;
        const moneyPerBatch = server.maxMoney * f * chance;
        const score = moneyPerBatch / (weakenTime * ramPerBatch);
        if (!best || score > best.score) {
            best = { f, h, g, w1, w2, ramPerBatch, weakenTime, score };
        }
    }
    return best;
}

// ── Status / helpers ────────────────────────────────────────────────────────

/** Concise per-tick status to the script log (tail window). */
function printStatus(ns, servers, pool, prepped) {
    const rooted = servers.filter((s) => s.hasRoot).length;
    ns.print(
        `[${new Date().toLocaleTimeString()}] ` +
        `rooted ${rooted}/${servers.length} | prepped ${prepped.length} | ` +
        `pool free ${ns.format.ram(poolFree(pool))}`
    );
}

/** Strip a leading slash so script paths compare consistently. */
function stripSlash(path) {
    return path.startsWith("/") ? path.slice(1) : path;
}
