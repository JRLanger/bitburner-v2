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
 *   [3] expLand  — OPTIONAL expected landing timestamp (ms epoch). When > 0 the
 *                  worker reports its actual landing to the telemetry port.
 *   [4] opTag    — OPTIONAL op label for the telemetry record ("W1"/"W2").
 *   [5] threads  — OPTIONAL thread count of this exec, echoed in the record.
 *
 * Telemetry (drift diagnosis): [opTag, target, expLand, actualLand, ret, threads]
 * via ns.writePort — 0 GB, so per-thread RAM is unchanged. `ret` is the security
 * actually reduced (< 0.05×threads just means the min-security floor clamped it).
 * Port 6 is HARDCODED (must match TELEMETRY_PORT in config/constants.js): this
 * file is scp'd standalone to every rooted host, where an import would not resolve.
 *
 * Kept intentionally minimal: any extra NS call would raise the per-thread RAM
 * cost and bloat every batch. Do not add logging beyond the 0 GB port write.
 */
export async function main(ns) {
    const target = ns.args[0];
    const delay = ns.args[1] ?? 0;
    const ret = await ns.weaken(target, { additionalMsec: delay });
    const expLand = ns.args[3] ?? 0;
    if (expLand > 0) {
        ns.writePort(6, [ns.args[4] ?? "W", target, expLand, Date.now(), ret, ns.args[5] ?? 0]);
    }
}
