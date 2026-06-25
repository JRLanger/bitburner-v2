/**
 * lag-probe.js — measure engine lag / batch landing error, for data-driven tuning.
 *
 * Bitburner runs every script on one shared game loop, so `await ns.sleep(T)` resolves
 * no SOONER than T ms but LATER under load. This probe quantifies that so timing
 * constants (BATCH_SAFETY_MS, D_GAP, LOOP_SLEEP, MAX_BATCH_TARGETS, MAX_FIRES_PER_TICK)
 * can be tuned against real numbers instead of guesses. Run it ALONGSIDE the controller
 * to see the lag the controller's batches actually experience.
 *
 * Two modes:
 *
 *   run test/lag-probe.js sleep [intervalMs]
 *     Near-zero-work sleep loop. excess = (actual elapsed − interval) = PURE engine
 *     lag (this script adds no work, so the excess is all engine). This is the
 *     scheduling-latency floor every other script — including the batcher — also pays.
 *     Compare to the controller's `gap`: controller_gap − probe_excess ≈ controller work.
 *
 *   run test/lag-probe.js land <target> [additionalMsec]
 *     Schedules a single weaken to land `getWeakenTime + additionalMsec` from now and
 *     measures how late it ACTUALLY finishes. This is the real batch-relevant metric:
 *     landing error. Use a prepped, already-min-security target (weaken is then a
 *     harmless no-op) you have root on, e.g. a small server or n00dles. additionalMsec
 *     mirrors how the batcher pads landings (default 0).
 *
 * Both modes keep a rolling window and print min / median / p90 / p99 / max plus a
 * SLOW count (samples over `SLOW_MS`). Append raw samples to a CSV for offline
 * plotting by passing `--csv` (writes /data/lag-<mode>.csv).
 *
 * KEEP THE GAME TAB FOCUSED while measuring: a background tab is throttled to ~1
 * timer/sec by the browser, which shows up as enormous fake lag.
 */

const WINDOW = 300;        // rolling samples kept for the percentile summary
const SLOW_MS = 150;       // a sample over this (above the ideal) is counted "SLOW".
                           // ≈ a typical p99 lag, so it flags genuine stalls, not the
                           // baseline excess (which sits near the median).
const PRINT_EVERY = 5;     // refresh the summary every N samples

/** Percentile (0..1) of a numeric array via nearest-rank on a sorted copy. */
function pct(sorted, p) {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[i];
}

function summarize(ns, label, unit, samples, csvFile) {
    const sorted = [...samples].sort((a, b) => a - b);
    // SLOW is windowed (counted over the current sample window), not cumulative, so it
    // reflects the recent stall rate rather than growing without bound.
    const slow = samples.reduce((c, x) => (x > SLOW_MS ? c + 1 : c), 0);
    ns.clearLog();
    ns.print(`╔═ LAG PROBE — ${label} ═══════════════════════`);
    ns.print(`║ samples ${samples.length} (window ${WINDOW})  |  SLOW(>${SLOW_MS}ms) ${slow}`);
    ns.print(`║ min    ${pct(sorted, 0).toFixed(1)} ${unit}`);
    ns.print(`║ median ${pct(sorted, 0.5).toFixed(1)} ${unit}`);
    ns.print(`║ p90    ${pct(sorted, 0.9).toFixed(1)} ${unit}`);
    ns.print(`║ p99    ${pct(sorted, 0.99).toFixed(1)} ${unit}`);
    ns.print(`║ max    ${pct(sorted, 1).toFixed(1)} ${unit}`);
    if (csvFile) ns.print(`║ csv → ${csvFile}`);
    ns.print(`╚═══════════════════════════════════════════════`);
}

export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();

    const mode = ns.args[0];
    const csv = ns.args.includes("--csv");
    const samples = [];
    let n = 0;

    if (mode === "sleep") {
        const interval = Number(ns.args[1]) || 200;
        const csvFile = csv ? "/data/lag-sleep.csv" : null;
        if (csvFile) ns.write(csvFile, "sample_ms,excess_ms\n", "w");
        let last = Date.now();
        while (true) {
            await ns.sleep(interval);
            const now = Date.now();
            const excess = now - last - interval; // actual elapsed beyond the request = engine lag
            last = now;
            samples.push(excess);
            if (samples.length > WINDOW) samples.shift();
            if (csvFile) ns.write(csvFile, `${now},${excess.toFixed(1)}\n`, "a");
            if (++n % PRINT_EVERY === 0) summarize(ns, `sleep ${interval}ms`, "ms", samples, csvFile);
        }
    }

    if (mode === "land") {
        const target = ns.args[1];
        const pad = Number(ns.args[2]) || 0;
        if (!target) { ns.tprint("Usage: run test/lag-probe.js land <target> [additionalMsec]"); return; }
        if (!ns.hasRootAccess(target)) { ns.tprint(`ERROR: no root on ${target}`); return; }
        const csvFile = csv ? "/data/lag-land.csv" : null;
        if (csvFile) ns.write(csvFile, "finish_ms,error_ms\n", "w");
        while (true) {
            const intended = ns.getWeakenTime(target) + pad;
            const t0 = Date.now();
            await ns.weaken(target, { additionalMsec: pad });
            const error = (Date.now() - t0) - intended; // how much later than intended it finished
            samples.push(error);
            if (samples.length > WINDOW) samples.shift();
            if (csvFile) ns.write(csvFile, `${Date.now()},${error.toFixed(1)}\n`, "a");
            if (++n % PRINT_EVERY === 0) summarize(ns, `land ${target} +${pad}ms`, "ms", samples, csvFile);
        }
    }

    ns.tprint("Usage: run test/lag-probe.js <sleep [intervalMs] | land <target> [additionalMsec]> [--csv]");
}
