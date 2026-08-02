/**
 * utils/force-install.js — force the pre-reset aug-install sequence NOW.
 *
 * Sets the `forceInstall` runtime flag (lib/flags.js). lifecycle.js reads it at
 * the top of every tick and, when set, runs its FULL pre-reset checklist
 * immediately — bypassing BOTH the install-decision thresholds AND the autonomy
 * guard (LIFECYCLE_AUTO_INSTALL / autoInstall). That checklist is the same tested
 * sequence a normal auto-install runs: freeze spending → batch-buy every rep-met
 * aug (priority tier first, most-expensive-first) → dump NeuroFlux (donating to
 * close each level's rep gap when favor allows) → spend leftover money to favor →
 * log → installAugmentations(boot.js).
 *
 * WHY route through lifecycle instead of doing it here: the checklist is built on
 * ns.singularity.* calls whose RAM is multiplied ×16/×4/×1 by SF4 level — that
 * cost already lives in lifecycle's running process. Duplicating it in a
 * standalone script would re-pay that whole RAM bill. So this util is a tiny
 * 0-GB flag-setter; lifecycle does the work.
 *
 * REQUIREMENTS: lifecycle.js must already be running (it launches once the SF4
 * gate passes). If it isn't, the flag just waits until it next starts. There is
 * up to LIFECYCLE_LOOP_SLEEP (60s) of latency before the checklist begins.
 *
 * The flag lives in the flag port, so it clears automatically on the next reset;
 * lifecycle also consumes it the moment it acts, so it never re-fires. This is
 * destructive (it WILL install augs and reset the run) — run it only when a reset
 * is genuinely wanted right now. Run from the terminal: `run /utils/force-install.js`.
 */
import { setFlag } from "/lib/flags.js";
import { LIFECYCLE_MANAGER } from "/config/constants.js";

export async function main(ns) {
    setFlag(ns, "forceInstall", true);

    // ns.ps() reports filenames WITHOUT a leading slash (e.g. "managers/lifecycle.js"),
    // while LIFECYCLE_MANAGER is "/managers/lifecycle.js" — strip the slash before comparing
    // (same normalization booster/orbiter use via stripSlash).
    const target = LIFECYCLE_MANAGER.replace(/^\//, "");
    const lifecycleUp = ns.ps("home").some((p) => p.filename.replace(/^\//, "") === target);
    if (lifecycleUp) {
        ns.tprint(
            "FORCE INSTALL armed. lifecycle will run the full pre-reset checklist " +
            "(buy augs → donate for rep → dump NeuroFlux → spend down favor → install) " +
            "within the next tick (~60s). The run WILL reset. No further confirmation."
        );
    } else {
        ns.tprint(
            "WARNING: force-install flag set, but lifecycle.js is not running on home. " +
            "The forced install will begin as soon as lifecycle next launches (needs the " +
            "SF4 gate to pass). If you didn't expect that, clear it by resetting or by " +
            "starting lifecycle."
        );
    }
}
