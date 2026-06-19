/**
 * managers/hacknet.js — hacknet node buyer/upgrader.
 *
 * An independent persistent loop, launched on home by booster only AFTER the
 * pserver fleet is fully built (the HACKNET_GATE — see docs/devlog/02-booster.md).
 * Hacknet has weak ROI, so it's deliberately the last RAM/income investment.
 *
 * Spending uses the same two-arm rule as the pserver manager: buy the single
 * cheapest available action (new node, or a level/RAM/core upgrade) when it pays
 * back within HACKNET_PAYBACK_SECONDS of current income, OR costs ≤
 * HACKNET_REINVEST_FRAC of current cash.
 *
 * See docs/scripts/hacknet.md for the full write-up.
 */

import {
    HACKNET_PAYBACK_SECONDS,
    HACKNET_REINVEST_FRAC,
    HACKNET_REINVEST_FLOOR,
    HACKNET_BOOTSTRAP_NODES,
    MANAGER_LOOP_SLEEP,
} from "/config/constants.js";

export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();

    while (true) {
        const status = step(ns);
        renderStatus(ns, status);
        await ns.sleep(MANAGER_LOOP_SLEEP);
    }
}

/**
 * Make at most one purchase this tick: the cheapest action that passes the test.
 * Returns a status object for the tail display.
 */
function step(ns) {
    const income = ns.getTotalScriptIncome()[0]; // $/s across all scripts
    const money = ns.getServerMoneyAvailable("home");
    const nodes = ns.hacknet.numNodes();

    // Same decay as pserver, keyed to node count toward HACKNET_BOOTSTRAP_NODES.
    const progress = Math.min(1, nodes / HACKNET_BOOTSTRAP_NODES);
    const reinvestFrac =
        HACKNET_REINVEST_FLOOR + (HACKNET_REINVEST_FRAC - HACKNET_REINVEST_FLOOR) * (1 - progress);

    const base = { nodes, maxNodes: ns.hacknet.maxNumNodes(), income, money, progress, reinvestFrac };

    const move = cheapestAction(ns);
    if (!move) return { ...base, label: "all nodes maxed", cost: 0, decision: "done" };

    const decision = shouldBuy(move.cost, income, money, reinvestFrac)
        ? (move.execute(), "bought")
        : move.cost > money
            ? "waiting: insufficient $"
            : "waiting: accumulating cash";
    return { ...base, label: move.label, cost: move.cost, decision };
}

/**
 * Cheapest action across buying a new node and upgrading any existing node's
 * level / RAM / cores by one step. Maxed-out options report Infinity cost and are
 * naturally never chosen. Returns null if no finite-cost action exists.
 */
function cheapestAction(ns) {
    const hn = ns.hacknet;
    let best = null;
    const consider = (cost, label, execute) => {
        if (cost < Infinity && (!best || cost < best.cost)) best = { cost, label, execute };
    };

    if (hn.numNodes() < hn.maxNumNodes()) {
        consider(hn.getPurchaseNodeCost(), "buy new node", () => hn.purchaseNode());
    }
    for (let i = 0; i < hn.numNodes(); i++) {
        consider(hn.getLevelUpgradeCost(i, 1), `node ${i} level +1`, () => hn.upgradeLevel(i, 1));
        consider(hn.getRamUpgradeCost(i, 1), `node ${i} RAM +1`, () => hn.upgradeRam(i, 1));
        consider(hn.getCoreUpgradeCost(i, 1), `node ${i} core +1`, () => hn.upgradeCore(i, 1));
    }
    return best;
}

/** Refresh the tail-window status table each tick. */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 48;
    ns.print(`╔═ HACKNET ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 23))}`);
    ns.print(`║ Nodes ${s.nodes}/${s.maxNodes}`);
    ns.print(`║ Income $${ns.format.number(s.income)}/s  |  Cash $${ns.format.number(s.money)}`);
    ns.print(`║ Bootstrap ${Math.round(s.progress * 100)}%  |  reinvest ${(s.reinvestFrac * 100).toFixed(1)}%`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Next: ${s.label}`);
    if (s.cost > 0) ns.print(`║ Cost: $${ns.format.number(s.cost)}`);
    ns.print(`║ ${s.decision === "bought" ? "✔ BOUGHT" : s.decision === "done" ? "— idle" : "… " + s.decision}`);
    ns.print(`╚${"═".repeat(W)}`);
}

/** Same buy test as the pserver manager (payback OR reinvest-fraction). */
function shouldBuy(cost, income, money, reinvestFrac) {
    if (cost > money) return false;
    const paysBack = cost <= income * HACKNET_PAYBACK_SECONDS;
    const reinvest = cost <= money * reinvestFrac;
    return paysBack || reinvest;
}
