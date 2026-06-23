/**
 * share.js — single-shot RAM-share worker. RAM: ~4.0 GB (1.60 base + 2.40 share).
 *
 * Args:
 *   [0] seq  — throwaway disambiguator so otherwise-identical share workers are
 *              distinguishable to `ns.exec`/`ps` (exec refuses a second process
 *              with an identical script+host+args). Not read here; it only needs
 *              to differ between concurrent launches.
 *
 * One ns.share() call is a single ~10s cycle, then the worker exits. booster's
 * sharePhase re-tops-up the share thread count each tick, so when batch/prep
 * demand returns booster simply launches fewer and the running workers free their
 * RAM as they finish — no kill needed. Kept minimal: any extra NS call would raise
 * the per-thread RAM cost.
 */
export async function main(ns) {
    await ns.share();
}
