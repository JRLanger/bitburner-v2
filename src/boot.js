/**
 * boot.js — post-reset bring-up (docs/plans/reset-lifecycle.md Part A).
 *
 * Passed as the `cbScript` argument to every `installAugmentations`/`softReset`/
 * `destroyW0r1dD43m0n` call (lifecycle.js and utils/finish-bn.js), the game
 * auto-runs this single-threaded on home immediately after a reset. It also
 * tolerates being run manually mid-game (idempotent no-op if booster/orbiter is
 * already up).
 *
 * MUST stay tiny: measured/estimated ≤ 8 GB (see docs/scripts/boot.md for the
 * full calculation) so it always fits home's worst-case post-reset RAM. This is
 * why it imports ONLY 0-GB modules (config/constants.js — pure data, no NS
 * calls) and never calls a single ns.singularity.* function itself — the actual
 * grind (gym + Mug + upgradeHomeRam) lives in the separate one-shot
 * utils/boot-grind.js, execed as its own process so ITS RAM is charged
 * separately and never taxes boot.js's static analysis.
 *
 * Sequence:
 *   1. Idempotence check — if booster or orbiter is already running on home,
 *      do nothing (covers a manual mid-game run, and a reset landing on a
 *      process that survived it).
 *   2. If home RAM ≥ BOOT_TARGET_HOME_GB, skip the grind (aug multipliers can
 *      make it unnecessary later in a run) — exec booster.js and exit.
 *   3. Else, if Singularity is available, exec utils/boot-grind.js and AWAIT its
 *      completion (ns.isRunning polling — 0 GB) before continuing, so booster
 *      isn't launched onto a still-tiny home mid-grind.
 *   4. If Singularity is unavailable, skip the grind (can't automate it) and
 *      leave a tail message pointing at the manual devlog-01 checklist.
 *   5. exec booster.js, exit.
 */

import {
    BOOT_TARGET_HOME_GB,
    BOOT_GRIND_SCRIPT,
    BOOSTER_SCRIPT,
    ORBITER,
} from "/config/constants.js";

export async function main(ns) {
    ns.disableLog("ALL");

    if (alreadyUp(ns)) {
        ns.tprint("boot.js: booster/orbiter already running — nothing to do.");
        return;
    }

    if (ns.getServerMaxRam("home") < BOOT_TARGET_HOME_GB) {
        if (sf4Available(ns)) {
            const pid = ns.exec(BOOT_GRIND_SCRIPT, "home");
            if (pid !== 0) {
                while (ns.isRunning(pid)) {
                    await ns.sleep(2000);
                }
            } else {
                // Known limitation: on a true fresh-BitNode 8 GB home, boot-grind
                // (~17 GB at SF4.3) cannot fit — the manual devlog-01 routine is
                // still required there. Say so instead of failing silently.
                ns.tprint(
                    "boot.js: couldn't launch boot-grind (not enough free home RAM). " +
                    "Do the manual devlog-01 grind (docs/devlog/01-bn-reset-checklist.md), " +
                    "then re-run boot.js."
                );
            }
        } else {
            ns.tprint(
                "boot.js: no Singularity access — can't auto-grind home RAM. " +
                "Run the devlog-01 checklist manually (docs/devlog/01-bn-reset-checklist.md), " +
                "then run booster.js yourself, or just re-run boot.js once done."
            );
        }
    }

    const boosterPid = ns.exec(BOOSTER_SCRIPT, "home");
    if (boosterPid === 0) {
        ns.tprint(
            "boot.js: FAILED to launch booster (not enough free home RAM?). " +
            "Free some RAM or grow home, then run booster.js manually."
        );
    }
}

/** True if booster.js or orbiter.js is already a running process on home —
 *  covers both a manual mid-game invocation and a reset landing where a
 *  controller process survived. */
function alreadyUp(ns) {
    const running = ns.ps("home").map((p) => p.filename);
    return running.includes(stripSlash(BOOSTER_SCRIPT)) || running.includes(stripSlash(ORBITER));
}

/** Same SF4 gate pilot/lifecycle use (see booster.js's pilotGate): SF4 owned at
 *  any level, or the current run IS BitNode 4 (Singularity is free there
 *  regardless of SF level). getResetInfo is a flat 1 GB top-level call — NOT
 *  under ns.singularity, so it carries none of the ×16/4/1 multiplier that ruled
 *  out calling ns.singularity.isBusy() directly from boot.js (would have pushed
 *  boot.js's own footprint past 8 GB at low SF4 levels). */
function sf4Available(ns) {
    const info = ns.getResetInfo();
    const sf4Level = info.ownedSF.get(4) ?? 0;
    return sf4Level > 0 || info.currentNode === 4;
}

function stripSlash(path) {
    return path.startsWith("/") ? path.slice(1) : path;
}
