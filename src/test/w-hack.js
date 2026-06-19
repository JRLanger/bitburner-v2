/**
 * w-hack.js — instrumented HWGW hack worker for the test rig. Hacks with the given
 * additionalMsec, then (if logFlag) reports its landing to a port so the rig can
 * compare planned vs actual landing and the server state at landing.
 *
 * Args: [0] target, [1] additionalMsec, [2] plannedLand (abs ms), [3] batchId,
 *       [4] port, [5] minSec, [6] maxMoney, [7] logFlag (1 = report)
 */
export async function main(ns) {
    const [target, addMsec, planned, batchId, port, minSec, maxMoney, logFlag] = ns.args;
    await ns.hack(target, { additionalMsec: addMsec });
    if (!logFlag) return;
    const rec = {
        op: "H",
        id: batchId,
        p: planned,
        a: Date.now(),
        s: +(ns.getServerSecurityLevel(target) - minSec).toFixed(3),
        m: +(ns.getServerMoneyAvailable(target) / maxMoney).toFixed(3),
    };
    ns.writePort(port, JSON.stringify(rec));
}
