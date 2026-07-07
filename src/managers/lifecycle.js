/**
 * managers/lifecycle.js — install-decision model + pre-reset checklist + reset
 * call (docs/plans/reset-lifecycle.md Part B; see docs/scripts/lifecycle.md for
 * the full write-up).
 *
 * Closes the outermost automation loop: decides WHEN installing pending
 * augmentations is worth resetting for, executes the pre-reset checklist in
 * order (liquidate/freeze → NF dump → optional favor spend-down → record run
 * duration → log → installAugmentations), and — separately, Part C — raises a
 * persistent alert (never auto-acts) when the BitNode is completable.
 *
 * Manager-pattern script, launched by booster/orbiter (launchManagers) once the
 * same SF4 gate pilot uses passes. Ticks slowly (LIFECYCLE_LOOP_SLEEP = 60s) —
 * install-worthiness changes over minutes/hours, not seconds, and every
 * ns.singularity.* call here carries the same ×16/4/1 SF4 RAM multiplier pilot's
 * plan documents, so infrequent calls matter for RAM just as much as for pilot.
 *
 * AUTONOMY GUARD: LIFECYCLE_AUTO_INSTALL defaults false. When neither that
 * constant NOR the runtime `autoInstall` flag (armed via
 * utils/auto-install-on.js) is true, lifecycle computes the decision and
 * publishes `recommendInstall` + a reason but takes NO destructive action.
 * installAugmentations is only ever called from runChecklist(), which is only
 * ever called when the decision fires AND autonomy is armed — never ships
 * armed by default.
 */

import {
    STATUS_PORT_LIFECYCLE,
    STATUS_PORT_PILOT,
    STATUS_PORT_STOCKS,
    LIFECYCLE_LOOP_SLEEP,
    LIFECYCLE_AUTO_INSTALL,
    LIFECYCLE_MIN_AUGS,
    LIFECYCLE_STAGNANT_MS,
    LIFECYCLE_MAX_RUN_MS,
    LIFECYCLE_SPEND_DOWN,
    LIFECYCLE_LOG_FILE,
    BOOT_SCRIPT,
} from "/config/constants.js";
import { PRIORITY_AUGS } from "/config/aug-priority.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { getFlag, setFlag } from "/lib/flags.js";

/** How long runChecklist waits for the stocks manager to ack liquidation before
 *  proceeding anyway (arbitration.md Decision 2.3). No-op today — no stocks
 *  manager exists yet — but the wait/timeout code must be present per the plan's
 *  checklist step 0. */
const LIQUIDATE_ACK_TIMEOUT_MS = 30_000;
/** moneyFloor set during the checklist — effectively "no manager may spend
 *  anything" (every manager's buy path checks `money - cost < moneyFloor`). Using
 *  Infinity (rather than current money) means the floor stays correct even as
 *  NF purchases and donations spend money down during the checklist itself. */
const FREEZE_MONEY_FLOOR = Infinity;

export async function main(ns) {
    ns.disableLog("ALL");

    while (true) {
        if (!singularityAvailable(ns)) {
            ns.print("Singularity API unavailable — lifecycle exiting.");
            return;
        }

        const decision = computeDecision(ns);
        const armed = LIFECYCLE_AUTO_INSTALL || getFlag(ns, "autoInstall", false);

        if (decision.shouldInstall && armed) {
            await runChecklist(ns, decision);
            // installAugmentations wipes all running scripts (including this one);
            // control never returns here after a successful install.
        }

        const bnStatus = checkBnCompletable(ns);

        const status = buildStatus(ns, decision, armed, bnStatus);
        renderStatus(ns, status);
        publishStatus(ns, STATUS_PORT_LIFECYCLE, status);

        await ns.sleep(LIFECYCLE_LOOP_SLEEP);
    }
}

function singularityAvailable(ns) {
    try {
        ns.singularity.isBusy();
        return true;
    } catch {
        return false;
    }
}

// ── Install-decision model ──────────────────────────────────────────────────

/**
 * readyCount = PRIORITY augs the reset batch could AFFORD right now (pilot's
 * `acquirableNow`: rep met AND money saved, simulating the batch price ramp). Using
 * affordability — not just rep — is what stops a gang's rep windfall from firing the
 * install while the money to buy those augs hasn't been saved yet. runMs = time since
 * last aug reset. stagnantMs = time since readyCount last grew (pilot's
 * `lastAcquireTs`), which grows from EITHER grinding rep OR saving money, so it
 * plateaus only when progress on the binding constraint (whichever is greater) stalls.
 *
 * Install when:
 *   readyCount >= LIFECYCLE_MIN_AUGS AND stagnantMs >= LIFECYCLE_STAGNANT_MS
 *     (no new aug became acquirable for a while — money/rep progress plateaued), OR
 *   readyCount >= 1 AND runMs >= LIFECYCLE_MAX_RUN_MS
 *     (run has gone on long enough that SOME progress beats none).
 */
function computeDecision(ns) {
    const now = Date.now();
    const runMs = now - ns.getResetInfo().lastAugReset;

    const pilotStatus = readStatus(ns, STATUS_PORT_PILOT);
    const readyCount = pilotStatus?.acquirableNow ?? 0;
    const lastAcquireTs = pilotStatus?.lastAcquireTs ?? null;
    // No acquisition recorded reads as "stagnant since the run started" — conservative.
    const stagnantMs = now - (lastAcquireTs ?? ns.getResetInfo().lastAugReset);

    const stagnantTrigger = readyCount >= LIFECYCLE_MIN_AUGS && stagnantMs >= LIFECYCLE_STAGNANT_MS;
    const runLengthTrigger = readyCount >= 1 && runMs >= LIFECYCLE_MAX_RUN_MS;

    let reason = null;
    if (stagnantTrigger) reason = `${readyCount} augs affordable, no progress ${Math.round(stagnantMs / 60000)}m`;
    else if (runLengthTrigger) reason = `${readyCount} aug(s) affordable, run age ${Math.round(runMs / 3600000)}h`;

    return {
        readyCount, runMs, stagnantMs,
        shouldInstall: stagnantTrigger || runLengthTrigger,
        reason,
    };
}

// ── Pre-reset checklist ─────────────────────────────────────────────────────

/**
 * Runs the checklist in the plan's exact order. Steps 0-4 are all reversible /
 * non-destructive; only step 5 (installAugmentations) is destructive, and it is
 * the last thing this function does — every earlier step completes first.
 */
async function runChecklist(ns, decision) {
    ns.print(`Install decision fired: ${decision.reason}. Running pre-reset checklist...`);

    await liquidateAndFreeze(ns);           // 0
    const augsBought = batchBuyAugs(ns);    // 0.5 — the actual aug purchase, at reset
    const nfBought = dumpNeuroflux(ns);     // 1
    const donated = spendDown(ns);          // 2
    const runDurationMs = recordRunDuration(ns); // 3
    logRun(ns, { runDurationMs, augsBought, nfBought, donated }); // 4

    ns.print("Checklist complete — installing augmentations now.");
    ns.singularity.installAugmentations(BOOT_SCRIPT);
}

/**
 * Step 0.5: buy the whole aug set NOW, when money is about to become worthless.
 * Priority tier (aug-priority.js: Hacking/Special/faction-rep augs) first, then the
 * rest — each tier most-expensive-first, because the game inflates every aug's price
 * ~1.9x per purchase, so buying the dear ones first avoids inflating them further.
 * Only rep-unlocked, prereq-satisfied augs are buyable; we re-scan after each buy
 * since a purchase can satisfy another aug's prereq. Returns count bought.
 */
function batchBuyAugs(ns) {
    const sing = ns.singularity;
    const owned = new Set(sing.getOwnedAugmentations(true));

    // Gather buyable augs (rep met, not owned) with the faction offering them.
    const buyable = new Map(); // aug -> faction
    for (const faction of ns.getPlayer().factions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (aug === "NeuroFlux Governor" || owned.has(aug) || buyable.has(aug)) continue;
            if (rep >= sing.getAugmentationRepReq(aug)) buyable.set(aug, faction);
        }
    }

    let bought = 0;
    let progress = true;
    while (progress) {
        progress = false;
        // Rebuild candidate list each pass: priority tier first, then rest; within
        // each, most-expensive-first by LIVE price (reflects the ramp so far).
        const candidates = [...buyable.keys()]
            .filter((aug) => !owned.has(aug))
            .filter((aug) => sing.getAugmentationPrereq(aug).every((p) => owned.has(p)))
            .map((aug) => ({ aug, price: sing.getAugmentationPrice(aug), priority: PRIORITY_AUGS.has(aug) }))
            .sort((a, b) => (a.priority !== b.priority ? (b.priority - a.priority) : b.price - a.price));

        for (const c of candidates) {
            if (c.price > ns.getServerMoneyAvailable("home")) continue;
            if (sing.purchaseAugmentation(buyable.get(c.aug), c.aug)) {
                owned.add(c.aug);
                bought++;
                progress = true; // prices shifted + a prereq may now be satisfied → re-scan
                break;
            }
        }
    }
    ns.print(`Batch aug buy: purchased ${bought} augmentation(s).`);
    return bought;
}

/**
 * Step 0: freeze all manager spending (moneyFloor) and ask the stocks manager to
 * liquidate everything (flag `liquidate: true`), then wait up to
 * LIQUIDATE_ACK_TIMEOUT_MS for its `liquidated: true` ack before proceeding
 * anyway. No stocks manager exists yet, so this is a no-op in practice today
 * (the wait always times out) — but the flag-setting and ack-wait shape must be
 * in place now per the plan, since every manager's buy path already checks
 * moneyFloor (arbitration.md Decision 2) and the stocks plan already documents
 * the ack contract.
 */
async function liquidateAndFreeze(ns) {
    setFlag(ns, "moneyFloor", FREEZE_MONEY_FLOOR);
    setFlag(ns, "liquidate", true);

    const start = Date.now();
    while (Date.now() - start < LIQUIDATE_ACK_TIMEOUT_MS) {
        const stocksStatus = readStatus(ns, STATUS_PORT_STOCKS);
        if (stocksStatus?.liquidated === true) {
            ns.print("Stocks liquidation acknowledged.");
            return;
        }
        await ns.sleep(1000);
    }
    ns.print("Liquidation ack timed out (or no stocks manager running) — proceeding anyway.");
}

/**
 * Step 1: loop purchaseAugmentation(faction, 'NeuroFlux Governor') on the
 * highest-rep JOINED faction until it returns false (rep or money exhausted).
 * Deliberately lifecycle's job, not pilot's — buying NF early just wastes the
 * per-purchase inflation on levels bought before a reset was imminent.
 */
function dumpNeuroflux(ns) {
    const sing = ns.singularity;
    const NF = "NeuroFlux Governor";
    const joined = ns.getPlayer().factions;
    if (joined.length === 0) return 0;

    let bestFaction = joined[0];
    let bestRep = sing.getFactionRep(bestFaction);
    for (const f of joined.slice(1)) {
        const rep = sing.getFactionRep(f);
        if (rep > bestRep) { bestFaction = f; bestRep = rep; }
    }

    let bought = 0;
    while (sing.purchaseAugmentation(bestFaction, NF)) bought++;
    ns.print(`NeuroFlux dump: bought ${bought} level(s) from ${bestFaction}.`);
    return bought;
}

/**
 * Step 2 (LIFECYCLE_SPEND_DOWN): money is meaningless post-reset, so donate
 * whatever's left to the highest-favor faction if its favor already clears
 * getFavorToDonate() (donating below that threshold wastes the money for very
 * little rep — the game scales rep-per-dollar with favor).
 */
function spendDown(ns) {
    if (!LIFECYCLE_SPEND_DOWN) return 0;
    const sing = ns.singularity;
    const joined = ns.getPlayer().factions;
    if (joined.length === 0) return 0;

    let bestFaction = null;
    let bestFavor = -Infinity;
    for (const f of joined) {
        const favor = sing.getFactionFavor(f);
        if (favor > bestFavor) { bestFavor = favor; bestFaction = f; }
    }

    const donateThreshold = ns.getFavorToDonate ? ns.getFavorToDonate() : 150;
    if (bestFaction === null || bestFavor < donateThreshold) return 0;

    const amount = ns.getServerMoneyAvailable("home");
    if (amount <= 0) return 0;
    const ok = sing.donateToFaction(bestFaction, amount);
    ns.print(`Spend-down: donated $${ns.format.number(amount)} to ${bestFaction} — ${ok ? "ok" : "failed"}.`);
    return ok ? amount : 0;
}

/**
 * Step 3: compute this run's duration for the lifecycle log. DELIBERATELY does
 * NOT write BN_DURATIONS_JSON: hacknet's computeHorizon() already appends the
 * finished run's duration itself on its next launch (its stored augReset differs
 * from the post-install lastAugReset, and the diff between the two IS this
 * duration). If lifecycle pushed it here too, the same run would be counted
 * twice and skew hacknet's ROI horizon. Single writer: hacknet owns that file.
 */
function recordRunDuration(ns) {
    return Date.now() - ns.getResetInfo().lastAugReset;
}

/** Step 4: human-readable persistent log line (survives resets — plain file, not
 *  a port). */
function logRun(ns, info) {
    const augCount = ns.singularity.getOwnedAugmentations(true).length;
    const money = ns.getServerMoneyAvailable("home");
    const line =
        `${new Date().toISOString()} | runDurationMs=${info.runDurationMs} | ` +
        `augsOwned=${augCount} | augsBought=${info.augsBought} | nfBought=${info.nfBought} | donated=${info.donated} | ` +
        `moneyAtReset=${Math.round(money)}\n`;
    ns.write(LIFECYCLE_LOG_FILE, line, "a");
}

// ── Part C: BitNode completion (always player-consented) ───────────────────

/**
 * True if w0r1d_d43m0n is backdoorable right now (rooted + hack level meets its
 * requirement). Purely observational — lifecycle NEVER calls destroyW0r1dD43m0n
 * itself; it only raises a persistent dashboard alert pointing at the
 * player-run utils/finish-bn.js. LIFECYCLE_AUTO_DESTROY deliberately does not
 * exist anywhere in this codebase.
 */
function checkBnCompletable(ns) {
    const host = "w0r1d_d43m0n";
    let info;
    try {
        info = ns.getServer(host);
    } catch {
        return { completable: false };
    }
    if (!info || !info.hasAdminRights) return { completable: false };
    const hackLvl = ns.getHackingLevel();
    const req = info.requiredHackingSkill ?? Infinity;
    const completable = !info.backdoorInstalled && hackLvl >= req;
    return { completable, hackLvl, req };
}

// ── Status ───────────────────────────────────────────────────────────────────

function buildStatus(ns, decision, armed, bnStatus) {
    return {
        ts: Date.now(),
        readyCount: decision.readyCount,
        runHrs: decision.runMs / 3600000,
        stagnantMin: decision.stagnantMs / 60000,
        recommendInstall: decision.shouldInstall,
        reason: decision.reason,
        autoInstallArmed: armed,
        bnCompletable: bnStatus.completable,
        action: decision.shouldInstall
            ? (armed ? "installing (armed)" : `recommend install — ${decision.reason}`)
            : "monitoring",
    };
}

/** Refresh the tail-window status table each tick (mirrors pilot.js's style). */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 52;
    ns.print(`╔═ LIFECYCLE ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 25))}`);
    ns.print(`║ Augs ready ${s.readyCount}  |  Run age ${s.runHrs.toFixed(1)}h  |  No-unlock ${s.stagnantMin.toFixed(0)}m`);
    ns.print(`║ Auto-install: ${s.autoInstallArmed ? "ARMED" : "off (recommend-only)"}`);
    ns.print(`╠${"═".repeat(W)}`);
    if (s.recommendInstall) {
        ns.print(`║ ⚠ RECOMMEND INSTALL — ${s.reason}`);
    } else {
        ns.print(`║ ${s.action}`);
    }
    if (s.bnCompletable) {
        ns.print(`║ ⚠ BitNode completable — run utils/finish-bn.js <nextBN>`);
    }
    ns.print(`╚${"═".repeat(W)}`);
}
