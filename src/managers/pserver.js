/**
 * managers/pserver.js — purchased-server buyer/upgrader.
 *
 * An independent persistent loop, launched on home by booster (see
 * docs/devlog/02-booster.md "Manager orchestration"). It grows the RAM pool that
 * booster's HWGW batches feed on: first it fills the purchased-server fleet to the
 * game limit, then upgrades servers toward max RAM.
 *
 * Spending uses two arms (see config/constants.js): make the cheapest next RAM step
 * when it pays back within PSERVER_PAYBACK_SECONDS of current income (PAYBACK arm),
 * OR costs ≤ PSERVER_REINVEST_FRAC of current cash (REINVEST arm). The reinvest arm
 * is income-independent, so it bootstraps the fleet on a fresh save when income is
 * still ~0; the payback arm makes upgrades halt automatically where pservers get
 * expensive, without any hardcoded "stop at N GB".
 *
 * See docs/scripts/pserver.md for the full write-up.
 */

import {
    PSERVER_PREFIX,
    PSERVER_START_RAM,
    PSERVER_PAYBACK_SECONDS,
    PSERVER_REINVEST_FRAC,
    PSERVER_REINVEST_FLOOR,
    PSERVER_BOOTSTRAP_RAM_GB,
    MANAGER_LOOP_SLEEP,
    MANAGER_MAX_BUYS_PER_TICK,
} from "/config/constants.js";

export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();

    while (true) {
        const status = step(ns);
        renderStatus(ns, status);
        if (status.decision === "done") {
            // Fleet fully maxed — nothing left to buy. Exit to free our home RAM back to
            // the worker pool; booster won't relaunch us this run (in-memory suppression),
            // and rebuilds next run after an aug install wipes the fleet.
            ns.print("Fleet fully maxed — exiting.");
            return;
        }
        await ns.sleep(MANAGER_LOOP_SLEEP);
    }
}

/**
 * Drain every affordable RAM-growth step this tick (up to a per-tick cap), cheapest
 * first. Filling the fleet (buying new servers) takes priority over upgrading, since an
 * 8 GB server adds more pooled RAM per dollar than the first upgrades of an existing one
 * until the fleet is full. Buying many per tick (instead of one) lets the fleet build
 * out in seconds rather than one-purchase-per-10s. Returns a status object for the tail
 * display; decision === "done" means the fleet is fully maxed.
 */
function step(ns) {
    const limit = ns.cloud.getServerLimit();
    const maxRam = ns.cloud.getRamLimit();
    const income = ns.getTotalScriptIncome()[0]; // $/s across all scripts
    let money = ns.getServerMoneyAvailable("home");

    let owned = ns.cloud.getServerNames();
    let fleetRam = owned.reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);

    // Reinvest fraction decays from FRAC (empty fleet) to FLOOR (target reached), so
    // the income-independent bootstrap arm fades and payback governs steady state.
    // Computed once per tick — it barely moves within a single drain.
    const progress = Math.min(1, fleetRam / PSERVER_BOOTSTRAP_RAM_GB);
    const reinvestFrac =
        PSERVER_REINVEST_FLOOR + (PSERVER_REINVEST_FRAC - PSERVER_REINVEST_FLOOR) * (1 - progress);

    let bought = 0;
    let move = null;
    let decision = "done"; // overwritten unless the very first move is null (fully maxed)

    while (bought < MANAGER_MAX_BUYS_PER_TICK) {
        owned = ns.cloud.getServerNames(); // re-read: a buy changes the fleet
        move = owned.length < limit ? cheapestBuy(ns) : cheapestUpgrade(ns, owned, maxRam);
        if (!move) { decision = "done"; break; } // nothing left to buy → fleet maxed

        if (!shouldBuy(move.cost, income, money, reinvestFrac)) {
            decision = move.cost > money ? "waiting: insufficient $" : "waiting: accumulating cash";
            break;
        }
        move.execute();
        money -= move.cost; // reflect spend so the loop terminates as cash drains
        bought++;
        decision = "bought";
    }

    fleetRam = ns.cloud.getServerNames().reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
    return {
        count: ns.cloud.getServerNames().length,
        limit, fleetRam, income, money, progress, reinvestFrac,
        label: move ? move.label : "fleet fully maxed",
        cost: move ? move.cost : 0,
        bought, decision,
    };
}

/** Buy a new server at the starting RAM. */
function cheapestBuy(ns) {
    const ram = PSERVER_START_RAM;
    return {
        cost: ns.cloud.getServerCost(ram),
        label: `buy ${nextName(ns)} @ ${ram}GB`,
        execute: () => ns.cloud.purchaseServer(nextName(ns), ram),
    };
}

/**
 * Find the owned server whose next doubling is cheapest (best $/step ≈ best $/GB,
 * since every doubling adds RAM equal to the server's current size). Servers at
 * max RAM are skipped. Returns null if every server is maxed.
 */
function cheapestUpgrade(ns, owned, maxRam) {
    let best = null;
    for (const host of owned) {
        const ram = ns.getServerMaxRam(host);
        if (ram >= maxRam) continue;
        const nextRam = ram * 2;
        const cost = ns.cloud.getServerUpgradeCost(host, nextRam);
        if (!best || cost < best.cost) {
            best = {
                cost,
                label: `upgrade ${host} ${ram}→${nextRam}GB`,
                execute: () => ns.cloud.upgradeServer(host, nextRam),
            };
        }
    }
    return best;
}

/**
 * Buy test: affordable AND (pays back within the horizon OR costs ≤ REINVEST_FRAC
 * of cash). The reinvest arm is income-independent, so it bootstraps the fleet on a
 * fresh save when income is still ~0 (the payback arm can't fire yet because RAM is
 * the bottleneck — the chicken-and-egg this arm breaks).
 */
function shouldBuy(cost, income, money, reinvestFrac) {
    if (cost > money) return false;
    const paysBack = cost <= income * PSERVER_PAYBACK_SECONDS;
    const reinvest = cost <= money * reinvestFrac;
    return paysBack || reinvest;
}

/** Refresh the tail-window status table each tick. */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 48;
    ns.print(`╔═ PSERVER ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 23))}`);
    ns.print(`║ Fleet ${s.count}/${s.limit}  |  Total RAM ${ns.format.ram(s.fleetRam)}`);
    ns.print(`║ Income $${ns.format.number(s.income)}/s  |  Cash $${ns.format.number(s.money)}`);
    ns.print(`║ Bootstrap ${Math.round(s.progress * 100)}%  |  reinvest ${(s.reinvestFrac * 100).toFixed(1)}%`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Next: ${s.label}`);
    if (s.cost > 0) ns.print(`║ Cost: $${ns.format.number(s.cost)}`);
    const verdict = s.decision === "bought"
        ? `✔ BOUGHT ×${s.bought}`
        : s.decision === "done"
            ? "— done (maxed)"
            : `… ${s.decision}${s.bought ? ` (after ${s.bought})` : ""}`;
    ns.print(`║ ${verdict}`);
    ns.print(`╚${"═".repeat(W)}`);
}

/** First unused pserv-N name, so booster's hacknet gate can count the fleet. */
function nextName(ns) {
    const owned = new Set(ns.cloud.getServerNames());
    for (let i = 0; ; i++) {
        const name = `${PSERVER_PREFIX}${i}`;
        if (!owned.has(name)) return name;
    }
}
