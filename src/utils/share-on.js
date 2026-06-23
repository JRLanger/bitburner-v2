/**
 * share-on.js — resume booster's RAM sharing after a manual pause.
 *
 * Overwrites SHARE_OFF_FLAG with "0" (the "on" value). On the next tick booster's
 * sharePhase reads it as not-paused and resumes feeding idle pool RAM to
 * ns.share() — note sharing only restarts once there's genuine surplus (the hack-%
 * ramp maxed and prep clear), so it may take a moment to reappear. Run manually
 * from the terminal: `run /utils/share-on.js`.
 */
import { SHARE_OFF_FLAG } from "/config/constants.js";

export async function main(ns) {
    ns.write(SHARE_OFF_FLAG, "0", "w");
    ns.tprint("RAM sharing RESUMED. It restarts once the pool has surplus RAM");
    ns.tprint("(hack-% ramp maxed + prep clear), so give it a few seconds.");
}
