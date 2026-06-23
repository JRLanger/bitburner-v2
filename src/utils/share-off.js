/**
 * share-off.js — manually pause booster's RAM sharing.
 *
 * Writes "1" to SHARE_OFF_FLAG. booster's sharePhase reads this file each tick
 * (free read) and, while its content is "1", stops launching new share workers;
 * the ones already running finish their ~10s cycle and free their RAM. Run
 * share-on.js to resume. Run manually from the terminal: `run /utils/share-off.js`.
 */
import { SHARE_OFF_FLAG } from "/config/constants.js";

export async function main(ns) {
    ns.write(SHARE_OFF_FLAG, "1", "w");
    ns.tprint(`RAM sharing PAUSED (${SHARE_OFF_FLAG} = "1"). Run share-on.js to resume.`);
}
