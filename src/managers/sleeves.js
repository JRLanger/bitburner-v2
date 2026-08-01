/**
 * managers/sleeves.js — duplicate-sleeve manager.
 *
 * Design: docs/superpowers/specs/2026-08-01-sleeves-design.md.
 * Each tick, assign every sleeve its highest-value task via the pure `chooseTask`
 * ladder, buy sleeves/memory/augs under the shared MECH_SPEND_FRAC cap, and log
 * machine-checkable evidence to SLEEVE_DEBUG_LOG. Sleeves run in parallel and never
 * contend for player focus — the only cross-sleeve rule is one sleeve per faction.
 */
import {
    STATUS_PORT_SLEEVES, SLEEVE_LOOP_SLEEP, SLEEVE_SHOCK_MAX, SLEEVE_SYNC_MIN,
    SLEEVE_STAT_FLOOR, SLEEVE_DEBUG, SLEEVE_DEBUG_LOG, MECH_SPEND_FRAC,
} from "/config/constants.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { debugLog } from "/lib/debug-log.js";
import { STATUS_PORT_GANG, STATUS_PORT_PILOT } from "/config/constants.js";

/** stat name (as on sleeve.skills) → GymType enum the API wants. */
export const GYM_STAT = { strength: "str", defense: "def", dexterity: "dex", agility: "agi" };

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

/** Lowest of the four combat stats. Ties resolve to the earliest in COMBAT_STATS order. */
export function lowestCombatStat(skills) {
    let stat = COMBAT_STATS[0], val = skills[stat];
    for (const s of COMBAT_STATS) {
        if (skills[s] < val) { stat = s; val = skills[s]; }
    }
    return { stat, val };
}

/**
 * Pure task selection for one sleeve. First applicable row wins.
 * ctx = { gangKarmaPhase, pilotFaction, claimedFactions:Set }.
 * Returns { row, crime?, faction?, stat? }.
 */
export function chooseTask(sleeve, ctx) {
    if (sleeve.sync < SLEEVE_SYNC_MIN) return { row: "sync" };
    if (sleeve.shock > SLEEVE_SHOCK_MAX) return { row: "recovery" };
    if (ctx.gangKarmaPhase) return { row: "karma", crime: "Homicide" };
    if (ctx.pilotFaction && !ctx.claimedFactions.has(ctx.pilotFaction)) {
        return { row: "faction", faction: ctx.pilotFaction };
    }
    const low = lowestCombatStat(sleeve.skills);
    if (low.val < SLEEVE_STAT_FLOOR) return { row: "gym", stat: low.stat };
    return { row: "crime", crime: "Heist" };
}

/** True when the sleeve's current getTask() result already satisfies `decision`
 *  (thrash guard — skip reassignment, which would reset task progress). */
export function matchesCurrent(task, decision) {
    if (!task) return false;
    switch (decision.row) {
        case "sync": return task.type === "SYNCHRO";
        case "recovery": return task.type === "RECOVERY";
        case "karma":
        case "crime": return task.type === "CRIME" && task.crimeType === decision.crime;
        case "faction": return task.type === "FACTION" && task.factionName === decision.faction;
        case "gym": return task.type === "CLASS" && task.classType === GYM_STAT[decision.stat];
        default: return false;
    }
}
