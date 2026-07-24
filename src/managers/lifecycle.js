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
 * same SF4 gate pilot uses passes. Ticks slowly (LIFECYCLE_LOOP_SLEEP = 60s)
 * because install-worthiness changes over minutes/hours, not seconds — tick rate
 * has NO effect on RAM (RAM is charged per distinct ns function referenced; see
 * docs/reference/game-mechanics.md). What does cost RAM is each distinct
 * ns.singularity.* function this file references (×16/4/1 by SF4 level), so the
 * singularity surface here is kept minimal.
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
    LIFECYCLE_MAX_AUGS,
    LIFECYCLE_STAGNANT_MS,
    LIFECYCLE_MAX_RUN_MS,
    LIFECYCLE_SPEND_DOWN,
    LIFECYCLE_LOG_FILE,
    LIFECYCLE_DEBUG,
    LIFECYCLE_DEBUG_LOG,
    BOOT_SCRIPT,
    DONATE_SLOP,
} from "/config/constants.js";
import { PRIORITY_AUGS } from "/config/aug-priority.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { getFlag, setFlag, moneyFloor, clearReservation } from "/lib/flags.js";
// setFlag is used by releaseFreeze (clearing the pre-install money freeze).
import { debugLog } from "/lib/debug-log.js";

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

    // Defensive: a fresh lifecycle launch is never mid-checklist, so moneyFloor must not
    // be the Infinity freeze here. Clear any residual freeze (e.g. a prior process killed
    // mid-checklist, or a no-op install that stranded it) so a new run can never start
    // frozen at money=0. This is also what recovers an already-stuck save on relaunch.
    releaseFreeze(ns);

    while (true) {
        if (!singularityAvailable(ns)) {
            ns.print("Singularity API unavailable — lifecycle exiting.");
            return;
        }

        const decision = computeDecision(ns);
        const armed = LIFECYCLE_AUTO_INSTALL || getFlag(ns, "autoInstall", false);

        if (LIFECYCLE_DEBUG) logTick(ns, decision, armed);

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
 *   redPillReady (The Red Pill is rep-met) — install ASAP to claim it, OR
 *   readyCount >= LIFECYCLE_MAX_AUGS — hard cap; install now regardless of stagnation,
 *     no point accumulating more (effects only apply after installation), OR
 *   readyCount >= LIFECYCLE_MIN_AUGS AND stagnantMs >= LIFECYCLE_STAGNANT_MS
 *     (no new aug became acquirable for a while — money/rep progress plateaued), OR
 *   readyCount >= 1 AND !grindPending AND stagnantMs >= LIFECYCLE_STAGNANT_MS
 *     (PLATEAU: pilot is done grinding REAL augs — priority AND non-priority — so
 *     workSource has descended to NeuroFlux; acquirableNow hasn't grown for a
 *     stagnation window, so MIN_AUGS can never be reached; install the small batch
 *     rather than wait), OR
 *   readyCount >= 1 AND runMs >= LIFECYCLE_MAX_RUN_MS
 *     (run has gone on long enough that SOME progress beats none).
 *
 * grindPending here means "pilot is still grinding toward a real aug" — its
 * workSource is priority OR non-priority. Once it descends to neuroflux/none, both
 * aug tiers are exhausted and the plateau trigger can fire.
 */
function computeDecision(ns) {
    const now = Date.now();
    const runMs = now - ns.getResetInfo().lastAugReset;

    const pilotStatus = readStatus(ns, STATUS_PORT_PILOT);
    const readyCount = pilotStatus?.acquirableNow ?? 0;
    const lastAcquireTs = pilotStatus?.lastAcquireTs ?? null;
    // No acquisition recorded reads as "stagnant since the run started" — conservative.
    const stagnantMs = now - (lastAcquireTs ?? ns.getResetInfo().lastAugReset);
    // Pilot still grinding a real aug (priority or non-priority tier)? Once it falls
    // through to NeuroFlux ("neuroflux"/"none"/absent), both aug tiers are exhausted.
    const src = pilotStatus?.workSource ?? null;
    const grindPending = src === "priority" || src === "non-priority";
    const redPillReady = pilotStatus?.redPillReady === true;

    const redPillTrigger = redPillReady; // claim The Red Pill as soon as it's rep-met
    // Hard cap: enough augs are ready that waiting is pointless — install immediately,
    // no stagnation required (applies to a big gang-unlocked real batch or piled-up NF).
    const maxTrigger = readyCount >= LIFECYCLE_MAX_AUGS;
    const stagnantTrigger = readyCount >= LIFECYCLE_MIN_AUGS && stagnantMs >= LIFECYCLE_STAGNANT_MS;
    // Plateau: no real aug left to grind AND acquirableNow hasn't grown for a full
    // stagnation window (so money isn't unlocking more either) — installing even a
    // small batch beats holding out for MIN_AUGS/MAX_RUN that can never arrive.
    const plateauTrigger = readyCount >= 1 && !grindPending && stagnantMs >= LIFECYCLE_STAGNANT_MS;
    const runLengthTrigger = readyCount >= 1 && runMs >= LIFECYCLE_MAX_RUN_MS;

    let reason = null;
    if (redPillTrigger) reason = `The Red Pill is ready — installing to claim it`;
    else if (maxTrigger) reason = `${readyCount} augs ready (hard cap ${LIFECYCLE_MAX_AUGS}) — installing now`;
    else if (stagnantTrigger) reason = `${readyCount} augs affordable, no progress ${Math.round(stagnantMs / 60000)}m`;
    else if (plateauTrigger) reason = `${readyCount} aug(s) ready, nothing left to grind — ${Math.round(stagnantMs / 60000)}m`;
    else if (runLengthTrigger) reason = `${readyCount} aug(s) affordable, run age ${Math.round(runMs / 3600000)}h`;

    return {
        readyCount, runMs, stagnantMs, grindPending, redPillReady,
        redPillTrigger, maxTrigger, stagnantTrigger, plateauTrigger, runLengthTrigger,
        shouldInstall: redPillTrigger || maxTrigger || stagnantTrigger || plateauTrigger || runLengthTrigger,
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

    // installAugmentations() is a NO-OP when nothing is queued (no augs bought this
    // checklist) — it returns without resetting, so reaching this line means the reset
    // did NOT happen. Release the freeze that liquidateAndFreeze set, or money stays
    // frozen (moneyFloor=Infinity) for the rest of the run and every spender stalls on
    // money=0. The faction fixes above make an empty batch unlikely, but this guarantees
    // a no-op can never wedge the economy again.
    releaseFreeze(ns);
    ns.print("installAugmentations was a no-op (nothing to install) — released money freeze.");
}

/** Lift the pre-install spending freeze: reset moneyFloor to 0 and drop the augBatch
 *  reservation. Called after a no-op install and defensively at startup, so a stale
 *  Infinity floor (which only a reset would otherwise clear) can never strand the run. */
function releaseFreeze(ns) {
    setFlag(ns, "moneyFloor", 0);
    clearReservation(ns, "augBatch");
}

/**
 * Step 0.5: buy the aug set NOW, when money is about to become worthless. Priority
 * tier (aug-priority.js: Hacking/Special/faction-rep augs) first, most-expensive-
 * first — the game inflates every aug's price ~1.9x per purchase, so buying the dear
 * ones first avoids inflating them further. Only rep-unlocked, prereq-satisfied augs
 * are buyable; we re-scan after each buy since a purchase can satisfy another aug's
 * prereq.
 *
 * CASCADE (matches pilot's grind order): while ANY priority aug is still rep-LOCKED
 * at a joined faction — i.e. the priority tier isn't finished — the NON-priority tier
 * is skipped and leftover money flows to dumpNeuroflux (a NF level beats a combat aug
 * while hacking augs are still the goal). ONCE no priority aug is rep-locked anywhere,
 * the priority tier is exhausted, so the rest tier opens: priority → non-priority → NF.
 * Priority augs' prereqs are always kept buyable even if a prereq is non-priority.
 * The Red Pill is a priority aug, so it's bought here as soon as it's rep-met. Returns
 * count bought.
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

    // Is any priority aug still rep-LOCKED (unowned, and rep-met at NO joined faction,
    // so not in `buyable`)? While one is, we're still pursuing the priority tier.
    let priorityRemaining = false;
    for (const faction of ns.getPlayer().factions) {
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (PRIORITY_AUGS.has(aug) && !owned.has(aug) && !buyable.has(aug)) { priorityRemaining = true; break; }
        }
        if (priorityRemaining) break;
    }

    // Priority tier not yet finished → drop non-priority augs (but keep any that are a
    // transitive prereq of a priority aug so priority augs gated behind a non-priority
    // prereq still install). Once priority is exhausted, keep the whole set.
    if (priorityRemaining) {
        const keep = new Set();
        const addWithPrereqs = (aug) => {
            if (keep.has(aug)) return;
            keep.add(aug);
            for (const p of sing.getAugmentationPrereq(aug)) addWithPrereqs(p);
        };
        for (const aug of buyable.keys()) if (PRIORITY_AUGS.has(aug)) addWithPrereqs(aug);
        for (const aug of [...buyable.keys()]) if (!keep.has(aug)) buyable.delete(aug);
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
    // Ledger honesty: the Infinity floor above already blocks every spender, so this
    // is not load-bearing for the freeze itself — but this very checklist is about to
    // spend the reserved money (batchBuyAugs/dumpNeuroflux), so the entry should not
    // linger describing money that's already gone.
    clearReservation(ns, "augBatch");
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
 * Smallest donation (dollars) that yields >= repNeeded reputation at the current
 * player mults. Prefers the exact in-game formula (Formulas.exe) via binary
 * search — repFromDonation is not necessarily linear/invertible in closed form
 * across game versions, so search rather than assume — and falls back to the
 * verified closed form when Formulas.exe isn't owned (or the API throws, e.g. a
 * removed/renamed function): favor gates the ABILITY to donate, it does not
 * scale the rep-per-dollar conversion, so `amount = repNeeded * 1e6 /
 * faction_rep` holds regardless of favor. repNeeded <= 0 needs no donation.
 */
function donationForRep(ns, repNeeded) {
    if (repNeeded <= 0) return 0;
    if (ns.fileExists("Formulas.exe", "home")) {
        try {
            const player = ns.getPlayer();
            let lo = 0;
            let hi = repNeeded * 1e6;
            // Double hi until it clears the target, bounded so a pathological
            // multiplier can't spin forever (30 doublings + 30 bisection steps).
            for (let i = 0; i < 30 && ns.formulas.reputation.repFromDonation(hi, player) < repNeeded; i++) hi *= 2;
            for (let i = 0; i < 30; i++) {
                const mid = (lo + hi) / 2;
                if (ns.formulas.reputation.repFromDonation(mid, player) >= repNeeded) hi = mid;
                else lo = mid;
            }
            return hi;
        } catch {
            // fall through to closed form
        }
    }
    return (repNeeded * 1e6) / ns.getPlayer().mults.faction_rep;
}

/**
 * Step 1: convert money into the MAXIMUM number of NeuroFlux levels, on the
 * highest-rep JOINED faction, instead of stopping at the rep cap and handing the
 * rest to spendDown blind. Each iteration closes exactly the current level's rep
 * gap with a sized donation (donationForRep, padded by DONATE_SLOP for rounding)
 * before buying — so money that used to sit idle once rep ran out now buys
 * additional levels, up to whatever the wallet can afford. Deliberately
 * lifecycle's job, not pilot's — buying NF early just wastes the per-purchase
 * inflation on levels bought before a reset was imminent.
 */
function dumpNeuroflux(ns) {
    const sing = ns.singularity;
    const NF = "NeuroFlux Governor";
    // Only factions that actually SELL NeuroFlux. The bare highest-rep faction is often
    // the GANG faction (respect → huge rep) which does NOT offer NF, so buying from it
    // fails and nothing gets queued — which turns installAugmentations into a no-op and
    // strands the money freeze. Filtering here is what keeps the dump (and the install)
    // real; pilot's readiness count filters identically (bestNeurofluxFaction).
    const joined = ns.getPlayer().factions.filter((f) => sing.getAugmentationsFromFaction(f).includes(NF));
    if (joined.length === 0) return 0;

    // Prefer a faction whose favor already unlocks donation — NF's rep requirement runs
    // into the millions, so a donation-capable faction can buy far more levels than a
    // high-rep-but-low-favor one that's rep-capped. Mirrors pilot's bestNeurofluxFaction
    // so the run's grind/count faction and the reset buy faction agree. Highest rep within
    // the chosen tier (least donation needed).
    const donateThreshold = ns.getFavorToDonate ? ns.getFavorToDonate() : 150;
    const donatable = joined.filter((f) => sing.getFactionFavor(f) >= donateThreshold);
    const pool = donatable.length > 0 ? donatable : joined;

    let bestFaction = pool[0];
    let bestRep = sing.getFactionRep(bestFaction);
    for (const f of pool.slice(1)) {
        const rep = sing.getFactionRep(f);
        if (rep > bestRep) { bestFaction = f; bestRep = rep; }
    }

    const canDonate = sing.getFactionFavor(bestFaction) >= donateThreshold;

    let bought = 0;
    let totalDonated = 0;
    for (let i = 0; i < 1000; i++) {
        let price, repReq;
        try {
            price = sing.getAugmentationPrice(NF);
            repReq = sing.getAugmentationRepReq(NF);
        } catch {
            break;
        }
        const gap = Math.max(0, repReq - sing.getFactionRep(bestFaction));
        const money = ns.getServerMoneyAvailable("home");

        if (gap === 0) {
            if (price > money || !sing.purchaseAugmentation(bestFaction, NF)) break;
            bought++;
        } else if (canDonate) {
            const donation = donationForRep(ns, gap) * DONATE_SLOP;
            if (price + donation > money) break; // can't afford unlock + buy → stop
            sing.donateToFaction(bestFaction, donation);
            totalDonated += donation;
            if (!sing.purchaseAugmentation(bestFaction, NF)) break;
            bought++;
        } else {
            break; // rep-capped and can't donate
        }
    }
    ns.print(
        `NeuroFlux dump: bought ${bought} level(s) from ${bestFaction}` +
        (totalDonated > 0 ? ` (donated $${ns.format.number(totalDonated)}).` : `.`)
    );
    return bought;
}

/**
 * Step 2 (LIFECYCLE_SPEND_DOWN): runs after dumpNeuroflux's donate-exact-then-buy
 * loop, so by construction whatever money is left here cannot unlock and buy
 * another NF level (dumpNeuroflux would have spent it if it could). That residual
 * has no more purchases to make, but donating it isn't wasted: an install wipes
 * money AND reputation, but NOT favor (docs/reference/game-mechanics.md), so
 * every dollar donated here banks PERSISTENT favor for future runs at this
 * faction — the entire reason this step exists. Donate to the highest-favor
 * faction if its favor already clears getFavorToDonate() (donating below that
 * threshold wastes the money for very little rep — the game scales rep-per-dollar
 * with favor).
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

// ── Debug logging ─────────────────────────────────────────────────────────────

/** One rolling debug line per tick showing every install-decision input and which
 *  triggers fired — so "augs ready but never installs" is diagnosable from the log.
 *  Also logs freshness of pilot's status (a stale/absent port read makes readyCount
 *  and grindPending both read as 0/false). Gated by LIFECYCLE_DEBUG. */
function logTick(ns, decision, armed) {
    const pilot = readStatus(ns, STATUS_PORT_PILOT);
    const pilotAgeMs = pilot?.ts ? Date.now() - pilot.ts : null;
    debugLog(ns, LIFECYCLE_DEBUG_LOG, {
        armed: armed ? 1 : 0,
        install: decision.shouldInstall ? 1 : 0,
        reason: decision.reason ?? "-",
        ready: decision.readyCount,
        grindPending: decision.grindPending ? 1 : 0,
        redPill: decision.redPillReady ? 1 : 0,
        src: pilot?.workSource ?? "-",
        stagMin: Math.round(decision.stagnantMs / 60000),
        runHr: Math.round(decision.runMs / 36000) / 100,
        tRedPill: decision.redPillTrigger ? 1 : 0,
        tMax: decision.maxTrigger ? 1 : 0,
        tStag: decision.stagnantTrigger ? 1 : 0,
        tPlateau: decision.plateauTrigger ? 1 : 0,
        tRun: decision.runLengthTrigger ? 1 : 0,
        minAugs: LIFECYCLE_MIN_AUGS,
        maxAugs: LIFECYCLE_MAX_AUGS,
        stagCfgMin: Math.round(LIFECYCLE_STAGNANT_MS / 60000),
        maxRunHr: Math.round(LIFECYCLE_MAX_RUN_MS / 36000) / 100,
        pilotAgeMs: pilotAgeMs ?? "-",
        pilotGrind: pilot?.augs?.grindTarget ? `${pilot.augs.grindTarget.aug}@${pilot.augs.grindTarget.faction}` : "-",
        pilotWork: pilot?.augs?.workTarget ? `${pilot.augs.workTarget.aug}@${pilot.augs.workTarget.faction}` : "-",
        floor: moneyFloor(ns),
    });
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
