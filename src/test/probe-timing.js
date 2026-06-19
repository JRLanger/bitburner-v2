/**
 * probe-timing.js — establishes the Netscript timing semantics the HWGW scheduler
 * depends on, on a single throwaway target. Run on a server you can root; defaults
 * to n00dles. Prints results to the terminal.
 *
 *   run /test/probe-timing.js            (uses n00dles)
 *   run /test/probe-timing.js foodnstuff
 *
 * Requires /test/probe-bump.js on home (for the mid-flight test).
 *
 * Questions answered:
 *   Q1 Does weaken DURATION depend on current security? (min vs elevated)
 *   Q2 Is additionalMsec purely additive? (duration + d)
 *   Q3 THE CRUX: is an op's duration LOCKED at call time, or recomputed from
 *      security at landing? Start a long weaken at min security, raise security
 *      mid-flight, and see whether the weaken lands on its call-time schedule
 *      (LOCKED) or late (RECOMPUTED at land).
 */
export async function main(ns) {
    ns.disableLog("ALL");
    const target = ns.args[0] ?? "n00dles";
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: no root on ${target}`);
        return;
    }
    const min = ns.getServerMinSecurityLevel(target);
    const sec = () => ns.getServerSecurityLevel(target);
    const prep = async () => {
        while (sec() > min + 0.01) await ns.weaken(target);
    };
    const L = (m) => ns.tprint(m);

    L(`=== probe-timing on ${target} (min sec ${min}) ===`);

    // ── Q1: duration vs security ────────────────────────────────────────────
    await prep();
    let reportedMin = ns.getWeakenTime(target);
    let t0 = Date.now();
    await ns.weaken(target);
    const durMin = Date.now() - t0;
    L(`Q1 MIN  sec=${sec().toFixed(3)} getWeakenTime=${reportedMin.toFixed(0)} actual=${durMin}ms`);

    for (let i = 0; i < 30; i++) await ns.grow(target); // raise security
    const secHigh = sec();
    const reportedHigh = ns.getWeakenTime(target);
    t0 = Date.now();
    await ns.weaken(target);
    const durHigh = Date.now() - t0;
    L(`Q1 HIGH sec=${secHigh.toFixed(3)} getWeakenTime=${reportedHigh.toFixed(0)} actual=${durHigh}ms`);
    L(`   → duration ${durHigh > durMin + 200 ? "DEPENDS on current security" : "is independent of security"} (Δ=${durHigh - durMin}ms)`);

    // ── Q2: additionalMsec additivity (at min security) ─────────────────────
    await prep();
    const base = ns.getWeakenTime(target);
    t0 = Date.now();
    await ns.weaken(target, { additionalMsec: 3000 });
    const durAdd = Date.now() - t0;
    L(`Q2 additionalMsec=3000: base=${base.toFixed(0)} actual=${durAdd}ms expect≈${(base + 3000).toFixed(0)} → ${Math.abs(durAdd - (base + 3000)) < 300 ? "ADDITIVE" : "NOT additive"}`);

    // ── Q3: is duration locked at call, or recomputed at land? ──────────────
    // Start a long weaken at MIN security, then raise security ~2s in via
    // probe-bump.js. If the weaken lands ~on its call-time schedule, duration is
    // LOCKED at call → the scheduler must use CURRENT (call-time) op-times for
    // delays. If it lands much later, duration tracks landing-security.
    await prep();
    if (!ns.fileExists("/test/probe-bump.js", "home")) {
        L("Q3 SKIPPED: /test/probe-bump.js not found on home");
        return;
    }
    const wtMin = ns.getWeakenTime(target);
    const ADD = 6000;
    ns.exec("/test/probe-bump.js", "home", 1, target, 2000, 60); // bump ~2s in
    t0 = Date.now();
    await ns.weaken(target, { additionalMsec: ADD });
    const durBump = Date.now() - t0;
    const expectLocked = wtMin + ADD;
    L(`Q3 mid-flight bump: callWeakenTime=${wtMin.toFixed(0)}+${ADD} expect≈${expectLocked.toFixed(0)} actual=${durBump}ms`);
    L(`   → ${durBump > expectLocked + 500 ? "RECOMPUTED at land (tracks landing security)" : "LOCKED at call (use current op-times for delays)"}`);
    L(`=== done; re-prep ${target} before batching it ===`);
}
