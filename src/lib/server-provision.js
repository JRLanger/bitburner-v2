/**
 * lib/server-provision.js — shared network discovery, rooting, and worker
 * provisioning for the controllers.
 *
 * booster.js and orbiter.js ran byte-identical copies of this BFS-discover +
 * crack-and-nuke + scp-workers logic. Rooting is exactly the kind of code that must
 * not diverge silently between the two stages (a new port cracker or BN mechanic has
 * to reach both), so it lives here and both import discoverAndRoot.
 *
 * RAM note (docs/reference/game-mechanics.md rule 1): every NS function referenced
 * here — scan, hasRootAccess, fileExists, the five crackers, nuke, scp, and the
 * getServer* static getters — is already referenced by both controllers, so importing
 * it adds no RAM to either.
 */

import {
    HACK_WORKER,
    GROW_WORKER,
    WEAKEN_WORKER,
    SHARE_WORKER,
} from "/config/constants.js";

/** Everything the controller places on rooted hosts: the HWGW workers plus the share
 *  worker. Copied together in one scp per host (see provisionWorkers). */
const PLACED_WORKERS = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER, SHARE_WORKER];

/** Hosts scp'd this controller run — see the once-per-run re-provision in discoverAndRoot.
 *  Module-scoped per process, so it resets naturally when a controller (re)starts. */
const provisionedThisRun = new Set();

export function discoverAndRoot(ns) {
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
