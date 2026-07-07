/**
 * utils/auto-install-on.js — arm lifecycle's automatic augmentation install.
 *
 * Sets the `autoInstall` runtime flag (lib/flags.js). lifecycle.js reads it each
 * tick alongside the LIFECYCLE_AUTO_INSTALL constant (either being true arms it —
 * see docs/plans/reset-lifecycle.md "Autonomy guard"); once armed, lifecycle will
 * actually run the pre-reset checklist and call installAugmentations() the next
 * time its install-decision thresholds are met, with NO further confirmation.
 * This is the scary one — only run it when a reset is genuinely wanted soon.
 * The flag lives in the flag port, so it clears automatically on the next reset
 * (never stays armed into the following run by accident). Run manually from the
 * terminal: `run /utils/auto-install-on.js`.
 */
import { setFlag } from "/lib/flags.js";

export async function main(ns) {
    setFlag(ns, "autoInstall", true);
    ns.tprint(
        "lifecycle auto-install ARMED. The next time pending augs and stagnation " +
        "cross the configured thresholds, lifecycle will run the pre-reset checklist " +
        "and install automatically — no further confirmation. Run auto-install-off.js to disarm."
    );
}
