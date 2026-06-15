/**
 * weaken.js — single-shot HWGW weaken worker. RAM: 1.75 GB (1.60 base + 0.15 weaken).
 *
 * Args:
 *   [0] target   — hostname to weaken.
 *   [1] delay    — additional ms the engine waits before the weaken lands
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
    await ns.weaken(target, { additionalMsec: delay });
}
