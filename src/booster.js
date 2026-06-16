/**
 * booster.js — early-game bootstrap hacking controller.
 *
 * The cheap "first stage" controller that runs at the start of a BitNode cycle,
 * before Formulas.exe. See docs/devlog/02-booster.md for the full design.
 *
 * BUILD STATUS: Stage 3b — adds the rolling HWGW grid batcher on top of 3a's
 * loop/pool/prep. Self-heal (3c), managers (4), and status table (5) follow.
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
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
    LOOP_SLEEP,
    HOME_SAFETY_BUFFER_GB,
    FORMULAS_EXE,
    CHANCE_BATCH,
    D_GAP,
    BATCH_PERIOD,
    BATCH_SAFETY_MS,
    BOOSTER_LOG,
    SUMMARY_INTERVAL_MS,
} from "/config/constants.js";

/** Worker paths that must exist on home and get copied to every rooted server. */
const WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

/** Normalized worker filenames for matching against ns.ps() output. */
const WORKER_FILES = new Set(WORKERS.map(stripSlash));

/** Monotonic id appended to every worker exec so concurrent workers are unique. */
let batchSeq = 0;

/** Hosts we've already copied the workers onto this run (avoid re-scp each tick). */
const provisioned = new Set();

/** Per-target launch clock: target -> { nextLaunch } timestamp (ms). */
const clocks = new Map();

/** Targets currently in the batching rotation (persistent across ticks). */
const activeBatching = new Set();

/** Hostnames that were batching last tick (to detect START/STOP transitions). */
const wasBatching = new Set();

/** Timestamp of the last SUMMARY line written to the event log. */
let lastSummary = 0;

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

    // Fresh event log for this run.
    ns.write(BOOSTER_LOG, `=== booster run ${new Date().toISOString()} ===\n`, "w");

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

        const { eligible, needsPrep } = classify(ns, servers);

        // Batch the prepped, eligible targets first (consumes RAM by rank),
        // then spend whatever's left prepping the next-best targets.
        batchPhase(ns, eligible, pool);
        prepPhase(ns, needsPrep, pool, inFlight);

        logEvents(ns, eligible, needsPrep, pool);
        renderStatus(ns, servers, pool, eligible, needsPrep);
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
            const healthy =
                chance >= CHANCE_BATCH &&
                money >= s.maxMoney * BATCH_KEEP_MONEY_FRAC &&
                sec <= s.minSecurity + BATCH_KEEP_SEC_OVER;
            if (healthy) {
                const best = bestHackPct(ns, s, chance);
                if (best) {
                    eligible.push({ ...s, chance, sec, money, ...best });
                    continue;
                }
            }
            activeBatching.delete(s.hostname); // drifted out → re-prep below
        }

        // Not batching: STRICT prepped check to start (ensures table accuracy).
        if (!isPrepped(s, sec, money)) {
            needsPrep.push({ ...s, sec, money });
            continue;
        }
        const chance = ns.hackAnalyzeChance(s.hostname);
        if (chance < CHANCE_BATCH) continue; // prepped but not worth batching

        const best = bestHackPct(ns, s, chance);
        if (best) {
            activeBatching.add(s.hostname);
            eligible.push({ ...s, chance, sec, money, ...best });
        }
    }

    eligible.sort((a, b) => b.score - a.score);
    needsPrep.sort((a, b) => b.maxMoney - a.maxMoney);
    return { eligible, needsPrep };
}

/** True when a server is at (near) min security and (near) max money. */
function isPrepped(s, sec, money) {
    return (
        sec <= s.minSecurity * (1 + SEC_MARGIN) &&
        money >= s.maxMoney * (1 - MONEY_EPSILON)
    );
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

        const weakenTime = t.weakenTime; // from bestHackPct, no extra NS call
        const growTime = ns.getGrowTime(target);
        const hackTime = ns.getHackTime(target);

        // Clock setup / re-anchor if it fell more than a full cycle behind.
        let clock = clocks.get(target);
        if (!clock || clock.nextLaunch < now - weakenTime) {
            clock = { nextLaunch: now };
            clocks.set(target, clock);
        }

        // Fire due batches, capped at one full pipeline's worth per tick.
        const maxFires = Math.ceil(weakenTime / BATCH_PERIOD);
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
        maybeRecover(ns, t, pool);
    }
}

/**
 * Supplemental correction for a batching target that has drifted off baseline.
 * Fires extra grow (and counter-weaken) to climb money back to max, and extra
 * weaken if security has crept above min. Grow/weaken clamp at max/min, so
 * over-firing is harmless. Delays are 0; grow lands at growTime and the weaken
 * at the longer weakenTime, so the weaken cleans up after the grow.
 */
function maybeRecover(ns, t, pool) {
    const target = t.hostname;

    if (t.money < t.maxMoney * RECOVER_MONEY_FRAC) {
        const mult = t.maxMoney / Math.max(t.money, 1);
        const need = Math.ceil(ns.growthAnalyze(target, mult));
        const placed = placeThreads(ns, pool, GROW_WORKER, WORKER_RAM.growRam, need, target, 0);
        if (placed > 0) {
            const counter = Math.ceil((placed * GROW_SEC) / WEAKEN_SEC);
            placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, counter, target, 0);
        }
    }

    if (t.sec > t.minSecurity + RECOVER_SEC_OVER) {
        const need = Math.ceil((t.sec - t.minSecurity) / WEAKEN_SEC);
        placeThreads(ns, pool, WEAKEN_WORKER, WORKER_RAM.weakenRam, need, target, 0);
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
function prepPhase(ns, needsPrep, pool, inFlight) {
    for (const t of needsPrep) {
        if (poolFree(pool) <= 0) break;
        if ((inFlight.get(t.hostname) ?? 0) > 0) continue; // wave already running
        prepWave(ns, t, pool);
    }
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

// ── Event logging (to BOOSTER_LOG for offline inspection) ───────────────────

/**
 * Write START/STOP transitions for batching targets and a periodic SUMMARY of
 * per-target health (money % of max, security above min) and expected income.
 * Uses only already-computed data — no extra NS calls.
 */
function logEvents(ns, eligible, needsPrep, pool) {
    const now = Date.now();
    const current = new Set(eligible.map((t) => t.hostname));

    for (const t of eligible) {
        if (wasBatching.has(t.hostname)) continue;
        const conc = Math.ceil(t.weakenTime / BATCH_PERIOD);
        const eps = expectedIncome(t);
        logLine(
            ns,
            `START ${t.hostname} f=${(t.f * 100).toFixed(0)}% ` +
            `h=${t.h} g=${t.g} w1=${t.w1} w2=${t.w2} ` +
            `ram/batch=${ns.format.ram(t.ramPerBatch)} x${conc} ~$${ns.format.number(eps)}/s`
        );
    }
    for (const host of wasBatching) {
        if (!current.has(host)) logLine(ns, `STOP  ${host} (drifted / unprepped / out of RAM)`);
    }

    wasBatching.clear();
    for (const host of current) wasBatching.add(host);

    if (now - lastSummary >= SUMMARY_INTERVAL_MS) {
        lastSummary = now;
        let total = 0;
        const parts = [];
        for (const t of eligible) {
            total += expectedIncome(t);
            const moneyPct = ((t.money / t.maxMoney) * 100).toFixed(0);
            const secOver = (t.sec - t.minSecurity).toFixed(2);
            parts.push(`${t.hostname}(${moneyPct}%,+${secOver})`);
        }
        logLine(
            ns,
            `SUMMARY batching=${eligible.length} prepping=${needsPrep.length} ` +
            `poolFree=${ns.format.ram(poolFree(pool))} ~$${ns.format.number(total)}/s :: ` +
            parts.join(" ")
        );
    }
}

/** Expected income for a batching target, $/s. */
function expectedIncome(t) {
    return (t.maxMoney * t.f * t.chance) / (BATCH_PERIOD / 1000);
}

/** Append a timestamped line to the event log. */
function logLine(ns, line) {
    ns.write(BOOSTER_LOG, `[${new Date().toLocaleTimeString()}] ${line}\n`, "a");
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
    ns.print(`║ Batching ${eligible.length}  |  Prepping ${needsPrep.length}  |  Est income $${ns.format.number(income)}/s`);
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
        const monPct = Math.round((t.money / t.maxMoney) * 100);
        const secOver = (t.sec - t.minSecurity).toFixed(2);
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
