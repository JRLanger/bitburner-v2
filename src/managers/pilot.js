/**
 * managers/pilot.js — Singularity progression manager (Roadmap 3.1).
 *
 * Automates the manual progression loop the player otherwise does by hand: buy
 * TOR + darkweb programs, install backdoors on the story servers, accept "safe"
 * faction invites, buy augmentations, and drive faction work (via the arbitration
 * ladder — see docs/plans/arbitration.md) when nothing more important needs the
 * player's attention. See docs/plans/pilot-singularity.md for the full spec and
 * docs/scripts/pilot.md for the write-up (what/how/why/alternatives).
 *
 * Independent slow-tick loop, launched on home by booster/orbiter (see MANAGERS
 * in each controller) once the SF4 gate passes. Every ns.singularity.* call is
 * RAM-multiplied ×16/×4/×1 by SF4 level, so this script deliberately: (a) never
 * gets imported into booster/orbiter, (b) ticks slowly (PILOT_LOOP_SLEEP), and
 * (c) calls as few distinct singularity functions per tick as the phases need.
 *
 * Arbitration: pilot is the ONLY script that ever starts/stops player work
 * (Decision 1, arbitration.md) — no other manager calls workForFaction/commitCrime/
 * etc. This version builds the ladder SKELETON: rows 1 (bootstrap crime), 6
 * (faction work), 8 (crime fallback), 9 (idle). Rows 2-5, 7 activate once their
 * owning mechanic managers exist and start publishing focusRequest.
 */

import {
    STATUS_PORT_PILOT,
    PILOT_LOOP_SLEEP,
    PILOT_SPEND_FRAC,
    PILOT_JOIN_BLOCKLIST,
    BACKDOOR_TARGETS,
    PILOT_AUG_PRICE_HORIZON,
    PILOT_NEUROFLUX,
    SERVERS_JSON,
    FOCUS_STABLE_TICKS,
    STATUS_PORT_PSERVER,
} from "/config/constants.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { getFlag, setFlag, moneyFloor } from "/lib/flags.js";
import { findPath } from "/lib/netpath.js";

/** Crime selection for ladder rows 1 (bootstrap) and 8 (money fallback) is
 *  CHANCE-AWARE: pick the best expected-$/sec crime (money × chance ÷ time) from
 *  live getCrimeStats/getCrimeChance, and when even the best option's success
 *  chance is below PILOT_CRIME_MIN_CHANCE, train the lowest combat stat at the
 *  gym instead (re-evaluated every tick, so training hands back to crime as soon
 *  as the chance clears the bar). All pilot-internal detail, so local consts.
 *  Crime names verified against the CrimeType enum in the type defs. */
const CRIME_CANDIDATES = [
    "Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
    "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination",
    "Heist",
];
const PILOT_CRIME_MIN_CHANCE = 0.4;
/** Any city gym works; Sector-12's is the default starting-city option (same
 *  choice as utils/boot-grind.js). gymWorkout returns false if unreachable —
 *  handled by falling back to committing the best crime anyway. */
const GYM_LOCATION = "Powerhouse Gym";
/** GymType enum values keyed by the Player.skills field they train. */
const COMBAT_SKILLS = [
    ["strength", "str"], ["defense", "def"], ["dexterity", "dex"], ["agility", "agi"],
];
/** Below this much home RAM, nothing else in the pipeline works yet — see
 *  arbitration.md ladder row 1. */
const BOOTSTRAP_HOME_RAM_GB = 32;

export async function main(ns) {
    ns.disableLog("ALL");

    // Runtime-only ladder state (per-process, not persisted): the currently
    // assigned row and how many consecutive ticks a *different* row has beaten it
    // (anti-thrash — FOCUS_STABLE_TICKS). Lives here, not in lib/flags.js, because
    // it only needs to survive within this process's own lifetime.
    let currentRow = null;
    let challenger = null;
    let challengerStreak = 0;
    // Timestamp of the last successful aug purchase (this process's lifetime only
    // — a fresh pilot process post-reset starts null, which is fine: lifecycle's
    // stagnantMs check reads "now - lastAugPurchaseTs" and null means "never
    // purchased yet this run", the same as a very stale timestamp for that
    // purpose). Read by lifecycle.js off pilot's status snapshot (arbitration.md).
    let lastAugPurchaseTs = null;

    while (true) {
        if (!singularityAvailable(ns)) {
            // Gate raced wrong (shouldn't happen — booster/orbiter already checked
            // SF4/BN4 before launch), but bail cleanly rather than spam errors.
            ns.print("Singularity API unavailable — pilot exiting.");
            return;
        }

        const snapshot = gatherState(ns);

        phaseTor(ns, snapshot);
        await phaseBackdoors(ns, snapshot);
        phaseFactions(ns, snapshot);
        phaseAugs(ns, snapshot);
        if (snapshot.augsPurchasedThisTick > 0) lastAugPurchaseTs = Date.now();
        const workState = phaseWork(ns, snapshot, {
            get: () => ({ currentRow, challenger, challengerStreak }),
            set: (next) => { currentRow = next.currentRow; challenger = next.challenger; challengerStreak = next.challengerStreak; },
        });

        const status = buildStatus(ns, snapshot, workState, lastAugPurchaseTs);
        renderStatus(ns, status);
        publishStatus(ns, STATUS_PORT_PILOT, status);

        await ns.sleep(PILOT_LOOP_SLEEP);
    }
}

/** True if ns.singularity exists and at least one cheap call succeeds. Cheap sanity
 *  check for the "gate raced wrong" self-exit case described in the plan. */
function singularityAvailable(ns) {
    try {
        ns.singularity.isBusy();
        return true;
    } catch {
        return false;
    }
}

// ── State snapshot ───────────────────────────────────────────────────────────

/** One place that calls the expensive singularity getters, so every phase this
 *  tick works off a single consistent read instead of re-querying (and re-paying
 *  RAM/CPU for) the same data repeatedly. */
function gatherState(ns) {
    const sing = ns.singularity;
    return {
        // moneyFloor (lib/flags.js): reserve lifecycle asks all managers to leave
        // untouched — Infinity during the pre-reset checklist freezes spending
        // entirely. Subtracted at the snapshot so every phase's spend cap sees it.
        money: Math.max(0, ns.getServerMoneyAvailable("home") - moneyFloor(ns)),
        homeRam: ns.getServerMaxRam("home"),
        ownedPrograms: new Set(ns.ls("home", ".exe")),
        hasTor: ns.hasTorRouter(),
        joinedFactions: getJoinedFactions(ns),
        currentWork: sing.getCurrentWork(),
        isBusy: sing.isBusy(),
        servers: readServers(ns),
    };
}

/** Player.factions is the authoritative joined-faction list — includes factions
 *  joined manually or before pilot ever ran, which a pilot-tracked flag would miss. */
function getJoinedFactions(ns) {
    return ns.getPlayer().factions;
}

function readServers(ns) {
    try {
        return JSON.parse(ns.read(SERVERS_JSON));
    } catch {
        return [];
    }
}

// ── Phase 1: programs ────────────────────────────────────────────────────────

/** Buy TOR (if affordable under the spend cap) then darkweb programs in ascending
 *  cost order, cheapest-first, so a modest budget still lands the port-openers
 *  before the big-ticket items (Formulas.exe). */
function phaseTor(ns, snap) {
    const sing = ns.singularity;
    let money = snap.money;
    const spendCap = () => money * PILOT_SPEND_FRAC;

    if (!snap.hasTor) {
        const torCost = 200_000;
        if (torCost <= spendCap()) {
            if (sing.purchaseTor()) money -= torCost;
        }
        return; // no darkweb programs to shop for until TOR is owned
    }

    const owned = snap.ownedPrograms;
    const catalog = sing.getDarkwebPrograms()
        .filter((name) => !owned.has(name))
        .map((name) => ({ name, cost: sing.getDarkwebProgramCost(name) }))
        .sort((a, b) => a.cost - b.cost);

    for (const p of catalog) {
        if (p.cost > spendCap() || p.cost > money) continue;
        if (sing.purchaseProgram(p.name)) money -= p.cost;
    }
}

// ── Phase 2: backdoors ───────────────────────────────────────────────────────

/** One backdoor per tick max (per the plan) — keeps ticks short and each install
 *  individually observable. Walks the path via lib/netpath.js (reads the `parent`
 *  field booster/orbiter now stamp into servers.json), connects hop-by-hop,
 *  installs, then always returns home.
 *  Backdoor state is checked here via ns.getServer rather than stamped into
 *  servers.json — booster shouldn't pay getServer's RAM just to feed pilot, and
 *  pilot (home-only, already singularity-priced) checks at most 5 hosts. */
async function phaseBackdoors(ns, snap) {
    const sing = ns.singularity;
    const byHost = new Map(snap.servers.map((s) => [s.hostname, s]));
    const hackLvl = ns.getHackingLevel();

    for (const host of BACKDOOR_TARGETS) {
        const info = byHost.get(host);
        if (!info || !info.hasRoot) continue;
        if (hackLvl < info.hackLevelReq) continue;
        if (ns.getServer(host).backdoorInstalled) continue;

        const path = findPath(snap.servers, host);
        if (!path) continue; // not reachable in the topology snapshot yet

        try {
            for (const hop of path.slice(1)) {
                if (!sing.connect(hop)) return; // connect failed — bail, retry next tick
            }
            await sing.installBackdoor();
        } finally {
            sing.connect("home");
        }
        return; // one per tick
    }
}

// ── Phase 3: faction invites ─────────────────────────────────────────────────

/** Auto-join every invite whose faction has NO enemies (city factions and similar
 *  mutually-exclusive factions always have enemies, so they're never auto-joined)
 *  and isn't on the manual blocklist. Everything else surfaces as a pendingInvite
 *  for the player to decide. */
function phaseFactions(ns, snap) {
    const sing = ns.singularity;
    const invites = sing.checkFactionInvitations();
    const joined = new Set(snap.joinedFactions);
    const pending = [];

    for (const faction of invites) {
        if (PILOT_JOIN_BLOCKLIST.includes(faction)) { pending.push(faction); continue; }
        const enemies = sing.getFactionEnemies(faction);
        if (enemies.length > 0) { pending.push(faction); continue; }
        if (sing.joinFaction(faction)) {
            joined.add(faction);
        }
    }

    snap.pendingInvites = pending;
    snap.joinedFactions = [...joined];
}

// ── Phase 4: augmentations ───────────────────────────────────────────────────

/** Build the want-list once per tick (rep-unlocked, prereq-satisfied, not yet
 *  owned/purchased augs across every joined faction), buy price-descending (the
 *  game inflates every aug's price ~1.9x per purchase, so buying the expensive
 *  ones first avoids inflating them further before they're affordable). */
function phaseAugs(ns, snap) {
    const sing = ns.singularity;
    let money = snap.money;
    const spendCap = () => money * PILOT_SPEND_FRAC;

    const ownedOrPurchased = new Set(sing.getOwnedAugmentations(true));
    const wanted = new Map(); // augName -> { faction, price, repReq }

    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (ownedOrPurchased.has(aug)) continue;
            if (wanted.has(aug)) continue; // first faction offering it wins
            const repReq = sing.getAugmentationRepReq(aug);
            if (rep < repReq) continue;
            wanted.set(aug, { faction, repReq });
        }
    }

    let list = [...wanted.entries()].map(([aug, info]) => ({
        aug,
        faction: info.faction,
        repReq: info.repReq,
        price: sing.getAugmentationPrice(aug),
        prereq: sing.getAugmentationPrereq(aug),
    }));
    list.sort((a, b) => b.price - a.price); // expensive first

    let purchased = 0;
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of list) {
            if (ownedOrPurchased.has(item.aug)) continue;
            const prereqMet = item.prereq.every((p) => ownedOrPurchased.has(p));
            if (!prereqMet) continue;
            const price = sing.getAugmentationPrice(item.aug);
            if (price > money * PILOT_AUG_PRICE_HORIZON) continue;
            if (price > spendCap() || price > money) continue;
            if (sing.purchaseAugmentation(item.faction, item.aug)) {
                money -= price;
                ownedOrPurchased.add(item.aug);
                purchased++;
                changed = true; // prices shifted; re-scan for now-affordable/unblocked items
            }
        }
    }

    snap.augsPurchasedThisTick = purchased;
    snap.augWantList = list;
    // NeuroFlux affordable-level count: informational only (lifecycle owns the
    // actual dump, since buying early wastes the per-purchase inflation).
    snap.nfAffordableLevels = countAffordableNeuroflux(sing, money);
}

function countAffordableNeuroflux(sing, money) {
    let n = 0;
    let cash = money;
    for (let i = 0; i < 1000; i++) {
        let price;
        try {
            price = sing.getAugmentationPrice(PILOT_NEUROFLUX);
        } catch {
            break;
        }
        if (price > cash) break;
        cash -= price;
        n++;
        // NF has no fixed inflation constant exposed here; stop after a
        // reasonable cap rather than looping on a possibly-static price.
        if (n > 200) break;
    }
    return n;
}

// ── Phase 5: player-activity ladder (arbitration.md) ────────────────────────

/**
 * choosePlayerActivity() — priority ladder (arbitration.md). This build implements
 * the SKELETON rows only: 1 (bootstrap crime), 6 (faction work), 8 (crime
 * fallback), 9 (idle). Rows 2-5 and 7 depend on mechanic managers that don't exist
 * yet; they're written as always-inapplicable placeholders so the ladder's shape
 * (an ordered {name, applicable, start, stop} array) is already correct and future
 * plans only need to insert rows, never restructure this function.
 */
function ladder(ns, snap) {
    return [
        {
            name: "bootstrap-crime",
            applicable: () => snap.homeRam < BOOTSTRAP_HOME_RAM_GB,
            start: (ns) => startCrimeOrTrain(ns),
            maintain: (ns, reassert) => maintainCrime(ns, reassert),
            stop: (ns) => ns.singularity.stopAction(),
        },
        // Row 2 (karma grind / gang assist) — needs the gang manager's focusRequest.
        { name: "karma-grind", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 3 (Bladeburner, BN6/7) — needs the bladeburner manager.
        { name: "bladeburner-bn67", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 4 (company work for a needed invite) — needs invite-requirement scan.
        { name: "company-work", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 5 (grafting) — needs the grafting manager's focusRequest.
        { name: "grafting", applicable: () => false, start: () => {}, stop: () => {} },
        {
            name: "faction-work",
            applicable: () => bestFactionTarget(ns, snap) !== null,
            start: (ns) => startFactionWork(ns, snap),
            stop: (ns) => ns.singularity.stopAction(),
        },
        // Row 7 (Bladeburner, non-BN6/7 passive) — needs the bladeburner manager.
        { name: "bladeburner-passive", applicable: () => false, start: () => {}, stop: () => {} },
        {
            // Money fallback (arbitration row 8): only while money is still wanted —
            // proxied by "pserver manager hasn't reported the fleet fully maxed yet".
            // Once the fleet is done, spare player time is worth more idle than
            // heisting, and the ladder falls through to row 9.
            name: "crime-fallback",
            applicable: () => moneyStillWanted(ns),
            start: (ns) => startCrimeOrTrain(ns),
            maintain: (ns, reassert) => maintainCrime(ns, reassert),
            stop: (ns) => ns.singularity.stopAction(),
        },
        {
            name: "idle",
            applicable: () => true,
            start: () => {},
            stop: () => {},
        },
    ];
}

/** Pick among joined factions the one with the cheapest still-locked-by-rep aug
 *  (smallest positive repReq - currentRep), tie-broken by whichever has the most
 *  locked augs. Returns null if nothing is rep-gated (nothing left to grind for). */
function bestFactionTarget(ns, snap) {
    const sing = ns.singularity;
    let best = null;
    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        const augs = sing.getAugmentationsFromFaction(faction);
        let lockedCount = 0;
        let smallestGap = Infinity;
        for (const aug of augs) {
            const repReq = sing.getAugmentationRepReq(aug);
            const gap = repReq - rep;
            if (gap > 0) {
                lockedCount++;
                if (gap < smallestGap) smallestGap = gap;
            }
        }
        if (lockedCount === 0) continue;
        if (
            !best ||
            smallestGap < best.gap ||
            (smallestGap === best.gap && lockedCount > best.lockedCount)
        ) {
            best = { faction, gap: smallestGap, lockedCount };
        }
    }
    return best;
}

/** Best expected-$/sec crime right now: money × successChance ÷ time over the
 *  full CrimeType catalog. Chance is a live read, so this self-adjusts as combat
 *  stats grow — a fresh character picks Shoplift/Mug, a trained one graduates to
 *  Heist on its own. */
function bestCrime(ns) {
    const sing = ns.singularity;
    let best = null;
    for (const crime of CRIME_CANDIDATES) {
        const stats = sing.getCrimeStats(crime);
        const chance = sing.getCrimeChance(crime);
        const ev = (stats.money * chance) / stats.time;
        if (!best || ev > best.ev) best = { crime, chance, ev };
    }
    return best;
}

/** Crime rows' start(): commit the best-EV crime, unless even ITS success chance
 *  is below PILOT_CRIME_MIN_CHANCE — then train the lowest combat stat at the gym
 *  first (chance-gated per the user's request; re-checked every tick by
 *  maintainCrime, which hands back to crime once the bar clears). gymWorkout can
 *  fail (not in a city with this gym / no money) — fall back to just committing
 *  the crime rather than doing nothing. */
function startCrimeOrTrain(ns) {
    const sing = ns.singularity;
    const best = bestCrime(ns);
    if (best.chance < PILOT_CRIME_MIN_CHANCE) {
        const skills = ns.getPlayer().skills;
        let lowest = COMBAT_SKILLS[0];
        for (const entry of COMBAT_SKILLS) {
            if (skills[entry[0]] < skills[lowest[0]]) lowest = entry;
        }
        if (sing.gymWorkout(GYM_LOCATION, lowest[1], false)) return;
    }
    sing.commitCrime(best.crime, false);
}

/** Crime rows' maintain() — called each tick the row stays assigned:
 *  - player idle (a crime finished): start the next best crime / training block;
 *  - player gym-training (type "CLASS") and the best crime's chance now clears
 *    the bar: stop training and switch to the crime. Without this, the gym —
 *    which never ends on its own — would hold the row forever. */
function maintainCrime(ns, reassert) {
    const sing = ns.singularity;
    if (!sing.isBusy()) {
        reassert();
        return;
    }
    const work = sing.getCurrentWork();
    if (work?.type === "CLASS" && bestCrime(ns).chance >= PILOT_CRIME_MIN_CHANCE) {
        sing.stopAction();
        reassert();
    }
}

function startFactionWork(ns, snap) {
    const sing = ns.singularity;
    const target = bestFactionTarget(ns, snap);
    if (!target) return false;
    const favor = sing.getFactionFavor(target.faction);
    const donateThreshold = ns.getFavorToDonate ? ns.getFavorToDonate() : 150;
    if (favor >= donateThreshold) {
        // Grind rep with money instead of time once favor is high enough to donate
        // efficiently, still under the spend cap.
        const amount = Math.min(snap.money * PILOT_SPEND_FRAC, snap.money);
        if (amount > 0) sing.donateToFaction(target.faction, amount);
        return true;
    }
    const types = sing.getFactionWorkTypes(target.faction);
    const workType = types.includes("hacking") ? "hacking" : types[0];
    if (!workType) return false;
    return sing.workForFaction(target.faction, workType, false); // never steal focus
}

/**
 * Runs the ladder each tick: find the first applicable row, apply
 * FOCUS_STABLE_TICKS hysteresis before actually switching away from the
 * currently-assigned row, then start/stop work accordingly. Never touches work
 * the PLAYER started manually — only replaces work pilot itself began (tracked
 * via the `pilotWorkSig` runtime flag), per the plan's manual-override rule.
 * Pilot also publishes the assigned row as the `focusOwner` flag so future
 * mechanic managers can see who owns the player (arbitration.md focus protocol).
 */
function phaseWork(ns, snap, ladderState) {
    const rows = ladder(ns, snap);
    const winner = rows.find((r) => r.applicable(snap)) ?? rows[rows.length - 1];

    const { currentRow, challenger, challengerStreak } = ladderState.get();

    // Manual-override: if the player is busy with work pilot did NOT start, leave
    // it alone entirely (don't even update the ladder bookkeeping) — see
    // lastWorkStartedByPilot in lib/flags.js per the plan.
    if (snap.isBusy && !isPilotsOwnWork(ns, snap)) {
        return { focusOwner: null, working: describeWork(snap.currentWork), overridden: true };
    }

    let nextCurrent = currentRow;
    let nextChallenger = challenger;
    let nextStreak = challengerStreak;

    if (currentRow === null) {
        nextCurrent = winner.name;
        nextChallenger = null;
        nextStreak = 0;
        applyRow(ns, winner);
    } else if (winner.name === currentRow) {
        nextChallenger = null;
        nextStreak = 0;
        // Keep the row alive between switches. Rows with a maintain() own their
        // own upkeep (crime rows: restart finished crimes, hand gym training back
        // to crime once the success chance clears the bar). For the rest, the
        // generic rule: finite work (a crime, a donate) leaves the player idle
        // while the assignment is unchanged — re-assert it. Continuous work
        // (faction grinding) keeps isBusy true, so this is a no-op for it.
        if (winner.maintain) winner.maintain(ns, () => applyRow(ns, winner));
        else if (!ns.singularity.isBusy()) applyRow(ns, winner);
    } else if (winner.name === challenger) {
        nextStreak = challengerStreak + 1;
        if (nextStreak >= FOCUS_STABLE_TICKS) {
            const prevRow = rows.find((r) => r.name === currentRow);
            if (prevRow) prevRow.stop(ns);
            applyRow(ns, winner);
            nextCurrent = winner.name;
            nextChallenger = null;
            nextStreak = 0;
        }
    } else {
        nextChallenger = winner.name;
        nextStreak = 1;
    }

    ladderState.set({ currentRow: nextCurrent, challenger: nextChallenger, challengerStreak: nextStreak });
    setFlag(ns, "focusOwner", nextCurrent);

    return { focusOwner: nextCurrent, working: describeWork(ns.singularity.getCurrentWork()), overridden: false };
}

function applyRow(ns, row) {
    row.start(ns);
    // Record what actually started (shape, not row name) so isPilotsOwnWork can
    // distinguish pilot's work from work the player began by hand.
    setFlag(ns, "pilotWorkSig", describeWork(ns.singularity.getCurrentWork()));
}

/** True if the current work matches the signature of what pilot itself last
 *  started. A flag-presence-only check is NOT enough: the flag survives across
 *  ticks, so after pilot started anything once, everything (including work the
 *  player began manually later) would count as pilot's and get stomped. */
function isPilotsOwnWork(ns, snap) {
    const sig = getFlag(ns, "pilotWorkSig", null);
    if (sig === null) return false;
    return JSON.stringify(sig) === JSON.stringify(describeWork(snap.currentWork));
}

/** Money-wanted proxy for ladder row 8: true while the pserver manager is alive
 *  and still buying. pserver self-exits once the fleet is maxed, so a FRESH port-4
 *  snapshot (published every tick while it runs) is exactly the "still buying"
 *  signal; a stale/absent one means done (or very early startup — also fine to
 *  idle then). */
function moneyStillWanted(ns) {
    const s = readStatus(ns, STATUS_PORT_PSERVER);
    return !!s && Date.now() - s.ts < 60_000;
}

function describeWork(task) {
    if (!task) return null;
    if (task.type === "FACTION") return { faction: task.factionName, type: task.factionWorkType };
    if (task.type === "CRIME") return { crime: task.crimeType };
    // classType/location so pilot's own gym training is distinguishable from a
    // class the player started manually (both are type "CLASS").
    if (task.type === "CLASS") return { classType: task.classType, location: task.location };
    return { type: task.type };
}

// ── Status ───────────────────────────────────────────────────────────────────

function buildStatus(ns, snap, workState, lastAugPurchaseTs) {
    const sing = ns.singularity;
    const programs = sing.getDarkwebPrograms();
    const ownedCount = programs.filter((p) => snap.ownedPrograms.has(p)).length;
    const backdoorDone = [];
    const backdoorPending = [];
    for (const host of BACKDOOR_TARGETS) {
        if (ns.getServer(host).backdoorInstalled) backdoorDone.push(host);
        else backdoorPending.push(host);
    }

    return {
        ts: Date.now(),
        phase: workState.working ? "work" : "idle",
        programs: { owned: ownedCount, total: programs.length },
        backdoors: { done: backdoorDone, pending: backdoorPending },
        factions: snap.joinedFactions.length,
        pendingInvites: snap.pendingInvites ?? [],
        working: workState.working,
        focusOwner: workState.focusOwner,
        augs: {
            purchased: sing.getOwnedAugmentations(true).length,
            affordableNow: snap.augWantList?.filter((a) => a.price <= snap.money).length ?? 0,
            nextUnlock: nextUnlock(snap),
        },
        nfAffordableLevels: snap.nfAffordableLevels ?? 0,
        // Read by lifecycle.js (docs/plans/reset-lifecycle.md) as the "stagnantMs"
        // signal — null until this process's first aug purchase this run.
        lastAugPurchaseTs,
        action: workState.overridden ? "player-controlled — pilot standing by" : `ladder: ${workState.focusOwner}`,
    };
}

function nextUnlock(snap) {
    const list = snap.augWantList ?? [];
    if (list.length === 0) return null;
    const cheapest = [...list].sort((a, b) => a.price - b.price)[0];
    return { aug: cheapest.aug, faction: cheapest.faction, repNeeded: cheapest.repReq };
}

/** Refresh the tail-window status table each tick (mirrors pserver.js's style). */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 52;
    ns.print(`╔═ PILOT ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 19))}`);
    ns.print(`║ Programs ${s.programs.owned}/${s.programs.total}  |  Factions joined ${s.factions}`);
    ns.print(`║ Backdoors ${s.backdoors.done.length}/${s.backdoors.done.length + s.backdoors.pending.length}  |  Augs purchased ${s.augs.purchased}`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Ladder: ${s.focusOwner ?? "—"}${s.working ? `  (${JSON.stringify(s.working)})` : ""}`);
    if (s.augs.nextUnlock) {
        ns.print(`║ Next aug: ${s.augs.nextUnlock.aug} (${s.augs.nextUnlock.faction})`);
    }
    if (s.pendingInvites.length > 0) {
        ns.print(`║ ⚠ Pending invites (needs decision): ${s.pendingInvites.join(", ")}`);
    }
    ns.print(`╚${"═".repeat(W)}`);
}
