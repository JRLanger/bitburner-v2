/**
 * managers/pilot.js — Singularity progression manager (Roadmap 3.1).
 *
 * Automates the manual progression loop the player otherwise does by hand: buy
 * TOR + darkweb programs, install backdoors on the story servers, join factions
 * (including traveling to join a wanted city faction — one rival group per run),
 * and drive player activity via the arbitration ladder (see
 * docs/plans/arbitration.md) — including grinding faction rep toward the next-best
 * (lowest-ETA) PRIORITY augmentation. Pilot does NOT buy augs (arbitration Decision
 * 5): it reports which are unlocked; lifecycle batch-buys the set at reset. See
 * docs/plans/pilot-singularity.md and docs/scripts/pilot.md.
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
    PILOT_NEUROFLUX,
    SERVERS_JSON,
    FOCUS_STABLE_TICKS,
    STATUS_PORT_PSERVER,
    PILOT_INCOME_EMA_ALPHA,
    AUG_PRICE_RAMP,
} from "/config/constants.js";
import { PRIORITY_AUGS, AUG_BASE_PRICE } from "/config/aug-priority.js";
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
    // Per-process runtime state (not persisted; a fresh pilot post-reset starts
    // clean by construction). Grouped so the ETA/grind logic can read income &
    // rep-rate estimates that only make sense as running samples across ticks.
    const state = {
        ladder: { currentRow: null, challenger: null, challengerStreak: 0 },
        // All-sources income rate ($/s), EMA-smoothed from getMoneySources deltas.
        income: { ema: null, lastTotal: null, lastTs: null },
        // Empirical rep/sec fallback when Formulas.exe isn't owned (single estimate,
        // updated whenever pilot is working a faction).
        rep: { estimate: null, lastRep: null, lastFaction: null, lastTs: null },
        // Stagnation signal for lifecycle: when the count of ACQUIRABLE priority augs
        // (rep met AND affordable under the batch ramp) last grew. Growth comes from
        // unlocking rep OR saving money, so this stalls on whichever is binding —
        // fixing the "gang unlocks everything at once" false trigger.
        acquire: { knownCount: 0, lastAcquireTs: Date.now() },
    };

    while (true) {
        if (!singularityAvailable(ns)) {
            // Gate raced wrong (shouldn't happen — booster/orbiter already checked
            // SF4/BN4 before launch), but bail cleanly rather than spam errors.
            ns.print("Singularity API unavailable — pilot exiting.");
            return;
        }

        const snapshot = gatherState(ns);
        sampleIncome(ns, state);

        phaseTor(ns, snapshot);
        await phaseBackdoors(ns, snapshot);
        phaseFactions(ns, snapshot);
        phaseAugs(ns, snapshot);            // report-only: computes acquirableNow
        trackAcquire(state, snapshot);      // stamp lastAcquireTs when the set grows
        const workState = phaseWork(ns, snapshot, state);

        const status = buildStatus(ns, snapshot, workState, state);
        renderStatus(ns, status);
        publishStatus(ns, STATUS_PORT_PILOT, status);

        await ns.sleep(PILOT_LOOP_SLEEP);
    }
}

/** Sum of the positive income-source fields from getMoneySources (monotonic:
 *  earnings only, expenses/spends are separate fields we exclude), sampled as a
 *  delta/dt across ticks and EMA-smoothed into state.income.ema ($/s). Captures
 *  crime/gang/corp/stock income, not just hacking. */
function sampleIncome(ns, state) {
    const src = ns.getMoneySources().sinceInstall;
    const gross = src.hacking + src.crime + src.gang + src.corporation + src.stock +
        src.codingcontract + src.bladeburner + src.hacknet + src.casino + src.work +
        src.infiltration + src.sleeves + src.other;
    const now = Date.now();
    const inc = state.income;
    if (inc.lastTotal !== null && inc.lastTs !== null) {
        const dt = (now - inc.lastTs) / 1000;
        if (dt > 0) {
            const rate = Math.max(0, gross - inc.lastTotal) / dt;
            inc.ema = inc.ema === null ? rate : PILOT_INCOME_EMA_ALPHA * rate + (1 - PILOT_INCOME_EMA_ALPHA) * inc.ema;
        }
    }
    inc.lastTotal = gross;
    inc.lastTs = now;
}

/** Stamp state.acquire.lastAcquireTs whenever the ACQUIRABLE priority-aug count
 *  grows (rep met AND affordable under the ramp) — lifecycle's install stagnation
 *  signal. Growth from either rep or money, so it stalls on the binding constraint.
 *  A DROP (money spent elsewhere) doesn't reset the clock — only progress does. */
function trackAcquire(state, snap) {
    const count = snap.acquirableNow ?? 0;
    if (count > state.acquire.knownCount) state.acquire.lastAcquireTs = Date.now();
    state.acquire.knownCount = count;
    snap.lastAcquireTs = state.acquire.lastAcquireTs;
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

/** The six mutually-exclusive city factions (faction name == city name, so it
 *  doubles as the travel destination). They ban each other per getFactionEnemies:
 *  {Sector-12, Aevum} are compatible, {Chongqing, New Tokyo, Ishima} are compatible,
 *  Volhaven is solo — so a run can only join one such group. Across runs, once a
 *  city's wanted augs are owned it stops being a candidate and a rival becomes
 *  eligible, naturally exhausting the cities one group per run. */
const CITY_FACTIONS = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];
const TRAVEL_COST = 200_000;

/** Auto-join enemy-free invites (CyberSec, NiteSec, hacking groups, …) and — new —
 *  city factions when they still offer a wanted priority aug and no rival is already
 *  joined, traveling to the city if needed to trigger the invite. Non-city
 *  enemy-having factions still go to `pendingInvites` for the player to decide. */
function phaseFactions(ns, snap) {
    const sing = ns.singularity;
    const invites = sing.checkFactionInvitations();
    const joined = new Set(snap.joinedFactions);
    const owned = new Set(sing.getOwnedAugmentations(true));
    const pending = [];

    for (const faction of invites) {
        if (joined.has(faction)) continue;
        if (PILOT_JOIN_BLOCKLIST.includes(faction)) { pending.push(faction); continue; }
        const enemies = sing.getFactionEnemies(faction);
        if (enemies.length === 0) {
            if (sing.joinFaction(faction)) joined.add(faction);
        } else if (CITY_FACTIONS.includes(faction)) {
            // City faction invite present (we're in its city, reqs met) → join only if
            // no rival already joined AND it still has a wanted priority aug.
            if (!enemies.some((e) => joined.has(e)) && cityHasWantedAug(sing, faction, owned)) {
                if (sing.joinFaction(faction)) joined.add(faction);
            }
        } else {
            pending.push(faction); // other enemy factions: player decides
        }
    }

    snap.joinedFactions = [...joined];
    snap.pendingInvites = pending;
    snap.cityTarget = pursueCityFaction(ns, snap, joined, owned);
}

/** True if a faction still offers a priority aug we don't own (works for factions
 *  we haven't joined — getAugmentationsFromFaction is informational). */
function cityHasWantedAug(sing, faction, owned) {
    return sing.getAugmentationsFromFaction(faction)
        .some((aug) => PRIORITY_AUGS.has(aug) && !owned.has(aug));
}

/** Travel toward the best unjoined city faction that still has wanted augs and no
 *  rival already joined. Stays put once in a candidate city (waiting for the invite /
 *  money requirement), so it never oscillates between rivals. Respects manual
 *  override — won't yank the player mid-manual-work. Returns the pursued city (or null). */
function pursueCityFaction(ns, snap, joined, owned) {
    const sing = ns.singularity;
    const candidates = CITY_FACTIONS.filter((cf) =>
        !joined.has(cf) &&
        !sing.getFactionEnemies(cf).some((e) => joined.has(e)) &&
        cityHasWantedAug(sing, cf, owned));
    if (candidates.length === 0) return null;

    const here = ns.getPlayer().city;
    if (candidates.includes(here)) return here; // already in a candidate city — wait for invite

    if (snap.isBusy && !isPilotsOwnWork(ns, snap)) return null; // don't interrupt manual work
    // Travel to the candidate with the most wanted augs (deterministic → no thrash).
    const best = candidates
        .map((cf) => ({ cf, n: sing.getAugmentationsFromFaction(cf).filter((a) => PRIORITY_AUGS.has(a) && !owned.has(a)).length }))
        .sort((a, b) => b.n - a.n)[0].cf;
    if (ns.getServerMoneyAvailable("home") >= TRAVEL_COST) sing.travelToCity(best);
    return best;
}

// ── Phase 4: augmentations (REPORT-ONLY) ─────────────────────────────────────

/** Pilot no longer buys augs during the run (arbitration.md Decision 5): purchased
 *  augs are inert until install. Phase 4 REPORTS two counts over the priority tier:
 *   - repUnlocked: augs whose rep requirement is met (grinding progress);
 *   - acquirableNow: how many of those the reset batch could actually AFFORD right
 *     now, simulating the ~1.9x per-purchase price ramp against current money.
 *  acquirableNow is the real "ready" metric — an aug isn't ready until BOTH its rep
 *  is met AND the money exists, so this grows from rep grinding OR money saving and
 *  stalls on whichever is binding (fixing the gang-unlocks-everything false trigger). */
function phaseAugs(ns, snap) {
    const sing = ns.singularity;
    const ownedOrPurchased = new Set(sing.getOwnedAugmentations(true));
    const repMet = [];
    const seen = new Set();

    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (!PRIORITY_AUGS.has(aug)) continue;
            if (ownedOrPurchased.has(aug) || seen.has(aug)) continue;
            if (rep >= sing.getAugmentationRepReq(aug)) {
                seen.add(aug);
                repMet.push(aug);
            }
        }
    }

    snap.repUnlocked = repMet.length;
    snap.acquirableNow = countAcquirable(repMet, snap.money);
    // NeuroFlux affordable-level count: informational only (lifecycle owns the
    // actual dump, since buying early wastes the per-purchase inflation).
    snap.nfAffordableLevels = countAffordableNeuroflux(sing, snap.money);
}

/** How many of `augs` (rep-met priority aug names) the reset batch could afford now.
 *  Mirrors lifecycle's batch buy: most-expensive-first, each purchase multiplies the
 *  remaining augs' prices by AUG_PRICE_RAMP. Uses base prices (aug-priority.js) — a
 *  cheap proxy; the live buy re-reads real prices. Keeps scanning past a too-dear aug
 *  since a cheaper one may still fit at the current ramp level. */
function countAcquirable(augs, money) {
    const sorted = [...augs].sort((a, b) => (AUG_BASE_PRICE[b] ?? 0) - (AUG_BASE_PRICE[a] ?? 0));
    let cash = money;
    let bought = 0;
    for (const aug of sorted) {
        const cost = (AUG_BASE_PRICE[aug] ?? 0) * Math.pow(AUG_PRICE_RAMP, bought);
        if (cost <= cash) { cash -= cost; bought++; }
    }
    return bought;
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
            // Grind rep toward the next-best (lowest-ETA) priority aug. Target is
            // computed once per tick into snap.grindTarget (phaseWork).
            name: "faction-work",
            applicable: () => snap.grindTarget != null,
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

/** The next PRIORITY aug to grind rep toward, chosen by lowest ETA = max(money-time,
 *  rep-time) — whichever grind (earning the price or grinding the rep) is longer.
 *  Only considers priority-tier augs (aug-priority.js) that are still rep-LOCKED at
 *  a joined faction (unlocked ones are handled by lifecycle's batch buy). For each
 *  aug, grinds the joined faction where we're closest (highest current rep).
 *  Returns null when nothing priority is left to grind — the ladder then falls
 *  through to crime to accumulate money for the reset batch buy. */
function bestGrindTarget(ns, snap, state) {
    const sing = ns.singularity;
    const ownedOrPurchased = new Set(sing.getOwnedAugmentations(true));
    const income = state.income.ema; // $/s (null until two samples exist)
    const money = snap.money;

    // Per aug: the joined faction with the highest current rep (closest to unlock).
    const perAug = new Map(); // aug -> { faction, rep, repReq }
    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (!PRIORITY_AUGS.has(aug) || ownedOrPurchased.has(aug)) continue;
            const repReq = sing.getAugmentationRepReq(aug);
            if (rep >= repReq) continue; // already unlocked → not a grind target
            const cur = perAug.get(aug);
            if (!cur || rep > cur.rep) perAug.set(aug, { faction, rep, repReq });
        }
    }

    // Cache rep-rate per faction — several augs share a faction, and each rate read
    // is a Formulas call; compute once per distinct faction.
    const rateCache = new Map(); // faction -> { workType, rate }
    const factionRate = (faction) => {
        let r = rateCache.get(faction);
        if (!r) {
            const workType = pickWorkType(sing, faction);
            r = { workType, rate: repRatePerSec(ns, faction, workType, state) };
            rateCache.set(faction, r);
        }
        return r;
    };

    let winner = null;
    for (const [aug, info] of perAug) {
        const { workType, rate } = factionRate(info.faction);
        const repGap = Math.max(0, info.repReq - info.rep);
        // rate unknown (no Formulas + no empirical sample yet) → order by raw gap.
        const repTime = rate > 0 ? repGap / rate : repGap;
        const price = AUG_BASE_PRICE[aug] ?? 0;
        let moneyTime;
        if (price <= money) moneyTime = 0;
        else if (income && income > 0) moneyTime = (price - money) / income;
        else moneyTime = Infinity;
        const eta = Math.max(moneyTime, repTime);
        if (!winner || eta < winner.eta) winner = { aug, faction: info.faction, workType, eta };
    }
    return winner;
}

/** Faction work type to grind: prefer hacking (this project's stat), else the
 *  faction's first available type. */
function pickWorkType(sing, faction) {
    const types = sing.getFactionWorkTypes(faction);
    return types.includes("hacking") ? "hacking" : types[0];
}

/** Reputation gain rate (rep/sec) for a faction+workType. Exact via Formulas when
 *  Formulas.exe is owned (factionGains is per 200ms cycle → ×5 for /sec); otherwise
 *  the single empirical estimate measured while pilot works a faction (0 = unknown,
 *  caller falls back to raw rep-gap ordering). */
function repRatePerSec(ns, faction, workType, state) {
    if (ns.fileExists("Formulas.exe", "home")) {
        try {
            const favor = ns.singularity.getFactionFavor(faction);
            const gains = ns.formulas.work.factionGains(ns.getPlayer(), workType, favor);
            return Math.max(0, gains.reputation) * 5;
        } catch { /* fall through to empirical */ }
    }
    return state.rep.estimate ?? 0;
}

/** Empirical rep/sec fallback: while pilot is working a faction, measure Δrep/Δt and
 *  keep the last positive estimate (used for all factions when Formulas is absent). */
function updateRepEstimate(ns, snap, state) {
    const work = snap.currentWork;
    const now = Date.now();
    if (work?.type === "FACTION") {
        const faction = work.factionName;
        const rep = ns.singularity.getFactionRep(faction);
        if (state.rep.lastFaction === faction && state.rep.lastRep !== null && state.rep.lastTs !== null) {
            const dt = (now - state.rep.lastTs) / 1000;
            if (dt > 0) {
                const rate = Math.max(0, rep - state.rep.lastRep) / dt;
                if (rate > 0) state.rep.estimate = rate;
            }
        }
        state.rep.lastFaction = faction; state.rep.lastRep = rep; state.rep.lastTs = now;
    } else {
        state.rep.lastFaction = null; state.rep.lastRep = null; state.rep.lastTs = null;
    }
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

/** Grind the current ETA target (snap.grindTarget, computed once per tick in
 *  phaseWork). Donate money for rep once favor clears getFavorToDonate() (faster
 *  than working); otherwise work the faction (never steal focus). */
function startFactionWork(ns, snap) {
    const target = snap.grindTarget;
    if (!target) return false;
    const sing = ns.singularity;
    const favor = sing.getFactionFavor(target.faction);
    const donateThreshold = ns.getFavorToDonate ? ns.getFavorToDonate() : 150;
    if (favor >= donateThreshold) {
        const amount = Math.min(snap.money * PILOT_SPEND_FRAC, snap.money);
        if (amount > 0) sing.donateToFaction(target.faction, amount);
        return true;
    }
    return sing.workForFaction(target.faction, target.workType, false);
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
function phaseWork(ns, snap, state) {
    updateRepEstimate(ns, snap, state);          // empirical rep-rate fallback
    snap.grindTarget = bestGrindTarget(ns, snap, state); // computed once; row reads it
    const rows = ladder(ns, snap);
    const winner = rows.find((r) => r.applicable(snap)) ?? rows[rows.length - 1];

    const { currentRow, challenger, challengerStreak } = state.ladder;

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

    state.ladder = { currentRow: nextCurrent, challenger: nextChallenger, challengerStreak: nextStreak };
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

function buildStatus(ns, snap, workState, state) {
    const sing = ns.singularity;
    const programs = sing.getDarkwebPrograms();
    const ownedCount = programs.filter((p) => snap.ownedPrograms.has(p)).length;
    const backdoorDone = [];
    const backdoorPending = [];
    for (const host of BACKDOOR_TARGETS) {
        if (ns.getServer(host).backdoorInstalled) backdoorDone.push(host);
        else backdoorPending.push(host);
    }
    const target = snap.grindTarget;

    return {
        ts: Date.now(),
        phase: workState.working ? "work" : "idle",
        programs: { owned: ownedCount, total: programs.length },
        backdoors: { done: backdoorDone, pending: backdoorPending },
        factions: snap.joinedFactions.length,
        pendingInvites: snap.pendingInvites ?? [],
        cityTarget: snap.cityTarget ?? null,
        working: workState.working,
        focusOwner: workState.focusOwner,
        augs: {
            purchased: sing.getOwnedAugmentations(true).length,
            repUnlocked: snap.repUnlocked ?? 0,   // priority augs with rep met
            acquirableNow: snap.acquirableNow ?? 0, // ...and affordable under the ramp
            grindTarget: target ? { aug: target.aug, faction: target.faction, etaSec: Math.round(target.eta) } : null,
        },
        nfAffordableLevels: snap.nfAffordableLevels ?? 0,
        incomePerSec: state.income.ema ?? 0,
        // Read by lifecycle.js (docs/plans/reset-lifecycle.md): how many priority augs
        // the reset batch could afford now (rep met AND money saved), + when that count
        // last grew — its install stagnation signal (stalls on money OR rep, whichever binds).
        acquirableNow: snap.acquirableNow ?? 0,
        lastAcquireTs: snap.lastAcquireTs ?? null,
        action: workState.overridden ? "player-controlled — pilot standing by" : `ladder: ${workState.focusOwner}`,
    };
}

/** Refresh the tail-window status table each tick (mirrors pserver.js's style). */
function renderStatus(ns, s) {
    ns.clearLog();
    const W = 52;
    ns.print(`╔═ PILOT ═ ${new Date().toLocaleTimeString()} ${"═".repeat(Math.max(0, W - 19))}`);
    ns.print(`║ Programs ${s.programs.owned}/${s.programs.total}  |  Factions joined ${s.factions}`);
    ns.print(`║ Backdoors ${s.backdoors.done.length}/${s.backdoors.done.length + s.backdoors.pending.length}  |  Augs installed ${s.augs.purchased}  |  ready ${s.augs.acquirableNow}/${s.augs.repUnlocked} (afford/rep)`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Ladder: ${s.focusOwner ?? "—"}${s.working ? `  (${JSON.stringify(s.working)})` : ""}`);
    if (s.augs.grindTarget) {
        const g = s.augs.grindTarget;
        const eta = Number.isFinite(g.etaSec) ? `${(g.etaSec / 60).toFixed(0)}m` : "∞";
        ns.print(`║ Grinding: ${g.aug} @ ${g.faction} (ETA ${eta})`);
    }
    if (s.cityTarget) {
        ns.print(`║ City faction target: ${s.cityTarget} (travel/join)`);
    }
    if (s.pendingInvites.length > 0) {
        ns.print(`║ ⚠ Pending invites (needs decision): ${s.pendingInvites.join(", ")}`);
    }
    ns.print(`╚${"═".repeat(W)}`);
}
