/**
 * backdoor-guide.js — copy-paste backdoor commands for key faction servers.
 *
 * For each server in TARGETS that's rooted, within hacking level, and reachable,
 * prints a ready-to-paste terminal command, e.g.:
 *   connect n00dles; connect CSEC; backdoor
 * One-shot terminal utility, run manually: `run /utils/backdoor-guide.js`.
 */

export async function main(ns) {
    const TARGETS = [
        { host: "CSEC",          note: "CyberSec faction" },
        { host: "avmnite-02h",   note: "NiteSec faction" },
        { host: "I.I.I.I",       note: "The Black Hand faction" },
        { host: "run4theh111z",  note: "BitRunners faction" },
        { host: "fulcrumassets", note: "Fulcrum Secret Technologies" },
        { host: "w0r1d_d43m0n",  note: "World Daemon -- WIN CONDITION" },
    ];

    function findPath(target) {
        const visited = new Set(["home"]);
        const queue = [["home"]];
        while (queue.length) {
            const path = queue.shift();
            const node = path[path.length - 1];
            if (node === target) return path;
            for (const nb of ns.scan(node)) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    queue.push([...path, nb]);
                }
            }
        }
        return null;
    }

    function buildCommand(path) {
        return "home; " + path.slice(1).map((s) => `connect ${s}`).join("; ") + "; backdoor";
    }

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

        const path = findPath(t.host);
        if (!path) {
            ns.tprint(`  ${t.host} (${t.note}) -- not reachable from home yet`);
            continue;
        }

        ns.tprint(`  ${t.note}:`);
        ns.tprint(`  ${buildCommand(path)}`);
    }
}
