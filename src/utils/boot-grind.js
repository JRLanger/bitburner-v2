/**
 * utils/boot-grind.js — post-reset RAM-bootstrap grind, execed by boot.js.
 *
 * Automates devlog 01's manual 20-minute routine: train stats at a gym (only if
 * Mug's success chance is poor), then loop Mug crime + upgradeHomeRam() until
 * home reaches BOOT_TARGET_HOME_GB. This is a SEPARATE one-shot script (not code
 * inside boot.js) purely for RAM reasons — see docs/scripts/boot.md "Why a
 * separate grind script": every ns.singularity.* call here is RAM-multiplied
 * ×16/×4/×1 by SF4 level, and even at SF4.3 (×1) the handful of calls this
 * routine needs (isBusy, getCrimeChance, commitCrime, gymWorkout,
 * getUpgradeHomeRamCost, upgradeHomeRam) sum well past boot.js's 8 GB ceiling.
 * Splitting them into their own process means boot.js's OWN static RAM stays
 * tiny (ns.exec is a flat 1.3 GB regardless of what it launches); this script's
 * RAM is charged only while it is itself running, on whatever home RAM is
 * currently available.
 *
 * Run standalone (not as a manager): does its job once, then exits. boot.js
 * execs this exactly once per bring-up when SF4 is available and home is below
 * BOOT_TARGET_HOME_GB; it self-exits immediately at gate-fail so it's always
 * safe to exec speculatively.
 */

import {
    BOOT_TARGET_HOME_GB,
    BOOT_MUG_MIN_CHANCE,
} from "/config/constants.js";

const BOOTSTRAP_CRIME = "Mug";
/** Stats devlog 01 trains before Mug — chosen because they're exactly the stats
 *  that gate Mug's success chance. */
const GYM_STATS = ["str", "def", "dex", "agi"];
/** Gym location used for training (devlog 01 doesn't pin one; any city gym
 *  works — Sector12PowerhouseGym is the default starting-city option). */
const GYM_LOCATION = "Sector12PowerhouseGym";
/** Target stat level devlog 01 trains to (unlocks ~50% Mug chance). */
const GYM_TARGET_LEVEL = 25;

export async function main(ns) {
    ns.disableLog("ALL");
    const sing = ns.singularity;

    if (!singularityAvailable(ns)) {
        ns.tprint("boot-grind: Singularity API unavailable — exiting (manual grind needed).");
        return;
    }

    // Gym pre-step only if Mug's chance is currently poor (per the plan: skip the
    // gym entirely when getCrimeChance('Mug') already clears the threshold).
    if (sing.getCrimeChance(BOOTSTRAP_CRIME) < BOOT_MUG_MIN_CHANCE) {
        await trainStats(ns);
    }

    await mugToTarget(ns);
    ns.tprint("boot-grind: done — home RAM target reached (or Mug no longer improving it).");
}

function singularityAvailable(ns) {
    try {
        ns.singularity.isBusy();
        return true;
    } catch {
        return false;
    }
}

/** Train STR/DEF/DEX/AGI to GYM_TARGET_LEVEL, one stat at a time. Uses
 *  ns.getPlayer().skills to know when to move to the next stat. */
async function trainStats(ns) {
    const sing = ns.singularity;
    for (const stat of GYM_STATS) {
        while (currentSkill(ns, stat) < GYM_TARGET_LEVEL) {
            if (!sing.gymWorkout(GYM_LOCATION, stat, false)) break; // can't train — bail this stat
            await ns.sleep(1000); // workouts run until stopped; poll rather than await a duration
        }
        sing.stopAction();
    }
}

function currentSkill(ns, stat) {
    const skills = ns.getPlayer().skills;
    switch (stat) {
        case "str": return skills.strength;
        case "def": return skills.defense;
        case "dex": return skills.dexterity;
        case "agi": return skills.agility;
        default: return Infinity;
    }
}

/** Loop Mug, upgrading home RAM whenever affordable, until home hits the target
 *  or Mug stops being worth running (shouldn't happen — money only grows). */
async function mugToTarget(ns) {
    const sing = ns.singularity;
    while (ns.getServerMaxRam("home") < BOOT_TARGET_HOME_GB) {
        const cost = sing.getUpgradeHomeRamCost();
        if (ns.getServerMoneyAvailable("home") >= cost) {
            sing.upgradeHomeRam();
            continue; // re-check target immediately after a successful upgrade
        }
        const durationMs = sing.commitCrime(BOOTSTRAP_CRIME, false);
        await ns.sleep(durationMs + 50); // small margin past the reported duration
    }
    sing.stopAction();
}
