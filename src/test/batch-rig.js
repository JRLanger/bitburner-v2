/**
 * batch-rig.js — isolated single-target HWGW batcher for diagnosing grid tightness.
 *
 *   run /test/batch-rig.js iron-gym 0.75      (target, hack fraction)
 *   run /test/batch-rig.js foodnstuff 0.75
 *
 * STOP booster first (it would fight the rig over the same target).
 *
 * It preps the target to baseline, locks a plan at min security, then runs a
 * rolling HWGW grid. The scheduler has TWO selectable modes (see CONFIG below) so
 * we can A/B the current booster behaviour against the candidate fix on the SAME
 * deep target:
 *
 *   MODE A — "booster" (current): baseline fire gate ON, grid advances only on a
 *     fire. When the gate is shut (deep pipeline → security bumped most of the
 *     time) fires are missed; nextLand stalls while `now` runs on, so the next
 *     fire clamps addW1 to 0 and lands LATE/off-grid → phase break → drift.
 *
 *   MODE B — "decoupled" (candidate): no gate; the grid advances by WALL-CLOCK.
 *     Any slot that can no longer land cleanly (addW1 would clamp < 0) is SKIPPED,
 *     not fired late. Fresh op-times pin every fired op to its slot regardless of
 *     current security, so landings stay on-grid even on deep pipelines.
 *
 * CRITICAL: by default the rig now runs BOOSTER'S COARSE REGIME (sleep 200, safety
 * 300, max 2 fires/loop, CONCURRENCY_CAP spacing). The old rig used a fine 40ms
 * loop which almost never missed the gate window — that is why it never reproduced
 * the deep-pipeline drift even though it could target deep servers.
 *
 * Instrumented workers report each landing to a port; the rig drains it to
 * /test/rig-log.txt and prints a live summary (landing-error spread, % of landings
 * outside the optimum, and fire/skip/clamp counts that expose the gate starvation).
 */

// ── CONFIG — flip these to A/B/C the schedulers ─────────────────────────────
// MODE C ("self-pacing") overrides the gate/skip flags entirely. Instead of a
// pre-anchored grid that discards missed slots (Mode B), it tracks the committed
// future landings, and each tick fires enough new batches to TOP UP the pipeline
// to its target depth — placing each at lastLand + period. Nothing is skipped or
// discarded: it fills exactly to depth and holds. Goal: same +0.00 / ~2ms timing
// as Mode B but with skipped≈0 and full throughput.
const SELF_PACE = true;     // MODE C on. Overrides USE_GATE / SKIP_LATE below.

const USE_GATE = false;     // MODE A: baseline fire gate on. MODE B: set false.
const SKIP_LATE = true;     // MODE B: set true — advance grid by wall-clock, skip
                            //         slots that would land late instead of firing them.
const CONCURRENCY_CAP = 0;  // 0 = uncapped (raw BATCH_PERIOD spacing, max depth).
                            //     Match booster's 50, or 0 for worst-case depth.
const USE_FRESH_TIMES = true; // false → schedule from min-sec cached times.
const RUN_MINUTES = 5;      // auto-stop after this many minutes (0 = run forever).
                            //   override per-run: run /test/batch-rig.js iron-gym 0.75 10

// Booster's coarse loop regime (the conditions under which drift actually appears).
const LOOP_SLEEP = 200;     // booster LOOP_SLEEP (was 40 in the old fine-loop rig).
const SAFETY = 300;         // booster BATCH_SAFETY_MS (was 50).
const MAX_FIRES_PER_TICK = 8; // per-tick fire cap. Higher than booster's 2 so Mode C
                            //   can refill a deep pipeline in seconds without a spike.

// ── Fixed constants (mirror config/constants.js) ────────────────────────────
const D_GAP = 100;
const BATCH_PERIOD = 4 * D_GAP;
const THREAD_MARGIN = 1.05;
const WEAKEN_SEC = 0.05, GROW_SEC = 0.004, HACK_SEC = 0.002;
const FIRE_SEC_MARGIN = 0.5;          // baseline gate tolerance (security over min)
const PORT = 1;
const LOG = "/test/rig-log.txt";
const W_HACK = "/test/w-hack.js", W_GROW = "/test/w-grow.js", W_WEAK = "/test/w-weaken.js";
const WORKERS = [W_HACK, W_GROW, W_WEAK];

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    const target = ns.args[0] ?? "n00dles";
    const f = ns.args[1] ?? 0.75;
    const runMinutes = ns.args[2] ?? RUN_MINUTES; // 0 = forever
    if (!ns.hasRootAccess(target)) { ns.tprint(`ERROR: no root on ${target}`); return; }

    const mode = SELF_PACE ? "C-selfpace" : !USE_GATE && SKIP_LATE ? "B-decoupled" : USE_GATE ? "A-booster" : "custom";
    const minSec = ns.getServerMinSecurityLevel(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const hosts = discover(ns);
    for (const h of hosts) ns.scp(WORKERS, h, "home");
    const ramPer = ns.getScriptRam(W_GROW); // grow/weaken 1.75-ish, hack a touch less

    ns.write(LOG, `=== rig ${target} f=${f} mode=${mode} gate=${USE_GATE} skipLate=${SKIP_LATE} cap=${CONCURRENCY_CAP} fresh=${USE_FRESH_TIMES} ${new Date().toLocaleTimeString()} ===\n`, "w");
    ns.print(`Prepping ${target}…`);
    await prep(ns, target, minSec, maxMoney, hosts, ramPer);

    // Lock a plan at baseline (min security).
    const hackFrac = ns.hackAnalyze(target);
    const h = Math.ceil(f / hackFrac);
    const g = Math.ceil(ns.growthAnalyze(target, 1 / (1 - f)) * THREAD_MARGIN);
    const w1 = Math.ceil((h * HACK_SEC) / WEAKEN_SEC * THREAD_MARGIN);
    const w2 = Math.ceil((g * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
    const plan = { h, g, w1, w2, minSecWT: ns.getWeakenTime(target), minSecGT: ns.getGrowTime(target), minSecHT: ns.getHackTime(target) };
    const cap = CONCURRENCY_CAP > 0 ? CONCURRENCY_CAP : Infinity;
    const period0 = Math.max(BATCH_PERIOD, plan.minSecWT / cap);
    ns.print(`Mode ${mode}. Plan: h=${h} g=${g} w1=${w1} w2=${w2} wt=${(plan.minSecWT / 1000).toFixed(1)}s`);
    ns.print(`period=${period0.toFixed(0)}ms depth≈${Math.ceil(plan.minSecWT / period0)}`);

    const port = ns.getPortHandle(PORT);
    port.clear();
    let batchId = 0;
    let nextLand = 0; // absolute landing time of the next batch's W1; 0 = (re)anchor
    // MODE C state: committed future W1 landing times, and the most recent one. The
    // pipeline depth at any moment is how many of these are still in the future.
    let committed = [];      // W1 land timestamps of batches still pending
    let lastLand = 0;        // W1 land of the most recently fired batch
    let inFlightNow = 0;     // depth this tick (for the report)
    const errs = [];           // recent landing errors (actual - planned)
    let offBaseline = 0, samples = 0; // how often a landing reads outside baseline
    let firedTotal = 0, skippedTotal = 0, clampedTotal = 0, gateShutLoops = 0, loops = 0;
    let lastReport = Date.now();
    const deadline = runMinutes > 0 ? Date.now() + runMinutes * 60000 : Infinity;

    while (true) {
        const now = Date.now();
        if (now >= deadline) break; // auto-stop after runMinutes
        loops++;
        const wt = USE_FRESH_TIMES ? ns.getWeakenTime(target) : plan.minSecWT;
        const gt = USE_FRESH_TIMES ? ns.getGrowTime(target) : plan.minSecGT;
        const ht = USE_FRESH_TIMES ? ns.getHackTime(target) : plan.minSecHT;
        const period = Math.max(BATCH_PERIOD, wt / cap);

        // Baseline fire gate (MODE A only).
        const atBaseline = ns.getServerSecurityLevel(target) - minSec <= FIRE_SEC_MARGIN;
        if (USE_GATE && !atBaseline) gateShutLoops++;

        const targetDepth = Math.ceil(wt / period); // batches needed to fill the pipeline
        const maxFires = MAX_FIRES_PER_TICK;
        let fired = 0;

        if (SELF_PACE) {
            // ── MODE C: self-pacing top-up ──────────────────────────────────────
            // Drop landings that have already passed, measure remaining depth, and
            // fire just enough to refill to targetDepth. Each new batch lands at
            // lastLand + period (or now + wt + SAFETY if the pipeline ran dry), so
            // landings stay exactly `period` apart with no skipped or discarded slots.
            committed = committed.filter((t) => t > now);
            inFlightNow = committed.length;
            while (committed.length < targetDepth && fired < maxFires) {
                const land = Math.max(now + wt + SAFETY, lastLand + period);
                const pool = buildPool(ns, hosts);
                if (poolFree(pool) < (h + g + w1 + w2) * ramPer) break; // RAM full → top up later
                fireBatch(ns, pool, target, land, now, ht, gt, wt, plan, batchId, minSec, maxMoney, ramPer);
                batchId++;
                firedTotal++;
                lastLand = land;
                committed.push(land);
                fired++;
            }
        } else {
            // (Re)anchor one weaken-time ahead if missing or a slot slipped fully past.
            // MODE A only re-anchors at baseline (mirrors booster); MODE B re-anchors freely.
            if (nextLand === 0 || nextLand < now) {
                if (!USE_GATE || atBaseline) nextLand = now + wt + SAFETY;
            }

            // Launch every slot whose launch-lead has arrived.
            const maxFiresAB = Math.min(MAX_FIRES_PER_TICK, targetDepth);
            while (nextLand !== 0 && now >= nextLand - wt - SAFETY && fired < maxFiresAB) {
                const addW1 = nextLand - now - wt; // < 0 → would clamp → lands late, off-grid

                if (SKIP_LATE && addW1 < 0) {
                    // MODE B: this slot can't land on-grid any more. Drop it and advance
                    // the grid by wall-clock rather than firing a late/colliding batch.
                    nextLand += period;
                    skippedTotal++;
                    continue;
                }
                if (USE_GATE && !atBaseline) break; // MODE A: wait for the gate to open.

                const pool = buildPool(ns, hosts);
                if (poolFree(pool) < (h + g + w1 + w2) * ramPer) break; // can't fit a batch
                if (addW1 < 0) clampedTotal++; // fired anyway (MODE A) → lands late
                fireBatch(ns, pool, target, nextLand, now, ht, gt, wt, plan, batchId, minSec, maxMoney, ramPer);
                batchId++;
                firedTotal++;
                nextLand += period;
                fired++;
            }
        }

        // Drain the landing reports.
        while (!port.empty()) {
            const rec = JSON.parse(port.read());
            const err = rec.a - rec.p;
            errs.push(err);
            if (errs.length > 400) errs.shift();
            samples++;
            // "Outside optimum" = real drift, NOT the designed post-hack money
            // trough. Security over +0.5 is always abnormal; money is only flagged
            // if it falls below the expected post-hack floor ((1-f) with margin),
            // i.e. a genuine collapse rather than the normal mid-cycle dip.
            if (rec.s > 0.5 || rec.m < (1 - f) * 0.9) offBaseline++;
            ns.write(LOG, `${rec.op} ${rec.id} p=${rec.p} a=${rec.a} err=${err} sec=+${rec.s} mon=${(rec.m * 100).toFixed(0)}%\n`, "a");
        }

        if (now - lastReport > 2000) {
            lastReport = now;
            const sorted = [...errs].sort((a, b) => a - b);
            const n = sorted.length;
            const med = n ? sorted[n >> 1] : 0;
            const p95 = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
            const mx = n ? sorted[n - 1] : 0;
            const mn = n ? sorted[0] : 0;
            ns.clearLog();
            ns.print(`RIG ${target} f=${f} MODE ${mode} (cap=${CONCURRENCY_CAP})`);
            ns.print(`batches fired: ${batchId}  depth≈${Math.ceil(wt / period)}${SELF_PACE ? `  inFlight=${inFlightNow}` : ""}`);
            ns.print(`sec now: +${(ns.getServerSecurityLevel(target) - minSec).toFixed(2)}  mon now: ${((ns.getServerMoneyAvailable(target) / maxMoney) * 100).toFixed(0)}%`);
            ns.print(`landing err ms  min=${mn} med=${med} p95=${p95} max=${mx}  (n=${n})`);
            ns.print(`landings outside optimum: ${samples ? ((offBaseline / samples) * 100).toFixed(1) : 0}%  (${offBaseline}/${samples})`);
            ns.print(`fires=${firedTotal} skipped=${skippedTotal} clampedLate=${clampedTotal}  gateShut ${loops ? ((gateShutLoops / loops) * 100).toFixed(0) : 0}% of loops`);
            // Ground-truth RAM check: how much pool the rig actually sees free, the
            // per-batch footprint, and how many batches that free RAM can hold vs the
            // depth we're trying to fill. If batchesFit << depth, the rig is starved
            // (something else — e.g. booster — is holding the pool), NOT a scheduler bug.
            const free = poolFree(buildPool(ns, hosts));
            const batchRam = (h + g + w1 + w2) * ramPer;
            ns.print(`poolFree=${(free / 1e6).toFixed(2)}PB  batchRam=${(batchRam / 1e3).toFixed(2)}TB  batchesFit=${Math.floor(free / batchRam)} / depth ${Math.ceil(wt / period)}`);
        }
        await ns.sleep(LOOP_SLEEP);
    }

    // Auto-stop: kill any workers this rig still has in flight so they stop hitting
    // the target, then print + log a final summary so it's there when you come back.
    for (const host of hosts) {
        for (const proc of ns.ps(host)) {
            if (WORKERS.includes(proc.filename) && proc.args[0] === target) ns.kill(proc.pid);
        }
    }
    const sorted = [...errs].sort((a, b) => a - b);
    const n = sorted.length;
    const p95 = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const summary =
        `DONE ${target} f=${f} MODE ${mode} cap=${CONCURRENCY_CAP} after ${runMinutes}min: ` +
        `fires=${firedTotal} skipped=${skippedTotal} clampedLate=${clampedTotal} ` +
        `errP95=${p95}ms offOptimum=${samples ? ((offBaseline / samples) * 100).toFixed(1) : 0}%`;
    ns.print("─".repeat(40));
    ns.print(summary);
    ns.write(LOG, summary + "\n", "a");
    ns.tprint(summary);
}

function fireBatch(ns, pool, target, base, now, ht, gt, wt, plan, id, minSec, maxMoney, ramPer) {
    const addH = Math.max(0, base - D_GAP - now - ht);
    const addW1 = Math.max(0, base - now - wt);
    const addG = Math.max(0, base + D_GAP - now - gt);
    const addW2 = Math.max(0, base + 2 * D_GAP - now - wt);
    place(ns, pool, W_HACK, plan.h, ramPer, [target, addH, base - D_GAP, id, PORT, minSec, maxMoney]);
    place(ns, pool, W_WEAK, plan.w1, ramPer, [target, addW1, base, id, PORT, minSec, maxMoney, "_", "W1"]);
    place(ns, pool, W_GROW, plan.g, ramPer, [target, addG, base + D_GAP, id, PORT, minSec, maxMoney]);
    place(ns, pool, W_WEAK, plan.w2, ramPer, [target, addW2, base + 2 * D_GAP, id, PORT, minSec, maxMoney, "_", "W2"]);
}

/** Place `threads` of `script` across the pool; only the FIRST chunk reports (logFlag),
 *  so a split op still produces a single landing record. The logFlag slot is index 7. */
function place(ns, pool, script, threads, ramPer, args) {
    let remaining = threads;
    let first = true;
    for (const s of pool) {
        if (remaining <= 0) break;
        const fit = Math.floor(s.free / ramPer);
        const n = Math.min(fit, remaining);
        if (n <= 0) continue;
        const a = args.slice();
        a[7] = first ? 1 : 0; // logFlag
        ns.exec(script, s.host, n, ...a);
        s.free -= n * ramPer;
        remaining -= n;
        first = false;
    }
}

async function prep(ns, target, minSec, maxMoney, hosts, ramPer) {
    while (true) {
        const sec = ns.getServerSecurityLevel(target);
        const money = ns.getServerMoneyAvailable(target);
        if (sec <= minSec + 0.1 && money >= maxMoney * 0.99) return;
        const pool = buildPool(ns, hosts);
        if (sec > minSec + 0.1) {
            const need = Math.ceil((sec - minSec) / WEAKEN_SEC * THREAD_MARGIN);
            place(ns, pool, W_WEAK, need, ramPer, [target, 0, 0, "prep", PORT, minSec, maxMoney, 0, "WP"]);
        } else {
            const need = Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)) * THREAD_MARGIN);
            const counter = Math.ceil((need * GROW_SEC) / WEAKEN_SEC * THREAD_MARGIN);
            place(ns, pool, W_GROW, need, ramPer, [target, 0, 0, "prep", PORT, minSec, maxMoney, 0]);
            place(ns, pool, W_WEAK, counter, ramPer, [target, 0, 0, "prep", PORT, minSec, maxMoney, 0, "WP"]);
        }
        await ns.sleep(ns.getWeakenTime(target) + 400);
    }
}

function discover(ns) {
    const seen = new Set(["home"]), q = ["home"], out = [];
    while (q.length) {
        const host = q.shift();
        for (const n of ns.scan(host)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    for (const h of seen) if (ns.hasRootAccess(h)) out.push(h);
    return out;
}

function buildPool(ns, hosts) {
    const pool = [];
    for (const host of hosts) {
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - (host === "home" ? 16 : 0);
        if (free > 1) pool.push({ host, free });
    }
    return pool.sort((a, b) => b.free - a.free);
}

function poolFree(pool) {
    return pool.reduce((s, x) => s + x.free, 0);
}
