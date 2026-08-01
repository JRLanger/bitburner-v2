/**
 * sleeve-selftest.js — in-game unit test for the pure sleeve decision core.
 * Run: run /dev/sleeve-selftest.js
 * Prints PASS/FAIL per case to the terminal and appends to the log file.
 * (This project has no node test runner; this is the validate-model.js pattern.)
 */
import { chooseTask, lowestCombatStat, matchesCurrent, GYM_STAT } from "/managers/sleeves.js";
import { SLEEVE_SYNC_MIN, SLEEVE_SHOCK_MAX, SLEEVE_STAT_FLOOR } from "/config/constants.js";

const LOG = "/data/sleeve-selftest.txt";

export async function main(ns) {
    let pass = 0, fail = 0;
    const check = (name, cond) => {
        const line = `${cond ? "PASS" : "FAIL"} ${name}`;
        ns.tprint(line);
        ns.write(LOG, line + "\n", "a");
        cond ? pass++ : fail++;
    };

    // Build a sleeve with all combat stats high enough to pass the gym floor by default.
    const S = (over = {}) => ({
        sync: 100, shock: 0,
        skills: { strength: 200, defense: 200, dexterity: 200, agility: 200, hacking: 200, charisma: 200 },
        ...over,
    });
    const ctx = (over = {}) => ({ gangKarmaPhase: false, pilotFaction: null, claimedFactions: new Set(), ...over });

    // lowestCombatStat
    const low = lowestCombatStat({ strength: 10, defense: 50, dexterity: 30, agility: 40 });
    check("lowestCombatStat picks min", low.stat === "strength" && low.val === 10);

    // Ladder priority
    check("row1 sync when sync low",
        chooseTask(S({ sync: SLEEVE_SYNC_MIN - 1 }), ctx()).row === "sync");
    check("row2 recovery when shock high",
        chooseTask(S({ shock: SLEEVE_SHOCK_MAX + 1 }), ctx()).row === "recovery");
    check("sync beats recovery",
        chooseTask(S({ sync: 1, shock: 99 }), ctx()).row === "sync");
    check("row3 karma homicide",
        (() => { const d = chooseTask(S(), ctx({ gangKarmaPhase: true })); return d.row === "karma" && d.crime === "Homicide"; })());
    check("row4 faction when pilot working unclaimed",
        (() => { const d = chooseTask(S(), ctx({ pilotFaction: "Illuminati" })); return d.row === "faction" && d.faction === "Illuminati"; })());
    check("row4 falls through when faction already claimed",
        chooseTask(S(), ctx({ pilotFaction: "Illuminati", claimedFactions: new Set(["Illuminati"]) })).row === "crime");
    check("karma beats faction",
        chooseTask(S(), ctx({ gangKarmaPhase: true, pilotFaction: "Illuminati" })).row === "karma");
    check("row5 gym when a combat stat below floor",
        (() => { const d = chooseTask(S({ skills: { strength: SLEEVE_STAT_FLOOR - 1, defense: 200, dexterity: 200, agility: 200, hacking: 200, charisma: 200 } }), ctx()); return d.row === "gym" && d.stat === "strength"; })());
    check("row6 crime heist fallback",
        (() => { const d = chooseTask(S(), ctx()); return d.row === "crime" && d.crime === "Heist"; })());

    // matchesCurrent (thrash guard)
    check("matchesCurrent sync", matchesCurrent({ type: "SYNCHRO" }, { row: "sync" }) === true);
    check("matchesCurrent recovery", matchesCurrent({ type: "RECOVERY" }, { row: "recovery" }) === true);
    check("matchesCurrent crime same crime",
        matchesCurrent({ type: "CRIME", crimeType: "Heist" }, { row: "crime", crime: "Heist" }) === true);
    check("matchesCurrent crime diff crime false",
        matchesCurrent({ type: "CRIME", crimeType: "Mug" }, { row: "crime", crime: "Heist" }) === false);
    check("matchesCurrent faction same faction",
        matchesCurrent({ type: "FACTION", factionName: "Illuminati" }, { row: "faction", faction: "Illuminati" }) === true);
    check("matchesCurrent gym same stat",
        matchesCurrent({ type: "CLASS", classType: "str" }, { row: "gym", stat: "strength" }) === true);
    check("matchesCurrent null task false", matchesCurrent(null, { row: "sync" }) === false);

    ns.tprint(`\n=== ${pass} passed, ${fail} failed ===`);
}
