/**
 * backdoor-guide.js — copy-paste backdoor commands for key faction servers.
 *
 * For each server in TARGETS that's rooted, within hacking level, and reachable,
 * prints a ready-to-paste terminal command, e.g.:
 *   connect n00dles; connect CSEC; backdoor
 * One-shot terminal utility, run manually: `run /utils/backdoor-guide.js`.
 *
 * Path-finding (BFS + command building) now lives in lib/netpath.js, a pure 0-GB
 * module shared with managers/pilot.js (which needs the same hop sequence to
 * automate backdoor installs — see docs/plans/pilot-singularity.md phase 2). This
 * script builds its own live `{hostname, parent}` list via a fresh ns.scan() BFS
 * (it's a one-shot manual tool, so the extra scan cost doesn't matter); pilot
 * instead reads the `parent` field the controllers stamp into servers.json each
 * tick, avoiding a duplicate scan in a persistent script.
 */

import { findPath, buildConnectCommand } from "/lib/netpath.js";

/** BFS the live network from home, recording each host's parent — the same shape
 *  (`{hostname, parent}`) servers.json now carries, so findPath works unmodified
 *  on either source. */
function scanTopology(ns) {
    const parentOf = new Map([["home", null]]);
    const queue = ["home"];
    const result = [];
    while (queue.length) {
        const host = queue.shift();
        result.push({ hostname: host, parent: parentOf.get(host) });
        for (const nb of ns.scan(host)) {
            if (!parentOf.has(nb)) {
                parentOf.set(nb, host);
                queue.push(nb);
            }
        }
    }
    return result;
}

export async function main(ns) {
    const TARGETS = [
        { host: "CSEC",          note: "CyberSec faction" },
        { host: "avmnite-02h",   note: "NiteSec faction" },
        { host: "I.I.I.I",       note: "The Black Hand faction" },
        { host: "run4theh111z",  note: "BitRunners faction" },
        { host: "fulcrumassets", note: "Fulcrum Secret Technologies" },
        { host: "w0r1d_d43m0n",  note: "World Daemon -- WIN CONDITION" },
    ];

    const topology = scanTopology(ns);
    const hackLvl = ns.getHackingLevel();
    ns.tprint(`Backdoor guide -- hacking level: ${hackLvl}`);

    for (const t of TARGETS) {
        let srv;
        try {
            srv = ns.getServer(t.host);
        } catch {
            ns.tprint(`  ${t.host} (${t.note}) -- not yet visible`);
            continue;
        }

        if (srv.backdoorInstalled) {
            ns.tprint(`  ${t.host} (${t.note}) -- already backdoored`);
            continue;
        }
        if (!srv.hasAdminRights) {
            ns.tprint(`  ${t.host} (${t.note}) -- need root access first`);
            continue;
        }
        if (hackLvl < srv.requiredHackingSkill) {
            ns.tprint(`  ${t.host} (${t.note}) -- need hack level ${srv.requiredHackingSkill} (have ${hackLvl})`);
            continue;
        }

        const path = findPath(topology, t.host);
        if (!path) {
            ns.tprint(`  ${t.host} (${t.note}) -- not reachable from home yet`);
            continue;
        }

        ns.tprint(`  ${t.note}:`);
        ns.tprint(`  ${buildConnectCommand(path)}`);
    }
}
