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
    SLEEVE_STAT_FLOOR, SLEEVE_CRIME_MIN_CHANCE, SLEEVE_DEBUG, SLEEVE_DEBUG_LOG, MECH_SPEND_FRAC,
} from "/config/constants.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { debugLog } from "/lib/debug-log.js";
import { STATUS_PORT_GANG, STATUS_PORT_PILOT } from "/config/constants.js";

/** stat name (as on sleeve.skills) → GymType enum the API wants. */
export const GYM_STAT = { strength: "str", defense: "def", dexterity: "dex", agility: "agi" };

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

/** Crimes considered for karma/money laddering (CrimeType enum values, verified).
 *  Limited to the three that grant XP in ALL four combat stats — so laddering also
 *  trains the sleeve evenly toward the next crime up. Ordered easy→hard. */
const CRIME_CANDIDATES = ["Mug", "Traffick Arms", "Homicide"];

/** Human-readable dashboard label per ladder row (the `action` head shows this). */
const ROW_LABEL = {
    sync: "synchronizing", recovery: "shock recovery", karma: "karma farming",
    faction: "faction work", gym: "training", crime: "crime",
};

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

/**
 * Pure crime picker. From `candidates` (each { crime, value, time, chance } where
 * value is karma OR money) choose the highest expected-value-per-second crime among
 * those meeting `minChance`. Filter by chance FIRST so a high-value but unreliable
 * crime (e.g. Homicide at 2%) never wins over a reliable one — this is the fix for
 * sleeves diving straight into Homicide. Returns { crime } or { train: true } when
 * nothing clears the chance floor (caller trains stats instead).
 */
export function scoreCrimes(candidates, minChance) {
    let best = null;
    for (const c of candidates) {
        if (c.value <= 0 || c.time <= 0 || c.chance < minChance) continue;
        const ev = (c.value * c.chance) / c.time;
        if (!best || ev > best.ev) best = { crime: c.crime, ev };
    }
    return best ? { crime: best.crime } : { train: true };
}

/** Smart crime laddering needs SF4 (getCrimeStats) and Formulas.exe (crimeSuccessChance).
 *  Without both, callers fall back to a fixed crime. */
function smartCrimeAvailable(ns) {
    const info = ns.getResetInfo();
    const sf4 = (info.ownedSF.get(4) ?? 0) > 0 || info.currentNode === 4;
    return sf4 && ns.fileExists("Formulas.exe", "home");
}

/**
 * Resolve a crime row to a concrete action for this sleeve. `metric` is "karma" or
 * "money". Returns { crime } to commit, or { train: stat } to train the weakest combat
 * stat (when no crime clears the chance floor). Falls back to a fixed crime when smart
 * laddering isn't available (no SF4/Formulas).
 */
function resolveCrime(ns, sleeve, metric) {
    if (!smartCrimeAvailable(ns)) return { crime: metric === "karma" ? "Homicide" : "Heist" };
    const candidates = CRIME_CANDIDATES.map((crime) => {
        const stats = ns.singularity.getCrimeStats(crime);
        return {
            crime,
            value: metric === "karma" ? stats.karma : stats.money,
            time: stats.time,
            chance: ns.formulas.work.crimeSuccessChance(sleeve, crime),
        };
    });
    const pick = scoreCrimes(candidates, SLEEVE_CRIME_MIN_CHANCE);
    if (pick.train) return { train: lowestCombatStat(sleeve.skills).stat };
    return { crime: pick.crime };
}

/** Append one sleeve debug line, gated on SLEEVE_DEBUG. read/write are 0-GB — no added RAM. */
function log(ns, fields) { if (SLEEVE_DEBUG) debugLog(ns, SLEEVE_DEBUG_LOG, fields); }

/** Apply a decision to sleeve i. Returns truthy on success (treat undefined as failure).
 *  Faction work tries each work type until one is accepted (setToFactionWork returns
 *  undefined when the faction doesn't offer that type). */
function applyTask(ns, i, d) {
    switch (d.row) {
        case "sync": return ns.sleeve.setToSynchronize(i);
        case "recovery": return ns.sleeve.setToShockRecovery(i);
        case "karma":
        case "crime": return ns.sleeve.setToCommitCrime(i, d.crime);
        case "faction":
            for (const wt of ["field", "hacking", "security"]) {
                if (ns.sleeve.setToFactionWork(i, d.faction, wt)) return true;
            }
            return false;
        case "gym":
            ns.sleeve.travel(i, "Sector-12");
            return ns.sleeve.setToGymWorkout(i, "Powerhouse Gym", GYM_STAT[d.stat]);
        default: return false;
    }
}

/** Spend under the shared per-tick MECH_SPEND_FRAC cap. Returns money spent this tick.
 *  Order: buy a sleeve (BN10) → cheapest memory upgrade → cheapest affordable augs.
 *  Cheapest-first so a big-ticket item can't starve several small wins. */
function spendTick(ns) {
    const n = ns.sleeve.getNumSleeves();
    let budget = ns.getServerMoneyAvailable("home") * MECH_SPEND_FRAC;
    let spent = 0;
    const buy = (kind, sleeve, cost, doBuy) => {
        if (cost > budget) return false;
        const r = doBuy();
        if (r !== true && r?.success !== true) return false;
        budget -= cost; spent += cost;
        log(ns, { ev: "buy", kind, sleeve, cost: Math.round(cost), spentTick: Math.round(spent) });
        return true;
    };

    // 1) Buy a new sleeve (BN10 only; returns false/throws-free otherwise).
    const sleeveCost = ns.sleeve.getSleeveCost();
    if (Number.isFinite(sleeveCost)) buy("sleeve", "-", sleeveCost, () => ns.sleeve.purchaseSleeve());

    // 2) Cheapest single memory upgrade across all sleeves.
    let memBest = null;
    for (let i = 0; i < n; i++) {
        const c = ns.sleeve.getMemoryUpgradeCost(i, 1);
        if (Number.isFinite(c) && (!memBest || c < memBest.c)) memBest = { i, c };
    }
    if (memBest) buy("memory", memBest.i, memBest.c, () => ns.sleeve.upgradeMemory(memBest.i, 1));

    // 3) Cheapest affordable aug across sleeves at shock 0 (batch happens naturally
    //    over ticks — one purchase per tick keeps within the cap and re-reads prices).
    let augBest = null;
    for (let i = 0; i < n; i++) {
        if (ns.sleeve.getSleeve(i).shock !== 0) continue;
        for (const a of ns.sleeve.getSleevePurchasableAugs(i)) {
            if (!augBest || a.cost < augBest.cost) augBest = { i, name: a.name, cost: a.cost };
        }
    }
    if (augBest) buy("aug", augBest.i, augBest.cost, () => ns.sleeve.purchaseSleeveAug(augBest.i, augBest.name));

    return spent;
}

/** Read cross-manager signals once per tick (peek — non-consuming). */
function gatherContext(ns) {
    const gang = readStatus(ns, STATUS_PORT_GANG);
    const pilot = readStatus(ns, STATUS_PORT_PILOT);
    const pilotFaction = (pilot && pilot.working) ? (pilot.augs?.workTarget?.faction ?? null) : null;
    return {
        gangKarmaPhase: gang?.phase === "karma",
        pilotFaction,
    };
}

export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("sleeves manager started");

    let spentThisRun = 0; // carried across ticks; Task 4 increments it

    while (true) {
        const n = ns.sleeve.getNumSleeves();
        if (n === 0) { await ns.sleep(SLEEVE_LOOP_SLEEP); continue; } // gate races: nothing to do

        const base = gatherContext(ns);
        const claimedFactions = new Set();
        const counts = { sync: 0, recovery: 0, karma: 0, faction: 0, gym: 0, crime: 0 };
        let shockSum = 0, syncSum = 0;

        for (let i = 0; i < n; i++) {
            const sleeve = ns.sleeve.getSleeve(i);
            shockSum += sleeve.shock; syncSum += sleeve.sync;

            const ctx = { ...base, claimedFactions };
            let d = chooseTask(sleeve, ctx);

            // Crime rows (karma/fallback) pick a concrete crime by chance-weighted
            // value, or divert to training when no crime is reliable enough — mirrors
            // pilot's crime row. chooseTask stays pure; the ns-aware step lives here.
            if (d.row === "karma" || d.row === "crime") {
                const r = resolveCrime(ns, sleeve, d.row === "karma" ? "karma" : "money");
                d = r.train ? { row: "gym", stat: r.train } : { row: d.row, crime: r.crime };
            }

            // Assign; on falsy return, fall through by re-choosing with this faction
            // treated as claimed (so a failed faction row can't be re-picked forever).
            const current = ns.sleeve.getTask(i);
            if (matchesCurrent(current, d)) {                 // thrash guard: no-op
                if (d.row === "faction") claimedFactions.add(d.faction);
                counts[d.row]++;
                continue;
            }
            let ok = applyTask(ns, i, d);
            if (!ok && d.row === "faction") {                 // faction failed → retry below it
                claimedFactions.add(d.faction);               // block re-pick this tick
                log(ns, { ev: "claim", sleeve: i, faction: d.faction, ok: false });
                d = chooseTask(sleeve, { ...base, claimedFactions });
                ok = applyTask(ns, i, d);
            }
            if (d.row === "faction" && ok) {
                claimedFactions.add(d.faction);
                log(ns, { ev: "claim", sleeve: i, faction: d.faction, ok: true });
            }
            counts[d.row]++;
            log(ns, { ev: "assign", sleeve: i, from: current?.type ?? "-", to: d.row,
                      reason: d.faction ?? d.crime ?? d.stat ?? d.row, ok: !!ok });
        }

        spentThisRun += spendTick(ns);

        const dominantRow = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        const action = ROW_LABEL[dominantRow] ?? dominantRow;

        publishStatus(ns, STATUS_PORT_SLEEVES, {
            ts: Date.now(),
            count: n,
            avgShock: Math.round(shockSum / n),
            avgSync: Math.round(syncSum / n),
            tasks: counts,
            action,
            spentThisRun: Math.round(spentThisRun),
        });
        log(ns, { ev: "tick", count: n, avgShock: Math.round(shockSum / n),
                  avgSync: Math.round(syncSum / n), ...counts, spentThisRun: Math.round(spentThisRun) });

        await ns.sleep(SLEEVE_LOOP_SLEEP);
    }
}
