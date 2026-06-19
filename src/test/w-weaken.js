/**
 * w-weaken.js — instrumented HWGW weaken worker for the test rig. See w-hack.js.
 * The `op` label is passed in so W1 (clears hack security) and W2 (clears grow
 * security) are distinguishable in the log.
 *
 * Args: [0] target, [1] additionalMsec, [2] plannedLand (abs ms), [3] batchId,
 *       [4] port, [5] minSec, [6] maxMoney, [7] logFlag (1 = report), [8] op label
 */
export async function main(ns) {
    const [target, addMsec, planned, batchId, port, minSec, maxMoney, logFlag, label] = ns.args;
    await ns.weaken(target, { additionalMsec: addMsec });
    if (!logFlag) return;
    const rec = {
        op: label,
        id: batchId,
        p: planned,
        a: Date.now(),
        s: +(ns.getServerSecurityLevel(target) - minSec).toFixed(3),
        m: +(ns.getServerMoneyAvailable(target) / maxMoney).toFixed(3),
    };
    ns.writePort(port, JSON.stringify(rec));
}
