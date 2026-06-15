/**
 * hack.js — single-shot HWGW hack worker. RAM: 1.70 GB (1.60 base + 0.10 hack).
 *
 * Args:
 *   [0] target   — hostname to hack.
 *   [1] delay    — additional ms the engine waits before the hack lands
 *                  (additionalMsec), used to align batch landing order.
 *   [2] batchId  — throwaway disambiguator so otherwise-identical workers are
 *                  distinguishable to `ps`/`kill`. Not read here; it only needs
 *                  to differ between concurrent workers.
 *
 * Kept intentionally minimal: any extra NS call would raise the per-thread RAM
 * cost and bloat every batch. Do not add logging, port writes, etc.
 */
export async function main(ns) {
    const target = ns.args[0];
    const delay = ns.args[1] ?? 0;
    await ns.hack(target, { additionalMsec: delay });
}
