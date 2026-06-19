/**
 * w-grow.js — instrumented HWGW grow worker for the test rig. See w-hack.js.
 *
 * Args: [0] target, [1] additionalMsec, [2] plannedLand (abs ms), [3] batchId,
 *       [4] port, [5] minSec, [6] maxMoney, [7] logFlag (1 = report)
 */
export async function main(ns) {
    const [target, addMsec, planned, batchId, port, minSec, maxMoney, logFlag] = ns.args;
    await ns.grow(target, { additionalMsec: addMsec });
    if (!logFlag) return;
    const rec = {
        op: "G",
        id: batchId,
        p: planned,
        a: Date.now(),
        s: +(ns.getServerSecurityLevel(target) - minSec).toFixed(3),
        m: +(ns.getServerMoneyAvailable(target) / maxMoney).toFixed(3),
    };
    ns.writePort(port, JSON.stringify(rec));
}
