/**
 * utils/auto-install-off.js — disarm lifecycle's automatic augmentation install.
 *
 * Clears the `autoInstall` runtime flag (lib/flags.js). lifecycle.js reverts to
 * recommend-only: it will keep publishing `recommendInstall` + a reason once
 * thresholds are met, but will never call installAugmentations() itself. Run
 * manually from the terminal: `run /utils/auto-install-off.js`.
 */
import { setFlag } from "/lib/flags.js";

export async function main(ns) {
    setFlag(ns, "autoInstall", false);
    ns.tprint("lifecycle auto-install DISARMED — back to recommend-only.");
}
