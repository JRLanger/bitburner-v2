/**
 * lib/manager-launch.js — shared manager orchestration for the controllers.
 *
 * booster.js and orbiter.js are two stages of the same controller lineage (orbiter
 * is a fork of booster that runs once Formulas.exe is owned). They launch the SAME
 * ordered set of managers with byte-identical logic, so that logic lives here and is
 * imported by both — a launcher fix now lands in one place instead of two. (A real
 * bug came from the old duplication: the sleeves manager was wired into booster only,
 * so it never launched under orbiter.)
 *
 * RAM note (see docs/reference/game-mechanics.md rule 1): every NS function this
 * module references — exec, ps, getScriptRam, getResetInfo, print — is already
 * referenced by both controllers, so importing it here adds no RAM to either. The
 * gates deliberately avoid ns.gang/ns.sleeve/ns.singularity references (they use the
 * cheap ns.getResetInfo) so the controllers pay no feature-API RAM to gate-check.
 *
 * The `managersSeen` suppression is INTENTIONAL: a manager the user stopped stays
 * down for the whole run, across controller restarts. The flag port is wiped on
 * aug/soft reset, so it clears exactly when a new run starts. Do not "fix" this.
 */

import {
    PSERVER_MANAGER,
    CONTRACTS_MANAGER,
    HACKNET_MANAGER,
    PILOT_MANAGER,
    LIFECYCLE_MANAGER,
    GANG_MANAGER,
    SLEEVE_MANAGER,
    PSERVER_PREFIX,
    HACKNET_GATE,
} from "/config/constants.js";
import { readFlags, writeFlags } from "/lib/flags.js";

/** True if `path` starts with a leading slash, stripped for ns.ps() filename matching. */
function stripSlash(path) {
    return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Managers the controller orchestrates, in fixed priority order. Each tick the first
 * not-running, gate-OPEN manager launches (see launchManagers).
 */
const MANAGERS = [
    { file: PSERVER_MANAGER, gate: () => true },
    { file: CONTRACTS_MANAGER, gate: () => true },
    { file: PILOT_MANAGER, gate: pilotGate },
    { file: LIFECYCLE_MANAGER, gate: pilotGate },
    // Sleeves BEFORE gang: sleeves farm the karma that forms the gang (ladder row 3),
    // so they're the higher-priority karma producer and should launch first. (Closed
    // gates are now skipped, not blocking — see launchManagers — so this is a priority
    // choice, not a workaround.) Sleeve has no hard dependency on gang/pilot: it reads
    // their status opportunistically and degrades to null when absent.
    { file: SLEEVE_MANAGER, gate: sleeveGate },
    { file: GANG_MANAGER, gate: gangGate },
    { file: HACKNET_MANAGER, gate: pserverFleetBuilt },
];

/**
 * Manager-launch suppression lives in the shared flag port (lib/flags.js) under the
 * `managersSeen` key — a list of manager filenames the controller has seen running this
 * run. A manager that was seen running and is now gone (user-stopped or self-completed) is
 * not relaunched. The port is wiped on aug/soft reset, so a wiped infra always rebuilds
 * even if the controller process survives the reset — no in-memory set, no reset detection.
 * See launchManagers / nextManagerReserve.
 */
const MANAGERS_SEEN_FLAG = "managersSeen";

/**
 * Launch managers in fixed dependency order. Each tick, find the FIRST manager that is
 * not running and hasn't already been accounted for this run, and if its gate passes,
 * exec it. A later manager is never launched until every earlier one is accounted for,
 * which makes the order "fixed." Checks ns.ps("home") (not just stored state) so a
 * controller restart never double-launches a persistent manager.
 *
 * The "seen running" set lives in the shared flag port (MANAGERS_SEEN_FLAG): a manager
 * the controller saw running that is now gone — user-stopped or self-completed (nothing
 * worth buying) — stays down for the rest of the run. Because the port is wiped on aug/soft
 * reset, the managers relaunch and rebuild the wiped infra automatically, even if this
 * controller process survived the reset (no reset detection needed). A suppressed manager
 * is treated as "accounted for" so the loop moves past it to later managers (e.g.
 * hacknet still launches after pserver finishes).
 *
 * `dbg` is the caller's per-tick debug logger (booster and orbiter each buffer to their
 * own log file), passed in so the diagnostic lines keep going to the right place.
 */
export function launchManagers(ns, servers, dbg = () => {}) {
    const flags = readFlags(ns);
    const seen = new Set(flags[MANAGERS_SEEN_FLAG] ?? []);
    const sizeBefore = seen.size;

    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) {
            seen.add(m.file); // remember it's up so a later disappearance is detectable
            dbg(`  mgr ${m.file}: running`);
            continue;
        }
        if (seen.has(m.file)) {
            dbg(`  mgr ${m.file}: SUPPRESSED (seen running earlier this run, now gone)`);
            continue; // was running, now gone → stopped/done
        }
        if (!m.gate(servers, ns)) {
            // Gate closed = this feature isn't available in this save (e.g. no SF10
            // for sleeves). Skip to the next manager instead of blocking the chain —
            // an unavailable dependency must not stall the managers behind it.
            dbg(`  mgr ${m.file}: gate=closed (skip)`);
            continue;
        }
        const pid = ns.exec(m.file, "home");
        dbg(`  mgr ${m.file}: gate=open exec pid=${pid}`);
        // Only mark it accounted-for if the exec actually started a process. exec()
        // fails silently (returns 0, no exception) when home lacks free RAM at that
        // instant — e.g. right after a reset, before the reserve has caught up.
        // Without this check a single failed launch looked like "user stopped it".
        if (pid !== 0) seen.add(m.file);
        else ns.print(`WARN: failed to launch ${m.file} (insufficient RAM on home?) — will retry`);
        break; // launched (or tried, RAM-blocked) one gate-open manager this tick
    }

    if (seen.size !== sizeBefore) writeFlags(ns, { ...flags, [MANAGERS_SEEN_FLAG]: [...seen] });
}

/** RAM to reserve on home for the next pending manager, GB. Skips managers that are
 *  running or already accounted for (stopped/done) — none of those will be (re)launched,
 *  so reserving for them would needlessly shrink the worker pool. */
export function nextManagerReserve(ns, servers) {
    const seen = new Set(readFlags(ns)[MANAGERS_SEEN_FLAG] ?? []);
    for (const m of MANAGERS) {
        if (isRunning(ns, m.file)) continue;
        if (seen.has(m.file)) continue;
        if (!m.gate(servers, ns)) continue; // gate closed → won't launch → don't reserve for it
        return ns.getScriptRam(m.file, "home");
    }
    return 0; // nothing left to launch → no reserve needed
}

/** True if a script with this filename is already running on home. */
export function isRunning(ns, file) {
    const name = stripSlash(file);
    return ns.ps("home").some((proc) => stripSlash(proc.filename) === name);
}

/**
 * Hacknet gate: the pserver fleet is fully built — at least serverCount purchased
 * servers, each at or above ramEachGB. Counted from the topology the controller already
 * gathered (hostnames starting with PSERVER_PREFIX), so no extra NS calls.
 */
function pserverFleetBuilt(servers) {
    const built = servers.filter(
        (s) => s.hostname.startsWith(PSERVER_PREFIX) && s.maxRam >= HACKNET_GATE.ramEachGB
    ).length;
    return built >= HACKNET_GATE.serverCount;
}

/**
 * Pilot gate: player owns SF4 (ns.singularity.* usable outside BN4) OR the current
 * run IS BitNode 4 (singularity is free there even at SF4 level 0). getResetInfo is
 * a cheap top-level NS call (not under singularity), so this costs nothing extra to
 * check every tick while pilot is still pending. ownedSF is a Map<sfNumber, level>;
 * a present, >0 entry for key 4 means SF4 is active. If the gate can never pass this
 * run (no SF4, not BN4), pilot simply stays "pending" forever — launchManagers logs
 * once (gate=closed) and moves on; later managers behind it in the list still launch.
 * Takes `ns` (unlike the other gates) because it's the only one that needs a live NS
 * call rather than pre-gathered topology data — see launchManagers' `m.gate(servers, ns)`.
 */
function pilotGate(servers, ns) {
    const info = ns.getResetInfo();
    const sf4Level = info.ownedSF.get(4) ?? 0;
    return sf4Level > 0 || info.currentNode === 4;
}

/**
 * Gang gate: a gang is only ever creatable with SF2 owned or inside BN2, and
 * the manager's rep gate needs singularity (pilotGate). Checked without any
 * ns.gang.* reference so the controller pays no gang-API RAM; the manager
 * itself idles in its karma phase until createGang succeeds.
 */
function gangGate(servers, ns) {
    const info = ns.getResetInfo();
    const sf2 = (info.ownedSF.get(2) ?? 0) > 0 || info.currentNode === 2;
    return sf2 && pilotGate(servers, ns);
}

/**
 * Sleeve gate: sleeves only exist with SF10 owned or inside BN10. Checked without
 * any ns.sleeve.* reference so the controller pays no sleeve-API RAM; the manager
 * itself self-checks getNumSleeves() === 0 and idles if none exist.
 */
function sleeveGate(servers, ns) {
    const info = ns.getResetInfo();
    return (info.ownedSF.get(10) ?? 0) > 0 || info.currentNode === 10;
}
