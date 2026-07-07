/**
 * lib/netpath.js — pure BFS path-finding over the servers.json topology.
 *
 * Extracted from utils/backdoor-guide.js so pilot.js can also compute
 * home -> target hop sequences WITHOUT calling ns.scan() itself (pilot must stay
 * a slow, RAM-conscious singularity script — see docs/plans/pilot-singularity.md).
 * Instead it reads the `parent` field the controllers (booster.js/orbiter.js) now
 * stamp into each servers.json entry during their own topology BFS (discoverAndRoot)
 * — a scan they already do every tick, so this adds no extra NS calls anywhere.
 *
 * 0-GB module: no NS function is ever called here, only plain JS over the `servers`
 * array/object already read from disk. SAFE TO IMPORT ANYWHERE (see lib/flags.js for
 * the same "0-GB port ops" idiom — this is the same idea for pure data structures).
 */

/**
 * Build a hostname -> parent hostname lookup from the servers.json array (or any
 * array of objects with `hostname` and `parent` fields). `home`'s parent is null/
 * undefined by construction (it's the BFS root) — findPath below stops there.
 */
function buildParentMap(servers) {
    const parents = new Map();
    for (const s of servers) parents.set(s.hostname, s.parent ?? null);
    return parents;
}

/**
 * Walk parent pointers from `target` back to `home`, returning the path
 * ["home", ..., target] (inclusive of both ends), or null if `target` isn't in the
 * topology or the parent chain never reaches home (shouldn't happen for a
 * controller-produced topology, but a manager reading a stale/partial file should
 * not crash on it).
 */
export function findPath(servers, target) {
    if (target === "home") return ["home"];
    const parents = buildParentMap(servers);
    if (!parents.has(target)) return null;

    const path = [target];
    let cur = target;
    const guard = new Set([cur]); // cycle guard against malformed data
    while (cur !== "home") {
        const next = parents.get(cur);
        if (next == null || guard.has(next)) return null;
        path.push(next);
        guard.add(next);
        cur = next;
    }
    return path.reverse();
}

/** Build the `connect` command sequence backdoor-guide.js prints, from a path
 *  returned by findPath (["home", ..., target]). */
export function buildConnectCommand(path) {
    return "home; " + path.slice(1).map((s) => `connect ${s}`).join("; ") + "; backdoor";
}
