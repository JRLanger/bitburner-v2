/**
 * managers/hacknet.js — hacknet node buyer/upgrader.
 *
 * An independent persistent loop, launched on home by booster only AFTER the pserver
 * fleet is fully built (the HACKNET_GATE — see docs/devlog/02-booster.md). Hacknet has
 * weak ROI, so it's deliberately the last RAM/income investment.
 *
 * Spending decision: buy the available step with the best ROI as long as it pays back
 * within the EXPECTED RUN LENGTH — the span between augmentation installs (lastAugReset),
 * since an aug install wipes hacknet nodes and starts a fresh build-out. The horizon is
 * fixed for the run (it does not change mid-run): HACKNET_FRESH_BN_HORIZON_SECONDS when
 * no run length has been recorded yet, otherwise the last recorded run duration (runs
 * shorten as the BitNode cycle progresses). Marginal production gain per step is derived
 * from getNodeStats production ratios — no Formulas.exe needed.
 *
 * Each tick it drains every affordable step that still pays back (up to a per-tick cap),
 * not just one, so the build-out completes in seconds. It self-kills (frees its home RAM)
 * once nothing left is worth buying within the horizon — there's no point looping,
 * because the horizon is fixed for the run. booster relaunches it next run (after the
 * next aug install) to rebuild.
 *
 * See docs/scripts/hacknet.md for the full write-up.
 */

import {
    HACKNET_FRESH_BN_HORIZON_SECONDS,
    HACKNET_MIN_HORIZON_SECONDS,
    HACKNET_RAM_MULT_BASE,
    MANAGER_LOOP_SLEEP,
    MANAGER_MAX_BUYS_PER_TICK,
    BN_DURATIONS_JSON,
    STATUS_PORT_HACKNET,
} from "/config/constants.js";
import { publishStatus } from "/lib/status.js";

export async function main(ns) {
    ns.disableLog("ALL");

    // Horizon is fixed for the whole run — compute it once (this also records the
    // previous run's duration into the history file, keyed off the aug-reset timestamp).
    const horizon = computeHorizon(ns);

    while (true) {
        const status = step(ns, horizon);
        renderStatus(ns, status);
        publishStatus(ns, STATUS_PORT_HACKNET, {
            ts: Date.now(),
            nodes: status.nodes,
            maxNodes: status.maxNodes,
            production: status.production,
            horizonHrs: status.horizon.seconds / 3600,
            nextCost: status.cost,
            payback: status.payback,
            action: `${status.label} — ${status.decision}`,
        });
        if (status.decision === "done" || status.decision === "exhausted") {
            // Either everything is maxed, or nothing left pays back within the (fixed)
            // run horizon. The horizon won't improve mid-run, so stop looping and exit to
            // free our home RAM; booster rebuilds next run after the next aug install.
            ns.print(status.decision === "done"
                ? "All nodes maxed — exiting."
                : "No upgrades pay back within the run horizon — exiting.");
            return;
        }
        await ns.sleep(MANAGER_LOOP_SLEEP);
    }
}

/**
 * Drain every affordable, ROI-passing step this tick (best ROI first, up to a per-tick
 * cap). Returns a status object for the tail display. decision:
 *   "bought"     — made one or more purchases.
 *   "done"       — every node and upgrade is maxed (exit).
 *   "exhausted"  — at least one action exists but none pays back within the horizon,
 *                  even ignoring affordability → no amount of cash helps (exit).
 *   "waiting…"   — a worthwhile action exists but we can't afford it yet (keep looping).
 */
function step(ns, horizon) {
    let money = ns.getServerMoneyAvailable("home");

    let bought = 0;
    let shown = null; // action reflected in the status box (last bought, or next pending)
    let decision = "done";

    while (bought < MANAGER_MAX_BUYS_PER_TICK) {
        const actions = enumerateActions(ns); // finite-cost candidates only
        if (actions.length === 0) { shown = null; decision = "done"; break; } // fully maxed

        // Best-possible ROI ignoring affordability. If even that can't pay back within
        // the run horizon, nothing ever will (more cash can't change a payback ratio).
        const bestAll = cheapestBy(actions, (a) => a.payback);
        if (bestAll.payback > horizon.seconds) {
            shown = bestAll;
            decision = "exhausted";
            break;
        }

        // Worthwhile (pays back in time) AND affordable right now.
        const worthwhile = actions.filter((a) => a.payback <= horizon.seconds);
        const affordable = worthwhile.filter((a) => a.cost <= money);
        if (affordable.length === 0) {
            shown = cheapestBy(worthwhile, (a) => a.cost); // saving up for the cheapest worthwhile step
            decision = "waiting: saving for next upgrade";
            break;
        }

        const pick = cheapestBy(affordable, (a) => a.payback); // best ROI among affordable
        pick.execute();
        money -= pick.cost;
        bought++;
        shown = pick;
        decision = "bought";
    }

    const nodes = ns.hacknet.numNodes();
    let production = 0;
    for (let i = 0; i < nodes; i++) production += ns.hacknet.getNodeStats(i).production;

    return {
        nodes,
        maxNodes: ns.hacknet.maxNumNodes(),
        money,
        production,
        horizon,
        label: shown ? shown.label : "all nodes maxed",
        cost: shown ? shown.cost : 0,
        payback: shown ? shown.payback : 0,
        bought,
        decision,
    };
}

/**
 * Every finite-cost action available right now: buy a new node, or +1 level / RAM / core
 * on an existing node. Each carries its $ cost and marginal production gain ($/s); an
 * empty result means everything is maxed. Maxed individual options report Infinity cost
 * (from the game getters) and are filtered out.
 */
function enumerateActions(ns) {
    const hn = ns.hacknet;
    const n = hn.numNodes();
    const out = [];

    const stats = [];
    for (let i = 0; i < n; i++) stats.push(hn.getNodeStats(i));

    // Per-node production = mult × nodeFactor(level, ram, cores); mult is constant across
    // a node's upgrades and across nodes, so it cancels in every gain ratio below.
    if (n < hn.maxNumNodes()) {
        const cost = hn.getPurchaseNodeCost();
        if (isFinite(cost)) {
            // A fresh node has nodeFactor(1,1,1) = 1, so its production = baseUnit
            // (= existing production / its factor). With no node yet to derive baseUnit,
            // buy the first node unconditionally (Infinity gain → 0 payback).
            const baseUnit = n > 0 ? stats[0].production / nodeFactor(stats[0].level, stats[0].ram, stats[0].cores) : 0;
            const gain = n === 0 ? Infinity : baseUnit;
            push(out, cost, gain, "buy new node", () => hn.purchaseNode());
        }
    }
    for (let i = 0; i < n; i++) {
        const s = stats[i];
        const base = nodeFactor(s.level, s.ram, s.cores);
        push(out, hn.getLevelUpgradeCost(i, 1),
            s.production * (nodeFactor(s.level + 1, s.ram, s.cores) / base - 1),
            `node ${i} level +1`, () => hn.upgradeLevel(i, 1));
        push(out, hn.getRamUpgradeCost(i, 1),
            s.production * (nodeFactor(s.level, s.ram * 2, s.cores) / base - 1), // a RAM upgrade doubles RAM
            `node ${i} RAM +1`, () => hn.upgradeRam(i, 1));
        push(out, hn.getCoreUpgradeCost(i, 1),
            s.production * (nodeFactor(s.level, s.ram, s.cores + 1) / base - 1),
            `node ${i} core +1`, () => hn.upgradeCore(i, 1));
    }
    return out;
}

/** Production scaling factor (the per-mult-independent part of a node's $/s). */
function nodeFactor(level, ram, cores) {
    return level * Math.pow(HACKNET_RAM_MULT_BASE, ram - 1) * (cores + 5) / 6;
}

/** Add a finite-cost action with its payback (cost / gain) precomputed. */
function push(out, cost, gain, label, execute) {
    if (!isFinite(cost)) return; // maxed option
    out.push({ cost, gain, payback: gain > 0 ? cost / gain : Infinity, label, execute });
}

/** The element minimising key(a). */
function cheapestBy(actions, key) {
    let best = null;
    for (const a of actions) if (!best || key(a) < key(best)) best = a;
    return best;
}

/**
 * Fixed run horizon (seconds) for the ROI test, plus history bookkeeping.
 *
 * BN_DURATIONS_JSON holds { augReset, durations[] }. A run's length is the gap between
 * two consecutive lastAugReset timestamps (an aug install starts a new run), so storing
 * this run's augReset at launch lets the NEXT launch compute this run's full duration —
 * exact even though this manager self-kills early. The horizon is the fresh-run default
 * until a duration is recorded, then the most recent run's duration (runs shorten as the
 * cycle progresses), floored so a freak short run doesn't stall all spending.
 *
 * NOTE: lastAugReset (not lastNodeReset) is the run boundary — installing augmentations
 * is a soft reset that keeps the same BitNode but wipes hacknet nodes.
 */
function computeHorizon(ns) {
    const augReset = ns.getResetInfo().lastAugReset;

    const raw = ns.read(BN_DURATIONS_JSON);
    let hist = null;
    try { hist = raw ? JSON.parse(raw) : null; } catch { hist = null; }

    let dirty = false;
    if (!hist || typeof hist.augReset !== "number" || !Array.isArray(hist.durations)) {
        hist = { augReset, durations: [] }; // seed on first run
        dirty = true;
    }
    if (hist.augReset !== augReset) {
        const dur = augReset - hist.augReset; // previous run's full length
        if (dur > 0) hist.durations.push(dur);
        hist.augReset = augReset;
        dirty = true;
    }
    if (dirty) ns.write(BN_DURATIONS_JSON, JSON.stringify(hist), "w");

    const fresh = hist.durations.length === 0;
    const predictedSec = fresh
        ? HACKNET_FRESH_BN_HORIZON_SECONDS
        : hist.durations[hist.durations.length - 1] / 1000;
    return { seconds: Math.max(HACKNET_MIN_HORIZON_SECONDS, predictedSec), fresh };
}

/** Refresh the tail-window status table each tick. */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 48;
    const hrs = (s.horizon.seconds / 3600).toFixed(1);
    ns.print(`╔═ HACKNET ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 23))}`);
    ns.print(`║ Nodes ${s.nodes}/${s.maxNodes}  |  Production $${ns.format.number(s.production)}/s`);
    ns.print(`║ Cash $${ns.format.number(s.money)}`);
    ns.print(`║ Horizon ${hrs} h ${s.horizon.fresh ? "(fresh run)" : "(last run)"}`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Next: ${s.label}`);
    if (s.cost > 0) {
        ns.print(`║ Cost: $${ns.format.number(s.cost)}  |  payback ${fmtPayback(s.payback)}`);
    }
    const verdict = s.decision === "bought"
        ? `✔ BOUGHT ×${s.bought}`
        : s.decision === "done"
            ? "— done (maxed)"
            : s.decision === "exhausted"
                ? "— done (ROI past horizon)"
                : `… ${s.decision}${s.bought ? ` (after ${s.bought})` : ""}`;
    ns.print(`║ ${verdict}`);
    ns.print(`╚${"═".repeat(W)}`);
}

/** Human-readable payback time. */
function fmtPayback(seconds) {
    if (!isFinite(seconds)) return "∞";
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}
