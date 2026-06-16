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

    // Stage 1 summary.
    const rooted = servers.filter((s) => s.hasRoot).length;
    ns.tprint(
        `booster stage 1: ${servers.length} servers found, ${rooted} rooted. ` +
        `Topology written to ${SERVERS_JSON}.`
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
