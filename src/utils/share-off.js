/**
 * share-off.js — manually pause booster's RAM sharing.
 *
 * Sets the SHARE_OFF_FLAG flag in the shared flag port (lib/flags.js). booster's
 * sharePhase reads it each tick and, while set, stops launching new share workers; the
 * ones already running finish their ~10s cycle and free their RAM. Run share-on.js to
 * resume. The flag lives in a port, so the pause clears on aug/soft reset and game
 * reload. Run manually from the terminal: `run /utils/share-off.js`.
 */
import { SHARE_OFF_FLAG } from "/config/constants.js";
import { setFlag } from "/lib/flags.js";

export async function main(ns) {
    setFlag(ns, SHARE_OFF_FLAG, true);
    ns.tprint("RAM sharing PAUSED. Run share-on.js to resume.");
}
