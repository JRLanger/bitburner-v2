/**
 * booster.js — early-game bootstrap hacking controller.
 *
 * The cheap "first stage" controller that runs at the start of a BitNode cycle,
 * before Formulas.exe. See docs/devlog/02-booster.md for the full design.
 *
 * BUILD STATUS: Stage 1 — discovery, rooting, worker provisioning, topology
 * JSON. Later stages add ranking, batching, managers, and the status table.
 *
 * Prerequisites: the three worker scripts must already exist on home. booster
 * does NOT create them; it errors out and exits if any is missing.
 */

import {
    HACK_WORKER,
    GROW_WORKER,
    WEAKEN_WORKER,
    SERVERS_JSON,
    CHANCE_FILTER,
    SEC_MARGIN,
    MONEY_EPSILON,
    HACK_PCT_MIN,
    HACK_PCT_MAX,
    HACK_PCT_STEP,
    WORKER_RAM,
    WEAKEN_SEC,
    GROW_SEC,
    HACK_SEC,
} from "/config/constants.js";

/** Worker paths that must exist on home and get copied to every rooted server. */
const WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

export async function main(ns) {
    ns.disableLog("ALL");

    // Prerequisite check: all three workers must exist on home.
    const missing = WORKERS.filter((w) => !ns.fileExists(w, "home"));
    if (missing.length > 0) {
        ns.tprint(`ERROR: missing worker script(s): ${missing.join(", ")}`);
        ns.tprint("booster does not create workers. Add them, then re-run.");
        return;
    }

    // Discover, root, and provision the whole network.
    const servers = discoverAndRoot(ns);

    // Persist topology for managers (free I/O).
    ns.write(SERVERS_JSON, JSON.stringify(servers, null, 2), "w");

    // Stage 2: rank candidate targets and print a diagnostic table.
    const ranked = rankTargets(ns, servers);
    printRanking(ns, ranked);
}

/**
 * For every rooted, money-bearing server we have a fair shot at hacking, build
 * its hack-% table, score it, and classify it as prepped or needs-prep.
 * Returns the candidates sorted by best score (most profitable first).
 */
function rankTargets(ns, servers) {
    const level = ns.getHackingLevel();
    const candidates = [];

    for (const s of servers) {
        if (!s.hasRoot || s.maxMoney <= 0) continue;
        if (s.hackLevelReq > level) continue;

        const chance = ns.hackAnalyzeChance(s.hostname);
        if (chance < CHANCE_FILTER) continue;

        const best = bestHackPct(ns, s, chance);
        if (!best) continue; // no viable hack fraction

        const money = ns.getServerMoneyAvailable(s.hostname);
        const sec = ns.getServerSecurityLevel(s.hostname);
        const prepped =
            sec <= s.minSecurity * (1 + SEC_MARGIN) &&
            money >= s.maxMoney * (1 - MONEY_EPSILON);

        candidates.push({ ...s, chance, prepped, money, sec, ...best });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

/**
 * Sweep hack fractions from HACK_PCT_MIN..HACK_PCT_MAX and return the row with
 * the best score ($ per GB per second). All hackAnalyze/growthAnalyze calls are
 * free RAM, so the full sweep costs nothing extra.
 */
function bestHackPct(ns, server, chance) {
    const target = server.hostname;
    const hackFrac = ns.hackAnalyze(target); // fraction of money per hack thread
    if (hackFrac <= 0) return null;

    const weakenTime = ns.getWeakenTime(target);
    let best = null;

    for (let f = HACK_PCT_MIN; f <= HACK_PCT_MAX + 1e-9; f += HACK_PCT_STEP) {
        const h = Math.ceil(f / hackFrac);
        const g = Math.ceil(ns.growthAnalyze(target, 1 / (1 - f)));
        const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC);
        const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC);

        const ramPerBatch =
            h * WORKER_RAM.hack +
            g * WORKER_RAM.grow +
            (w1 + w2) * WORKER_RAM.weaken;

        const moneyPerBatch = server.maxMoney * f * chance;
        const score = moneyPerBatch / (weakenTime * ramPerBatch);

        if (!best || score > best.score) {
            best = { f, h, g, w1, w2, ramPerBatch, weakenTime, score };
        }
    }

    return best;
}

/** Print a diagnostic table of the top-ranked targets (stage 2 verification). */
function printRanking(ns, ranked) {
    ns.tprint(`booster stage 2: ${ranked.length} candidate targets (top 15):`);
    ns.tprint(
        sprintfRow("TARGET", "STATE", "HACK%", "H", "G", "W1", "W2", "RAM/batch", "SCORE")
    );
    for (const t of ranked.slice(0, 15)) {
        ns.tprint(
            sprintfRow(
                t.hostname,
                t.prepped ? "prepped" : "needsprep",
                (t.f * 100).toFixed(0) + "%",
                t.h,
                t.g,
                t.w1,
                t.w2,
                ns.format.ram(t.ramPerBatch),
                t.score.toExponential(2)
            )
        );
    }
}

/** Fixed-width row formatter for the diagnostic table. */
function sprintfRow(target, state, pct, h, g, w1, w2, ram, score) {
    return (
        String(target).padEnd(20) +
        String(state).padEnd(11) +
        String(pct).padStart(6) +
        String(h).padStart(6) +
        String(g).padStart(7) +
        String(w1).padStart(6) +
        String(w2).padStart(6) +
        String(ram).padStart(12) +
        String(score).padStart(12)
    );
}

/**
 * Breadth-first scan from home. Attempts to root every server reached, copies
 * the workers to each rooted host, and returns an array of static info objects.
 */
function discoverAndRoot(ns) {
    const seen = new Set(["home"]);
    const queue = ["home"];
    const result = [];

    while (queue.length > 0) {
        const host = queue.shift();

        // Enqueue neighbours we haven't visited yet, tracking depth/parent.
        for (const next of ns.scan(host)) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }

        if (host === "home") continue; // don't root/record home itself

        const hadRoot = ns.hasRootAccess(host);
        const rooted = hadRoot || tryRoot(ns, host);
        if (rooted) provisionWorkers(ns, host);

        result.push(gatherInfo(ns, host, rooted));
    }

    return result;
}

/**
 * Open as many ports as we have crackers for, then nuke if that's enough.
 * Crackers are called by literal name so the RAM analyzer accounts for them.
 * Returns true if the server ends up rooted.
 */
function tryRoot(ns, host) {
    if (ns.fileExists("BruteSSH.exe", "home")) ns.brutessh(host);
    if (ns.fileExists("FTPCrack.exe", "home")) ns.ftpcrack(host);
    if (ns.fileExists("relaySMTP.exe", "home")) ns.relaysmtp(host);
    if (ns.fileExists("HTTPWorm.exe", "home")) ns.httpworm(host);
    if (ns.fileExists("SQLInject.exe", "home")) ns.sqlinject(host);

    try {
        ns.nuke(host); // throws if we haven't opened enough ports
    } catch {
        return false;
    }
    return ns.hasRootAccess(host);
}

/** Copy the three workers onto a rooted host so it can run batches. */
function provisionWorkers(ns, host) {
    ns.scp(WORKERS, host, "home");
}

/** Collect the static / slow-changing fields for a server. */
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
