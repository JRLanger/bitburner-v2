/**
 * validate-model.js
 *
 * Calibration tool: validates the game's hack/grow/weaken model against
 * hardcoded predictions for single-core security deltas, growthAnalyze,
 * hackAnalyze, and hackAnalyzeChance.
 *
 * Each measurement op AUTOMATICALLY establishes the precondition it needs
 * (no manual prep required):
 *   - hack:   prep to baseline (money=max, sec=min), then measure one hack.
 *   - grow:   prep, drain money via hack, weaken security back to min, then
 *             measure one grow (sec at min keeps growthAnalyze honest).
 *   - weaken: prep, raise security above min via hack, then measure one weaken.
 *
 * Usage:
 *   run validate-model.js prep   <target>
 *   run validate-model.js hack   <target> -t N
 *   run validate-model.js grow   <target> -t N
 *   run validate-model.js weaken <target> -t N
 *
 * Tip: use a mid-tier target you're comfortably over-leveled for, and a large
 * thread count (e.g. -t 100) so per-thread rounding is negligible and the
 * ratios converge tightly to 1.0000.
 */

// Hardcoded single-core security deltas, per thread.
const WEAKEN_SEC = 0.05;  // security reduced per weaken thread
const GROW_SEC = 0.004;   // security added per grow thread
const HACK_SEC = 0.002;   // security added per hack thread

const LOG_FILE = "/data/validation-log.txt";

// Safety cap so a setup loop can never spin forever.
const MAX_SETUP_ITERS = 1000;

/** Print a line to the terminal and append it to the validation log file. */
function log(ns, line) {
    ns.tprint(line);
    ns.write(LOG_FILE, line + "\n", "a");
}

function ratio(actual, predicted) {
    return predicted !== 0 ? (actual / predicted).toFixed(4) : "N/A";
}

/**
 * Prep to (near) max money and (near) min security.
 *
 * Two phases instead of alternating grow/weaken every iteration (which would
 * burn a full weaken after every single grow). Phase 1 grows money to max,
 * only weakening if security climbs far enough to noticeably hurt grow
 * efficiency. Phase 2 cleans security down to min once, at the end.
 */
async function prep(ns, target) {
    const minSec = ns.getServerMinSecurityLevel(target);
    const maxMoney = ns.getServerMaxMoney(target);

    // Phase 1: grow to max money. Only weaken if security has drifted high
    // enough (>5 over min) that grow effectiveness suffers.
    for (let i = 0; i < MAX_SETUP_ITERS; i++) {
        const money = ns.getServerMoneyAvailable(target);
        if (money >= maxMoney * 0.99) break;
        const sec = ns.getServerSecurityLevel(target);
        if (sec > minSec + 5) {
            ns.print(`  prep(grow) #${i}: sec ${sec.toFixed(2)} too high, weakening first`);
            await ns.weaken(target);
        } else {
            ns.print(`  prep(grow) #${i}: money ${ns.format.number(money)} -> max ${ns.format.number(maxMoney)}`);
            await ns.grow(target);
        }
    }

    // Phase 2: clean security down to min.
    await weakenToMin(ns, target);
    const sec = ns.getServerSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    ns.print(`  prep done (sec=${sec.toFixed(2)}, money=${ns.format.number(money)})`);
}

/** Weaken until security is back at (near) minimum. */
async function weakenToMin(ns, target) {
    for (let i = 0; i < MAX_SETUP_ITERS; i++) {
        const minSec = ns.getServerMinSecurityLevel(target);
        const sec = ns.getServerSecurityLevel(target);
        if (sec <= minSec + 0.05) {
            ns.print(`  weakenToMin done after ${i} ops (sec=${sec.toFixed(2)})`);
            return;
        }
        ns.print(`  weakenToMin #${i}: sec ${sec.toFixed(2)} -> min ${minSec.toFixed(2)}`);
        await ns.weaken(target);
    }
}

export async function main(ns) {
    const op = ns.args[0];
    const target = ns.args[1];
    const T = ns.getRunningScript().threads;

    const validOps = ["prep", "hack", "grow", "weaken"];
    if (!op || !target || !validOps.includes(op)) {
        ns.tprint("Usage: run validate-model.js <prep|hack|grow|weaken> <target> -t N");
        return;
    }

    // Open a live log window so setup loops (which can run many serial ops)
    // visibly show progress instead of looking hung.
    ns.ui.openTail();
    ns.print(`Running '${op}' on ${target} with ${T} threads. Setup may take a while...`);

    log(ns, `=== ${new Date().toISOString()} | op=${op} target=${target} threads=${T} ===`);

    if (op === "prep") {
        await prep(ns, target);
        const sec = ns.getServerSecurityLevel(target);
        const minSec = ns.getServerMinSecurityLevel(target);
        const money = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        log(ns, `Prepped ${target}:`);
        log(ns, `  Security: ${sec.toFixed(4)} (min: ${minSec.toFixed(4)})`);
        log(ns, `  Money: ${ns.format.number(money)} / ${ns.format.number(maxMoney)}`);
        return;
    }

    if (op === "hack") {
        // Precondition: baseline (money=max, sec=min).
        log(ns, `Setup: prepping to baseline...`);
        await prep(ns, target);

        const moneyBefore = ns.getServerMoneyAvailable(target);
        const secBefore = ns.getServerSecurityLevel(target);

        const fracPerThread = ns.hackAnalyze(target);
        const predictedStolen = moneyBefore * fracPerThread * T;
        const predictedChance = ns.hackAnalyzeChance(target);

        const stolen = await ns.hack(target); // amount stolen, 0 on a failed attempt
        const secAfter = ns.getServerSecurityLevel(target);

        log(ns, `Predicted hack chance: ${predictedChance.toFixed(4)}`);
        log(ns, `Attempt succeeded: ${stolen > 0}`);
        log(ns, `Predicted stolen: ${ns.format.number(predictedStolen)}, actual: ${ns.format.number(stolen)}`);
        log(ns, `Ratio (actual/predicted stolen): ${ratio(stolen, predictedStolen)}`);

        // Hack only raises security on success; a failed attempt shows ~0 delta.
        const predictedSecDelta = T * HACK_SEC;
        const actualSecDelta = secAfter - secBefore;
        log(ns, `Predicted security delta: ${predictedSecDelta.toFixed(4)} (T=${T} * ${HACK_SEC})`);
        log(ns, `Actual security delta: ${actualSecDelta.toFixed(4)}`);
        log(ns, `Ratio (actual/predicted sec): ${ratio(actualSecDelta, predictedSecDelta)}`);
        return;
    }

    if (op === "grow") {
        // Precondition: money well below max, security back at min (so
        // growthAnalyze isn't distorted by elevated security).
        log(ns, `Setup: prepping, then draining money via hack...`);
        await prep(ns, target);
        const maxMoney = ns.getServerMaxMoney(target);
        for (let i = 0; i < MAX_SETUP_ITERS; i++) {
            const money = ns.getServerMoneyAvailable(target);
            if (money <= maxMoney * 0.5) break;
            ns.print(`  drain #${i}: money ${ns.format.number(money)} -> target ${ns.format.number(maxMoney * 0.5)}`);
            await ns.hack(target);
        }
        log(ns, `Setup: weakening security back to min...`);
        await weakenToMin(ns, target);

        const moneyBefore = ns.getServerMoneyAvailable(target);
        const secBefore = ns.getServerSecurityLevel(target);

        await ns.grow(target);

        const moneyAfter = ns.getServerMoneyAvailable(target);
        const secAfter = ns.getServerSecurityLevel(target);

        const actualMult = moneyBefore > 0 ? moneyAfter / moneyBefore : 0;
        const predictedThreads = actualMult > 1 ? ns.growthAnalyze(target, actualMult) : 0;

        log(ns, `Money before: ${ns.format.number(moneyBefore)}, after: ${ns.format.number(moneyAfter)}`);
        log(ns, `Actual growth multiplier: ${actualMult.toFixed(4)}`);
        log(ns, `growthAnalyze says that multiplier needs ~${predictedThreads.toFixed(4)} threads, we used ${T}`);
        log(ns, `Ratio (growthAnalyze threads / actual T): ${ratio(predictedThreads, T)}`);

        const predictedSecDelta = T * GROW_SEC;
        const actualSecDelta = secAfter - secBefore;
        log(ns, `Predicted security delta: ${predictedSecDelta.toFixed(4)} (T=${T} * ${GROW_SEC})`);
        log(ns, `Actual security delta: ${actualSecDelta.toFixed(4)}`);
        log(ns, `Ratio (actual/predicted sec): ${ratio(actualSecDelta, predictedSecDelta)}`);
        return;
    }

    if (op === "weaken") {
        // Precondition: security raised comfortably above min, so the measured
        // weaken won't clamp at the floor.
        //
        // NOTE: we raise security with HACK, not grow. In this game version
        // grow's security increase is proportional to the money actually
        // grown, so growing a server that's already at max money adds ~0
        // security and the headroom loop would never progress. Hack reliably
        // adds 0.002 * T security per successful attempt regardless of money.
        //
        // No prep needed: measuring weaken only cares about the security
        // delta, so the starting money level is irrelevant. We just raise
        // security from wherever it currently is.
        log(ns, `Setup: raising security via hack...`);
        const minSec = ns.getServerMinSecurityLevel(target);
        // Raise headroom to ~1.2x the weaken we're about to measure, enough
        // that the measured weaken won't clamp at the floor.
        const wantHeadroom = T * WEAKEN_SEC * 1.2;
        for (let i = 0; i < MAX_SETUP_ITERS; i++) {
            const headroom = ns.getServerSecurityLevel(target) - minSec;
            if (headroom >= wantHeadroom) break;
            ns.print(`  raise #${i}: headroom ${headroom.toFixed(2)} -> want ${wantHeadroom.toFixed(2)}`);
            await ns.hack(target);
        }

        const secBefore = ns.getServerSecurityLevel(target);
        await ns.weaken(target);
        const secAfter = ns.getServerSecurityLevel(target);

        const predictedDelta = T * WEAKEN_SEC;
        const actualDelta = secBefore - secAfter;
        log(ns, `Security before: ${secBefore.toFixed(4)}, after: ${secAfter.toFixed(4)} (min: ${minSec.toFixed(4)})`);
        log(ns, `Predicted delta: ${predictedDelta.toFixed(4)} (T=${T} * ${WEAKEN_SEC})`);
        log(ns, `Actual delta: ${actualDelta.toFixed(4)}`);
        log(ns, `Ratio (actual/predicted): ${ratio(actualDelta, predictedDelta)}`);
        return;
    }
}
