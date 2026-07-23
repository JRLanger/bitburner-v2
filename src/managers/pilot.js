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
 * in each controller) once the SF4 gate passes. RAM note (see
 * docs/reference/game-mechanics.md): script RAM is charged per DISTINCT ns
 * function referenced in the source — call frequency and tick rate are
 * irrelevant. So the RAM discipline here is (a) never import this file into
 * booster/orbiter (each singularity function would be re-charged there, ×16/×4/×1
 * by SF4 level), and (b) keep the set of distinct singularity functions minimal.
 * The slow tick (PILOT_LOOP_SLEEP) is purely for CPU and observability.
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
    RED_PILL_AUG,
    SERVERS_JSON,
    FOCUS_STABLE_TICKS,
    STATUS_PORT_PSERVER,
    PILOT_INCOME_EMA_ALPHA,
    AUG_PRICE_RAMP,
    PILOT_DEBUG,
    PILOT_DEBUG_LOG,
    HOME_RAM_SPEND_FRAC,
    HOME_RAM_MAX_GB,
    DONATE_SLOP,
    TRAIN_STAT_BUFFER,
    GRIND_WEIGHTS,
    GRIND_ETA_SKIP_MS,
} from "/config/constants.js";
import { PRIORITY_AUGS, AUG_BASE_PRICE } from "/config/aug-priority.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { getFlag, setFlag, moneyFloor, setReservation, clearReservation } from "/lib/flags.js";
import { findPath } from "/lib/netpath.js";
import { debugLog } from "/lib/debug-log.js";

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
/** Sector-12's university (LocationNameEnumType.Sector12RothmanUniversity). Any
 *  university works; this one is reachable from the same starting city as
 *  GYM_LOCATION. universityCourse returns false if unreachable — the training
 *  row's maintain() just retries next tick (no dedicated travel in v1). */
const UNIVERSITY_LOCATION = "Rothman University";
/** UniversityClassType enum values used for training-demand rows
 *  (faction-prereqs-training.md): charisma -> Leadership, hacking -> Algorithms. */
const UNIVERSITY_COURSE_BY_STAT = { charisma: "Leadership", hacking: "Algorithms" };
/** Hand-curated list of "classic" requirement-gated factions worth pursuing via
 *  the prereq planner (faction-prereqs-training.md). No Netscript API enumerates
 *  ALL faction names (verified against NetscriptDefinitions.d.ts: FactionName is a
 *  closed enum type, not something a getter returns as a list) short of exhaustively
 *  listing the enum itself, so this is that list, kept here (not aug-priority.js,
 *  which has no faction mapping) so the player can add/remove factions as they learn
 *  which augs matter for their build. City factions are handled separately by the
 *  existing CITY_FACTIONS/pursueCityFaction travel logic and are NOT repeated here. */
const PLANNED_FACTIONS = [
    "CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus", "The Covenant",
    "Illuminati", "Tetrads", "Slum Snakes", "Tian Di Hui", "Netburners",
    "Bachman & Associates", "ECorp", "MegaCorp", "KuaiGong International", "Four Sigma",
    "NWO", "Blade Industries", "OmniTek Incorporated", "Fulcrum Secret Technologies",
    "Clarke Incorporated", "Speakers for the Dead", "The Dark Army", "The Syndicate",
    "Silhouette",
];
/** Below this much home RAM, nothing else in the pipeline works yet — see
 *  arbitration.md ladder row 1. */
const BOOTSTRAP_HOME_RAM_GB = 32;
/** NeuroFlux Governor per-level scaling: each level multiplies BOTH its price and its
 *  rep requirement by this factor. Long-standing Bitburner constant (base $750k / 500
 *  rep, ×1.14 per level — see docs/reference/augmentations.md). VERIFY in-game if NF
 *  ready-counts look off. Used only to simulate how many NF levels are rep+money-ready
 *  (countReadyNeuroflux); the actual buy loop in lifecycle re-reads live prices. */
const NF_LEVEL_MULT = 1.14;
/** Loop cap for the NF ready-count simulation (bounds the while loop). */
const NF_READY_CAP = 1000;

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
        // True while pilot has traveled the player away for a city faction — lets it
        // travel back to Sector-12 (for the crime-row gym) once city joins are done,
        // without disturbing a city the PLAYER chose manually.
        travel: { awayForCity: false },
        // home-ram.md: per-process count of home-RAM upgrades bought (dashboard only).
        homeRamBought: 0,
        // faction-prereqs-training.md: computeFactionPlans' output, refreshed at the
        // end of phaseFactions each tick — { training, backdoors, company, byFaction }.
        // phaseBackdoors runs BEFORE phaseFactions in the tick loop, so it reads last
        // tick's plans; one tick of staleness is harmless here.
        plans: { training: [], backdoors: [], company: [], byFaction: [] },
        // Empirical stat-gain rate (stat units/sec) for the currently ladder-trained
        // stat, sampled the same way as state.rep's empirical rep-rate fallback.
        train: { lastStat: null, lastVal: null, lastTs: null, rate: null },
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
        phaseHomeRam(ns, snapshot, state);  // home-ram.md: after TOR, before augs report
        await phaseBackdoors(ns, snapshot, state);
        phaseFactions(ns, snapshot, state);
        phaseAugs(ns, snapshot);            // report-only: computes acquirableNow
        trackAcquire(state, snapshot);      // stamp lastAcquireTs when the set grows
        const workState = phaseWork(ns, snapshot, state);

        const status = buildStatus(ns, snapshot, workState, state);
        renderStatus(ns, status);
        publishStatus(ns, STATUS_PORT_PILOT, status);

        if (PILOT_DEBUG) logTick(ns, snapshot, workState, state);

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

/** One place that calls the singularity getters, so every phase this tick works
 *  off a single consistent read instead of re-querying the same data repeatedly
 *  (consistency + CPU; repeat calls have no RAM effect — game-mechanics.md). */
function gatherState(ns) {
    const sing = ns.singularity;
    const moneyRaw = ns.getServerMoneyAvailable("home");
    const floor = moneyFloor(ns);
    return {
        // moneyFloor (lib/flags.js): reserve lifecycle asks all managers to leave
        // untouched — Infinity during the pre-reset checklist freezes spending
        // entirely. Subtracted at the snapshot so every phase's spend cap sees it.
        money: Math.max(0, moneyRaw - floor),
        // wallet-reservations.md: the aug-batch reservation IS money computed from THIS
        // field (phaseAugs/countAcquirable/countReadyNeuroflux use it, nothing else
        // does). It subtracts only the FROZEN floor (raw flag), never the live
        // reservation total moneyFloor() now includes — feeding fully-floored money
        // into the aug simulation would count pilot's own reservation against itself
        // and shrink it to zero every tick (self-shrink feedback loop).
        moneyForAugs: Math.max(0, moneyRaw - getFlag(ns, "moneyFloor", 0)),
        moneyRaw,        // pre-floor, for debug logging
        moneyFloor: floor, // for debug logging
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

// ── Phase (home RAM) ─────────────────────────────────────────────────────────

/** docs/plans/home-ram.md — perpetual home-RAM upgrading. One upgrade per tick max
 *  (observable buys; the doubling cost curve makes the frac gate self-limiting).
 *  snap.money is net of floor + reservations, so the aug batch is never raided —
 *  per user decision (2026-07-13), home RAM buys strictly from unreserved money. */
function phaseHomeRam(ns, snap, state) {
    if (snap.homeRam >= HOME_RAM_MAX_GB) return;
    const cost = ns.singularity.getUpgradeHomeRamCost();
    snap.nextHomeRamCost = cost;
    if (cost > snap.money * HOME_RAM_SPEND_FRAC) return;
    if (ns.singularity.upgradeHomeRam()) {
        snap.homeRam = ns.getServerMaxRam("home");
        state.homeRamBought = (state.homeRamBought ?? 0) + 1;
        snap.money = Math.max(0, snap.money - cost);
    }
}

// ── Phase 2: backdoors ───────────────────────────────────────────────────────

/** One backdoor per tick max (per the plan) — keeps ticks short and each install
 *  individually observable. Walks the path via lib/netpath.js (reads the `parent`
 *  field booster/orbiter now stamp into servers.json), connects hop-by-hop,
 *  installs, then always returns home.
 *  Backdoor state is checked here via ns.getServer rather than stamped into
 *  servers.json — booster shouldn't pay getServer's RAM just to feed pilot, and
 *  pilot (home-only, already singularity-priced) checks at most 5 hosts.
 *  faction-prereqs-training.md: hosts computeFactionPlans flagged as gating a
 *  wanted faction's invite (state.plans.backdoors, one tick stale — see main's
 *  phase-order comment) are prepended so the planner's picks jump the queue ahead
 *  of the static BACKDOOR_TARGETS list; deduped via Set. */
async function phaseBackdoors(ns, snap, state) {
    const sing = ns.singularity;
    const byHost = new Map(snap.servers.map((s) => [s.hostname, s]));
    const hackLvl = ns.getHackingLevel();
    const targets = [...new Set([...(state.plans?.backdoors ?? []), ...BACKDOOR_TARGETS])];

    for (const host of targets) {
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
function phaseFactions(ns, snap, state) {
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
            // POLICY (user decision 2026-07-13): every enemy-free invite is joined
            // UNCONDITIONALLY, the tick it appears — even a faction with zero wanted
            // augs. Joining costs nothing, can't block anything (no enemies), and
            // membership is pure upside (rep channel, intelligence XP). Only factions
            // with enemies (city rivals) are ever gated on aug value. A failed join
            // goes to pendingInvites so it's visible instead of silently dropped.
            if (sing.joinFaction(faction)) joined.add(faction);
            else pending.push(faction);
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
    snap.cityTarget = pursueCityFaction(ns, snap, joined, owned, state);
    computeFactionPlans(ns, snap, owned, joined, state);
}

// ── Faction-prereq planner (faction-prereqs-training.md) ────────────────────

/** True if a PlayerRequirement (or compound someCondition/everyCondition tree) is
 *  currently satisfied. Pure predicate — no demand side effects — so it can be
 *  called freely while picking someCondition's cheapest unmet branch below.
 *  companyReputation/employedBy have no cheap NS check available under this file's
 *  RAM budget (no new getCompanyRep-style call is allowed), so they're conservatively
 *  treated as unmet — report-only, never blocking anything pilot itself decides. */
function reqMet(req, player, ns) {
    switch (req.type) {
        case "money": return player.money >= req.money;
        case "city": return player.city === req.city;
        case "backdoorInstalled": return ns.getServer(req.server).backdoorInstalled;
        case "skills": return Object.entries(req.skills).every(([stat, lvl]) => player.skills[stat] >= lvl);
        case "companyReputation":
        case "employedBy":
            return false;
        case "not": return !reqMet(req.condition, player, ns);
        case "someCondition": return req.conditions.some((c) => reqMet(c, player, ns));
        case "everyCondition": return req.conditions.every((c) => reqMet(c, player, ns));
        // karma, numAugmentations, jobTitle, bladeburnerRank, numInfiltrations,
        // sourceFile, bitNodeN, hacknet*, file, location, numPeopleKilled: no
        // actionable demand pilot can produce, and most are satisfied by other
        // paths (gang/resets) — report-only, treated as met so they never block.
        default: return true;
    }
}

/** "Cheapest" ordering for someCondition's unmet-branch pick (faction-prereqs-
 *  training.md: prefer skills > backdoor > company). Lower = cheaper. */
function reqCheapness(req) {
    if (req.type === "skills") return 0;
    if (req.type === "backdoorInstalled") return 1;
    if (req.type === "companyReputation" || req.type === "employedBy") return 2;
    return 3;
}

/** Stats the training row can actually raise (gym: combat, university: charisma/
 *  hacking). A skills demand for anything else (e.g. intelligence) must stay
 *  report-only: an untrainable demand would keep the training row applicable while
 *  startTraining has nothing to start — pilot would idle forever on it. */
const TRAINABLE_STATS = new Set([
    ...COMBAT_SKILLS.map(([full]) => full), "charisma", "hacking",
]);

/** Records demands (training/backdoors/company) for an UNMET requirement into
 *  `out`, recursing into compound types: someCondition is unmet only when ALL
 *  branches are unmet, so only its single cheapest branch is demand-ified (no point
 *  training AND backdooring when either alone would satisfy it); everyCondition
 *  demands every one of its unmet branches (all must be satisfied). Leaf types with
 *  no actionable demand (money, city, karma, ...) just record their type string for
 *  the dashboard's byFaction.unmet list. */
function recordDemand(req, player, ns, out) {
    switch (req.type) {
        case "skills":
            for (const [stat, target] of Object.entries(req.skills)) {
                if (!TRAINABLE_STATS.has(stat)) continue; // report-only via the push below
                if (player.skills[stat] < target) {
                    const cur = out.training.get(stat);
                    if (!cur || target > cur) out.training.set(stat, target);
                }
            }
            out.unmetTypes.push("skills");
            return;
        case "backdoorInstalled":
            out.backdoors.add(req.server);
            out.unmetTypes.push("backdoorInstalled");
            return;
        case "companyReputation":
        case "employedBy":
            out.company.push(req);
            out.unmetTypes.push(req.type);
            return;
        case "not":
            // Satisfying a NOT means making the inner condition FAIL (e.g. "not
            // employed by CIA") — generating demands that would SATISFY it is exactly
            // backwards, and pilot has no un-doing actions anyway. Report-only.
            out.unmetTypes.push("not");
            return;
        case "someCondition": {
            const unmetBranches = req.conditions.filter((c) => !reqMet(c, player, ns));
            if (unmetBranches.length === 0) return;
            const cheapest = [...unmetBranches].sort((a, b) => reqCheapness(a) - reqCheapness(b))[0];
            recordDemand(cheapest, player, ns, out);
            return;
        }
        case "everyCondition":
            for (const c of req.conditions) {
                if (!reqMet(c, player, ns)) recordDemand(c, player, ns, out);
            }
            return;
        default:
            out.unmetTypes.push(req.type);
    }
}

/** Prereq planner (faction-prereqs-training.md Part A): for each PLANNED_FACTIONS
 *  entry that's unjoined, not blocklisted, enemy-free with what's already joined,
 *  and still offers an unowned priority aug, classify getFactionInviteRequirements
 *  into training/backdoor/company demands + a report-only unmet-type list. No
 *  Netscript API enumerates every faction name (FactionName is a closed enum in the
 *  type defs, not something a getter returns as a list) — see PLANNED_FACTIONS.
 *  Result lands in state.plans (not snap): phaseBackdoors runs BEFORE phaseFactions
 *  in the tick loop, so it reads last tick's plans — one tick of staleness, fine. */
function computeFactionPlans(ns, snap, owned, joined, state) {
    const sing = ns.singularity;
    const player = ns.getPlayer();
    const out = { training: new Map(), backdoors: new Set(), company: [], unmetTypes: [] };
    const byFaction = [];

    for (const faction of PLANNED_FACTIONS) {
        // The WHOLE per-faction body is guarded: PLANNED_FACTIONS is hand-typed, and
        // getFactionEnemies/getAugmentationsFromFaction THROW on a name the game
        // doesn't recognize (typo, faction absent this BN). An uncaught throw here
        // kills pilot's entire loop — including the invite auto-join — so one bad
        // list entry must never take the whole manager down.
        try {
            if (joined.has(faction) || PILOT_JOIN_BLOCKLIST.includes(faction)) continue;
            if (sing.getFactionEnemies(faction).some((e) => joined.has(e))) continue;
            if (!sing.getAugmentationsFromFaction(faction).some((a) => PRIORITY_AUGS.has(a) && !owned.has(a))) continue;

            const reqs = sing.getFactionInviteRequirements(faction);
            const unmet = [];
            for (const req of reqs) {
                if (reqMet(req, player, ns)) continue;
                const before = out.unmetTypes.length;
                recordDemand(req, player, ns, out);
                unmet.push(...out.unmetTypes.slice(before));
            }
            if (unmet.length > 0) byFaction.push({ faction, unmet });
        } catch {
            continue; // bad/unavailable faction name — skip it, keep pilot alive
        }
    }

    state.plans = {
        // Dedup per stat, keeping the largest target (a stat can be demanded by
        // multiple factions at different levels).
        training: [...out.training].map(([stat, target]) => ({ stat, target })),
        backdoors: [...out.backdoors],
        company: out.company,
        byFaction,
    };
}

/** True if a faction still offers a priority aug we don't own (works for factions
 *  we haven't joined — getAugmentationsFromFaction is informational). */
function cityHasWantedAug(sing, faction, owned) {
    return sing.getAugmentationsFromFaction(faction)
        .some((aug) => PRIORITY_AUGS.has(aug) && !owned.has(aug));
}

/** Travel toward the best unjoined city faction that still has wanted augs and no
 *  rival already joined. Stays put once in a candidate city (waiting for the invite /
 *  money requirement), so it never oscillates between rivals. When there are no more
 *  city candidates, travels the player BACK to Sector-12 (only if pilot was the one
 *  who left) so the crime row's gym is reachable again. Respects manual override.
 *  Returns the pursued city, "Sector-12" while returning, or null. */
function pursueCityFaction(ns, snap, joined, owned, state) {
    const sing = ns.singularity;
    const manualOverride = snap.isBusy && !isPilotsOwnWork(ns, snap);
    const affordTravel = () => ns.getServerMoneyAvailable("home") >= TRAVEL_COST;

    const candidates = CITY_FACTIONS.filter((cf) =>
        !joined.has(cf) &&
        !sing.getFactionEnemies(cf).some((e) => joined.has(e)) &&
        cityHasWantedAug(sing, cf, owned));

    if (candidates.length === 0) {
        // City-faction pursuit is done. If pilot traveled away for it, go home to
        // Sector-12 so gymWorkout (crime row) works again. Don't touch a city the
        // player chose manually (awayForCity stays false unless pilot moved them).
        if (state.travel.awayForCity && ns.getPlayer().city !== "Sector-12" && !manualOverride && affordTravel()) {
            if (sing.travelToCity("Sector-12")) state.travel.awayForCity = false;
            return "Sector-12";
        }
        return null;
    }

    const here = ns.getPlayer().city;
    if (candidates.includes(here)) return here; // already in a candidate city — wait for invite
    if (manualOverride) return null;

    // Travel to the candidate with the most wanted augs (deterministic → no thrash).
    const best = candidates
        .map((cf) => ({ cf, n: sing.getAugmentationsFromFaction(cf).filter((a) => PRIORITY_AUGS.has(a) && !owned.has(a)).length }))
        .sort((a, b) => b.n - a.n)[0].cf;
    if (affordTravel() && sing.travelToCity(best)) state.travel.awayForCity = true;
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
    const repMetPriority = [];
    const repMetRest = [];
    let priorityLocked = false;   // a priority aug is unowned and rep-met at NO faction
    let anyUnownedReal = false;   // any non-NF aug at a joined faction we don't own yet
    const seen = new Set();

    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (aug === PILOT_NEUROFLUX || ownedOrPurchased.has(aug)) continue;
            anyUnownedReal = true;
            const prio = PRIORITY_AUGS.has(aug);
            if (rep >= sing.getAugmentationRepReq(aug)) {
                if (seen.has(aug)) continue;
                seen.add(aug);
                (prio ? repMetPriority : repMetRest).push(aug);
            } else if (prio) {
                priorityLocked = true; // still grindable → priority tier not finished
            }
        }
    }

    // The Red Pill is a priority aug; if it's rep-met and unbought, lifecycle installs
    // ASAP to claim it (redPillReady drives the redPillTrigger install).
    snap.redPillReady = repMetPriority.includes(RED_PILL_AUG);

    // wallet-reservations.md: feed the aug simulation moneyForAugs (raw minus only
    // the frozen floor), never the fully-floored snap.money — see gatherState.
    const nfReady = countReadyNeuroflux(sing, snap.moneyForAugs, bestNeurofluxFaction(sing, snap.joinedFactions));
    snap.nfAffordableLevels = nfReady.levels;

    if (anyUnownedReal) {
        // Real augs still obtainable → readiness = what the reset batch would buy now:
        // priority augs always, plus non-priority once no priority aug is rep-locked
        // (mirrors batchBuyAugs's cascade). NeuroFlux is excluded here — it's the
        // pre-reset dump, not part of the real-aug batch.
        const readySet = priorityLocked ? repMetPriority : [...repMetPriority, ...repMetRest];
        snap.repUnlocked = readySet.length;
        const { bought, cost } = countAcquirable(readySet, snap.moneyForAugs);
        snap.acquirableNow = bought;
        // wallet-reservations.md: earmark the simulated cost so no other spender
        // (pserver, hacknet, pilot's own programs/donations/home-RAM) can un-ready an
        // already-acquirable aug. Refreshed every tick (single writer: pilot).
        if (cost > 0) setReservation(ns, "augBatch", cost, "pilot", "acquirable augs");
        else clearReservation(ns, "augBatch");
        snap.reservedForAugs = cost;
    } else {
        // Every real aug at joined factions is owned → NeuroFlux becomes the "real" aug,
        // treated EXACTLY like a real-aug batch: its rep+money-ready level count IS the
        // readiness metric (grinding NF rep grows readyCount, keeping the run open until
        // the install trigger fires), AND its cost is reserved so no other spender
        // (home-RAM, hacknet, pserver) drains the money and un-readies levels — that
        // starvation is what made readyCount collapse to 0. The reservation is released at
        // reset by lifecycle's liquidateAndFreeze (clears "augBatch"), so dumpNeuroflux
        // still buys freely under the freeze; during the run it just keeps the count stable.
        const { levels, cost } = nfReady;
        snap.repUnlocked = levels;
        snap.acquirableNow = levels;
        if (cost > 0) setReservation(ns, "augBatch", cost, "pilot", "neuroflux levels");
        else clearReservation(ns, "augBatch");
        snap.reservedForAugs = cost;
    }
}

/** How many of `augs` (rep-met priority aug names) the reset batch could afford now,
 *  and the cumulative simulated cost of those it counted (wallet-reservations.md:
 *  the caller reserves this cost so no other spender un-readies it). Mirrors
 *  lifecycle's batch buy: most-expensive-first, each purchase multiplies the
 *  remaining augs' prices by AUG_PRICE_RAMP. Uses base prices (aug-priority.js) — a
 *  cheap proxy; the live buy re-reads real prices. Keeps scanning past a too-dear aug
 *  since a cheaper one may still fit at the current ramp level. */
function countAcquirable(augs, money) {
    const sorted = [...augs].sort((a, b) => (AUG_BASE_PRICE[b] ?? 0) - (AUG_BASE_PRICE[a] ?? 0));
    let cash = money;
    let bought = 0;
    let cost = 0;
    for (const aug of sorted) {
        const price = (AUG_BASE_PRICE[aug] ?? 0) * Math.pow(AUG_PRICE_RAMP, bought);
        if (price <= cash) { cash -= price; cost += price; bought++; }
    }
    return { bought, cost };
}

// ── Phase 5: player-activity ladder (arbitration.md) ────────────────────────

/**
 * choosePlayerActivity() — priority ladder (arbitration.md, amended 2026-07-13 —
 * weighted-ETA grind selection). Rows carry `cls: "gate" | "grind"`. GATE rows
 * (bootstrap-crime, the bladeburner stubs, idle) preempt absolutely in ladder
 * order, same as before. Among applicable GRIND rows (karma-grind, company-work,
 * stat-training, faction-work, crime-fallback) pickWinner() (see phaseWork) picks
 * the lowest ETA/GRIND_WEIGHTS[row] instead of the first one in ladder order — see
 * the arbitration.md amendment for the full rationale (a strict top-row-wins rule
 * would let rep grinding monopolize focus and stall gang formation). This build
 * implements rows 1 (bootstrap crime), 5 (stat training), 6 (faction work), 8
 * (crime fallback), 9 (idle). Rows 2-4 and 7 depend on mechanic managers that don't
 * exist yet; they're written as always-inapplicable placeholders so the ladder's
 * shape (an ordered {name, cls, applicable, start, stop, eta?} array) is already
 * correct and future plans only need to insert rows, never restructure this
 * function.
 */
function ladder(ns, snap, state) {
    return [
        {
            name: "bootstrap-crime",
            cls: "gate",
            applicable: () => snap.homeRam < BOOTSTRAP_HOME_RAM_GB,
            start: (ns) => startCrimeOrTrain(ns),
            maintain: (ns, reassert) => maintainCrime(ns, reassert),
            stop: (ns) => ns.singularity.stopAction(),
        },
        // Row 2 (karma grind / gang assist) — needs the gang manager's focusRequest.
        { name: "karma-grind", cls: "grind", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 3 (Bladeburner, BN6/7) — needs the bladeburner manager.
        { name: "bladeburner-bn67", cls: "gate", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 4 (company work for a needed invite) — needs invite-requirement scan.
        // (faction-prereqs-training.md publishes the demand via state.plans.company;
        // servicing it is this row's own follow-up plan, still a stub here.)
        { name: "company-work", cls: "grind", applicable: () => false, start: () => {}, stop: () => {} },
        // Row 5 (grafting) — needs the grafting manager's focusRequest.
        { name: "grafting", applicable: () => false, start: () => {}, stop: () => {} },
        {
            // faction-prereqs-training.md: train the largest-deficit stat any planned
            // faction's invite still requires (or a gang homicide-chance demand later),
            // to target × TRAIN_STAT_BUFFER so it doesn't flap at the boundary.
            name: "stat-training",
            cls: "grind",
            applicable: () => nextTrainingDemand(ns, state) != null,
            start: (ns) => startTraining(ns, state),
            maintain: (ns, reassert) => maintainTraining(ns, state, reassert),
            stop: (ns) => ns.singularity.stopAction(),
            eta: () => trainingEta(ns, state),
        },
        {
            // Grind rep toward the next-best aug: the lowest-ETA priority aug when one
            // is rep-locked, else the fallback (non-priority aug, then NeuroFlux) so
            // pilot never idles. Effective target computed into snap.workTarget
            // (phaseWork); snap.grindTarget holds the priority-only target for status.
            name: "faction-work",
            cls: "grind",
            applicable: () => snap.workTarget != null,
            start: (ns) => startFactionWork(ns, snap),
            maintain: (ns, reassert) => maintainFactionWork(ns, snap, reassert),
            stop: (ns) => ns.singularity.stopAction(),
            // pilot's own ETA is computed in SECONDS (bestAugByEta) — convert to ms.
            // Infinity for the NeuroFlux fallback target propagates through unchanged.
            eta: () => (snap.workTarget ? snap.workTarget.eta * 1000 : null),
        },
        // Row 7 (Bladeburner, non-BN6/7 passive) — needs the bladeburner manager.
        { name: "bladeburner-passive", applicable: () => false, start: () => {}, stop: () => {} },
        {
            // Money fallback (arbitration row 8): only while money is still wanted —
            // proxied by "pserver manager hasn't reported the fleet fully maxed yet".
            // Once the fleet is done, spare player time is worth more idle than
            // heisting, and the ladder falls through to row 9.
            name: "crime-fallback",
            cls: "grind",
            applicable: () => moneyStillWanted(ns),
            start: (ns) => startCrimeOrTrain(ns),
            maintain: (ns, reassert) => maintainCrime(ns, reassert),
            stop: (ns) => ns.singularity.stopAction(),
            eta: () => Infinity, // pure money baseline — never the ETA-favored pick
        },
        {
            name: "idle",
            cls: "gate",
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
    return bestAugByEta(ns, snap, state, (aug) => PRIORITY_AUGS.has(aug));
}

/** Fallback grind when NO priority aug is rep-locked (bestGrindTarget returned null):
 *  keep the player productive rather than idling. First grind the best NON-priority
 *  rep-locked aug by ETA; if none remain either, grind rep for NeuroFlux (endless —
 *  earned rep grows the NF ready-count that phaseAugs now reports, so lifecycle
 *  installs the NF batch when it plateaus). So pilot never stops while any rep can
 *  still be earned. `workSource` (priority / non-priority / neuroflux) tells lifecycle
 *  which tier this is, so NF grinding is treated as real progress, not idle. */
function fallbackGrindTarget(ns, snap, state) {
    const nonPriority = bestAugByEta(ns, snap, state, (aug) => !PRIORITY_AUGS.has(aug));
    if (nonPriority) return nonPriority;
    return neurofluxGrindTarget(ns, snap);
}

/** Grind target for NeuroFlux: the joined faction with the highest current rep — the
 *  same one dumpNeuroflux buys from — so earned rep maximizes the reset NF dump. */
function neurofluxGrindTarget(ns, snap) {
    const sing = ns.singularity;
    // Only workable factions — the gang faction often has the highest rep (respect
    // converts to rep) but can't be worked, so it must not win the NF grind slot.
    const workable = snap.joinedFactions.filter((f) => pickWorkType(sing, f) !== null);
    const best = bestRepFaction(sing, workable);
    if (best === null) return null;
    return { aug: PILOT_NEUROFLUX, faction: best, workType: pickWorkType(sing, best), eta: Infinity };
}

/** Highest-rep joined faction that actually SELLS NeuroFlux — where lifecycle's
 *  dumpNeuroflux buys it. The bare highest-rep faction is often the GANG faction
 *  (respect converts to huge rep) which does NOT offer NeuroFlux, so counting NF
 *  readiness against its rep over-reports levels that can never be bought — the
 *  false-trigger that wedged the pre-install money freeze. Filtering to NF-selling
 *  factions keeps the count honest and aligned with the grind + the buy. */
function bestNeurofluxFaction(sing, factions) {
    return bestRepFaction(
        sing,
        factions.filter((f) => sing.getAugmentationsFromFaction(f).includes(PILOT_NEUROFLUX)),
    );
}

/** Joined faction with the highest current reputation — where NeuroFlux is grinded
 *  and dumped (dumpNeuroflux picks the same). */
function bestRepFaction(sing, factions) {
    let best = null;
    let bestRep = -Infinity;
    for (const faction of factions) {
        const rep = sing.getFactionRep(faction);
        if (rep > bestRep) { bestRep = rep; best = faction; }
    }
    return best;
}

/** How many NeuroFlux levels are READY now — rep met AND affordable — at the given
 *  faction, plus the cumulative price of those levels (`cost`, so the caller can reserve
 *  it, wallet-reservations.md). Simulates successive buys: each level's price and rep
 *  requirement grow by NF_LEVEL_MULT, stopping when the next level's rep exceeds current
 *  faction rep or its price exceeds remaining money. This is NF's analogue of
 *  countAcquirable, so when all real augs are owned NF becomes the "ready" metric that
 *  drives lifecycle's install AND the money-reservation, exactly like a real aug batch. */
function countReadyNeuroflux(sing, money, faction) {
    if (!faction) return { levels: 0, cost: 0 };
    const rep = sing.getFactionRep(faction);
    let repReq, price;
    try {
        repReq = sing.getAugmentationRepReq(PILOT_NEUROFLUX);
        price = sing.getAugmentationPrice(PILOT_NEUROFLUX);
    } catch {
        return { levels: 0, cost: 0 };
    }
    let cash = money;
    let n = 0;
    let cost = 0;
    while (n < NF_READY_CAP && repReq <= rep && price <= cash) {
        cash -= price;
        cost += price;
        n++;
        repReq *= NF_LEVEL_MULT;
        price *= NF_LEVEL_MULT;
    }
    return { levels: n, cost };
}

/** Core ETA selector: over augs matching `augFilter` that are rep-locked at a joined
 *  faction and not owned, pick the lowest ETA = max(moneyTime, repTime). */
function bestAugByEta(ns, snap, state, augFilter) {
    const sing = ns.singularity;
    const ownedOrPurchased = new Set(sing.getOwnedAugmentations(true));
    const income = state.income.ema; // $/s (null until two samples exist)
    const money = snap.money;

    // Per aug: the joined faction with the highest current rep (closest to unlock).
    const perAug = new Map(); // aug -> { faction, rep, repReq }
    for (const faction of snap.joinedFactions) {
        // Skip factions whose rep can't be worked (e.g. the gang faction) — their
        // augs are unlockable only through that mechanic, never via workForFaction.
        if (pickWorkType(sing, faction) === null) continue;
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (!augFilter(aug) || aug === PILOT_NEUROFLUX || ownedOrPurchased.has(aug)) continue;
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
    // A faction with no workable types (e.g. the player's GANG faction, whose rep is
    // earned only via gang respect) yields null — callers skip it as a work target.
    return types.includes("hacking") ? "hacking" : (types[0] ?? null);
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

// ── Stat training row (faction-prereqs-training.md) ─────────────────────────

/** Maps a CLASS work's classType (GymType short code or UniversityClassType name)
 *  back to the Player.skills field it trains, or null if it isn't one of the
 *  stats the training row drives (e.g. a class the player started manually). */
function classToStat(classType) {
    const combat = COMBAT_SKILLS.find(([, short]) => short === classType);
    if (combat) return combat[0];
    if (classType === UNIVERSITY_COURSE_BY_STAT.charisma) return "charisma";
    if (classType === UNIVERSITY_COURSE_BY_STAT.hacking) return "hacking";
    return null;
}

/** The largest-deficit training demand still below its buffer target, or null when
 *  every planned demand is satisfied (row goes inapplicable, ladder moves on).
 *  "Largest deficit" (not smallest) so pilot clears the furthest-behind stat first —
 *  arbitrary but deterministic (no flapping between near-tied demands). */
function nextTrainingDemand(ns, state) {
    const demands = state.plans?.training ?? [];
    if (demands.length === 0) return null;
    const skills = ns.getPlayer().skills;
    let best = null;
    let bestDeficit = -Infinity;
    for (const d of demands) {
        if (skills[d.stat] >= d.target * TRAIN_STAT_BUFFER) continue; // met, with buffer
        const deficit = d.target - skills[d.stat];
        if (deficit > bestDeficit) { bestDeficit = deficit; best = d; }
    }
    return best;
}

/** stat-training row's start(): route to the gym for combat stats, the university
 *  for charisma/hacking. universityCourse/gymWorkout return false if unreachable
 *  (wrong city) — v1 accepts the failure and retries next tick rather than adding
 *  dedicated travel (mirrors the crime row's gymWorkout fallback pattern). */
function startTraining(ns, state) {
    const demand = nextTrainingDemand(ns, state);
    if (!demand) return;
    const sing = ns.singularity;
    const combat = COMBAT_SKILLS.find(([full]) => full === demand.stat);
    if (combat) { sing.gymWorkout(GYM_LOCATION, combat[1], false); return; }
    const course = UNIVERSITY_COURSE_BY_STAT[demand.stat];
    if (course) sing.universityCourse(UNIVERSITY_LOCATION, course, false);
}

/** stat-training row's maintain(): classes never end on their own (mirrors the gym
 *  branch of maintainCrime), so hand off whenever the player isn't actually in the
 *  class this row expects — either because the current demand's stat changed
 *  (a bigger deficit opened up elsewhere) or its buffer target was just met. */
function maintainTraining(ns, state, reassert) {
    const sing = ns.singularity;
    const demand = nextTrainingDemand(ns, state);
    if (!demand) { reassert(); return; } // met/gone — reassert lets the ladder re-pick
    const work = sing.getCurrentWork();
    if (!work || work.type !== "CLASS" || classToStat(work.classType) !== demand.stat) {
        reassert();
    }
}

/** ETA for the stat-training grind row (arbitration.md weighted-ETA amendment):
 *  gap-to-buffered-target ÷ empirical gain rate, in ms. null when no demand or no
 *  rate sample yet — pickWinner treats null as GRIND_ETA_SKIP_MS (eligible, not
 *  favored), same as faction-work's unknown-rep-rate case. */
function trainingEta(ns, state) {
    const demand = nextTrainingDemand(ns, state);
    if (!demand) return null;
    const rate = state.train?.rate;
    if (!rate) return null;
    const skills = ns.getPlayer().skills;
    const gap = demand.target * TRAIN_STAT_BUFFER - skills[demand.stat];
    return gap > 0 ? (gap / rate) * 1000 : 0;
}

/** Empirical stat-gain rate (units/sec), sampled the same way as updateRepEstimate:
 *  while pilot's own work is a CLASS at the gym/university, measure Δskill/Δt for
 *  whichever stat that class trains and keep the last positive estimate. */
function updateTrainRate(ns, snap, state) {
    const work = snap.currentWork;
    const now = Date.now();
    const stat = work?.type === "CLASS" ? classToStat(work.classType) : null;
    const t = state.train;
    if (stat) {
        const val = ns.getPlayer().skills[stat];
        if (t.lastStat === stat && t.lastVal !== null && t.lastTs !== null) {
            const dt = (now - t.lastTs) / 1000;
            if (dt > 0) {
                const rate = Math.max(0, val - t.lastVal) / dt;
                if (rate > 0) t.rate = rate;
            }
        }
        t.lastStat = stat; t.lastVal = val; t.lastTs = now;
    } else {
        t.lastStat = null; t.lastVal = null; t.lastTs = null;
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

/** faction-work row's maintain() — the ladder tracks rows by NAME, so when the
 *  effective target (snap.workTarget) moves to a DIFFERENT faction the winner is
 *  still "faction-work" and the row is never re-applied. Faction work is also
 *  continuous (isBusy stays true), so the generic idle re-assert never fires either.
 *  Detect the mismatch here: if the running faction/workType no longer matches the
 *  current workTarget (or the player is idle, e.g. after a donate tick), re-assert to
 *  switch to the new target. */
function maintainFactionWork(ns, snap, reassert) {
    const target = snap.workTarget;
    if (!target) return;
    const work = ns.singularity.getCurrentWork();
    if (!work || work.type !== "FACTION" ||
        work.factionName !== target.faction ||
        work.factionWorkType !== target.workType) {
        reassert();
    }
}

/** Smallest donation amount that closes a `repNeeded` reputation gap
 *  (docs/plans/donation-sizing.md). Exact via binary search against
 *  ns.formulas.reputation.repFromDonation when Formulas.exe is owned (donation rep
 *  isn't linear at the margins, so a closed-form guess can under/overshoot); else
 *  the closed-form inverse of the game's base donation formula
 *  (rep = amount * faction_rep_mult / 1e6). Caller multiplies the result by
 *  DONATE_SLOP to absorb rounding so one donation reliably closes the gap. */
function donationForRep(ns, repNeeded) {
    if (ns.fileExists("Formulas.exe", "home")) {
        try {
            const player = ns.getPlayer();
            let lo = 0;
            let hi = repNeeded * 1e6;
            // Grow hi until it's provably sufficient (repFromDonation is monotonic).
            for (let i = 0; i < 60 && ns.formulas.reputation.repFromDonation(hi, player) < repNeeded; i++) {
                hi *= 2;
            }
            for (let i = 0; i < 60; i++) {
                const mid = (lo + hi) / 2;
                if (ns.formulas.reputation.repFromDonation(mid, player) >= repNeeded) hi = mid;
                else lo = mid;
            }
            return hi;
        } catch { /* fall through to closed form */ }
    }
    return (repNeeded * 1e6) / ns.getPlayer().mults.faction_rep;
}

/** faction-work row's start(): work the effective target, sizing any donation to
 *  the CURRENT target's remaining rep gap (donation-sizing.md) instead of the old
 *  unbounded per-tick drip (snap.money * PILOT_SPEND_FRAC every tick regardless of
 *  how much rep was actually needed — which could keep donating long after the aug
 *  was already unlockable, or blow past what a huge gap needed in one shot). Sizing
 *  is still capped by PILOT_SPEND_FRAC per tick, so a huge gap closes over several
 *  ticks rather than a single giant donation; once the gap hits 0 this falls
 *  through to working (no more donations for a target that's already unlocked).
 *  NeuroFlux is bought with money at the reset dump, so DON'T donate for its rep —
 *  that would spend the very cash dumpNeuroflux needs (and NF rep is usually
 *  already ample); just work for the (free) rep. snap.money is already net of
 *  floor + reservations (wallet-reservations.md), so donations can never raid the
 *  acquirable-aug batch. */
function startFactionWork(ns, snap) {
    const target = snap.workTarget;
    if (!target) return false;
    const sing = ns.singularity;
    const favor = sing.getFactionFavor(target.faction);
    const donateThreshold = ns.getFavorToDonate ? ns.getFavorToDonate() : 150;
    if (target.aug !== PILOT_NEUROFLUX && favor >= donateThreshold) {
        const gap = Math.max(0, sing.getAugmentationRepReq(target.aug) - sing.getFactionRep(target.faction));
        if (gap > 0) {
            const amount = Math.min(snap.money * PILOT_SPEND_FRAC, donationForRep(ns, gap) * DONATE_SLOP);
            if (amount > 0) { sing.donateToFaction(target.faction, amount); return true; }
        }
        // gap already closed (e.g. rep grinding caught up) — fall through to working.
    }
    return sing.workForFaction(target.faction, target.workType, false);
}

/** Weighted-ETA grind selection (arbitration.md amendment, 2026-07-13). Walks the
 *  ladder in order; the first applicable GATE row wins outright (idle included —
 *  it's a gate, always applicable last). The first applicable GRIND row instead
 *  triggers a comparison across ALL applicable grind rows from that point on: each
 *  exposes eta() (ms, null = unknown), unknown treated as exactly GRIND_ETA_SKIP_MS
 *  (eligible, not favored). A grind whose raw ETA exceeds GRIND_ETA_SKIP_MS is
 *  excluded whenever at least one OTHER applicable grind is at/under the
 *  threshold (a days-long rep grind yields focus to a faster karma/training win);
 *  among the eligible set the winner is the lowest eta/GRIND_WEIGHTS[name] (ladder
 *  order breaks exact ties via the strict `<`). FOCUS_STABLE_TICKS hysteresis
 *  around whatever this returns is unchanged (applied by the caller, phaseWork). */
function pickWinner(rows, snap, state) {
    for (const r of rows) {
        if (!r.applicable(snap)) continue;
        if (r.cls !== "grind") return r; // first applicable gate wins outright
        const grinds = rows.filter((x) => x.cls === "grind" && x.applicable(snap));
        const rawEta = (x) => {
            const e = x.eta ? x.eta() : null;
            return e == null ? GRIND_ETA_SKIP_MS : e;
        };
        const anyFast = grinds.some((x) => rawEta(x) <= GRIND_ETA_SKIP_MS);
        const eligible = anyFast ? grinds.filter((x) => rawEta(x) <= GRIND_ETA_SKIP_MS) : grinds;
        let best = null;
        let bestEff = Infinity;
        for (const x of eligible) {
            const eff = rawEta(x) / (GRIND_WEIGHTS[x.name] ?? 1);
            if (eff < bestEff) { bestEff = eff; best = x; }
        }
        return best ?? r;
    }
    return rows[rows.length - 1];
}

/**
 * Runs the ladder each tick: pick the winning row via pickWinner() (gate rows
 * preempt absolutely in ladder order; among applicable grind rows the lowest
 * ETA/GRIND_WEIGHTS wins — arbitration.md's 2026-07-13 weighted-ETA amendment),
 * apply FOCUS_STABLE_TICKS hysteresis before actually switching away from the
 * currently-assigned row, then start/stop work accordingly. Never touches work
 * the PLAYER started manually — only replaces work pilot itself began (tracked
 * via the `pilotWorkSig` runtime flag), per the plan's manual-override rule.
 * Pilot also publishes the assigned row as the `focusOwner` flag so future
 * mechanic managers can see who owns the player (arbitration.md focus protocol).
 *
 * IMPORTANT: snap.workSource / snap.grindTarget below are computed exactly as
 * before pickWinner ever runs — lifecycle's plateau trigger reads workSource, and
 * a grind row OTHER than faction-work winning focus (e.g. stat-training) must not
 * change what that signal reports.
 */
function phaseWork(ns, snap, state) {
    updateRepEstimate(ns, snap, state);          // empirical rep-rate fallback
    updateTrainRate(ns, snap, state);            // empirical stat-gain rate (training row's ETA)
    // Priority-only target: published + drives lifecycle's plateau/install signal.
    snap.grindTarget = bestGrindTarget(ns, snap, state);
    // Effective work target the faction-work row grinds: priority first, else the
    // fallback (non-priority aug → NeuroFlux) so pilot never idles while rep remains.
    if (snap.grindTarget) {
        snap.workTarget = snap.grindTarget;
        snap.workSource = "priority";
    } else {
        snap.workTarget = fallbackGrindTarget(ns, snap, state);
        snap.workSource = snap.workTarget
            ? (snap.workTarget.aug === PILOT_NEUROFLUX ? "neuroflux" : "non-priority")
            : "none";
    }
    const rows = ladder(ns, snap, state);
    const winner = pickWinner(rows, snap, state);

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

// ── Debug logging ─────────────────────────────────────────────────────────────

/** One rolling debug line per tick capturing every input to pilot's grind/work
 *  decision, so "grinding X but nothing happening" and "why NF not a real aug" are
 *  diagnosable from the log alone. Uses only NS functions pilot already calls
 *  elsewhere → no static RAM increase. Gated by PILOT_DEBUG. */
function logTick(ns, snap, workState, state) {
    const sing = ns.singularity;
    const wt = snap.workTarget;
    const d = augDiag(ns, snap);

    // Reproduce startFactionWork's donate-vs-work branch (donation-sizing.md: sized
    // to the target's remaining rep gap, not an unbounded per-tick drip) so the log
    // shows which path the target faction takes and the actual sized amount.
    let tgt = "-", donate = "-", favor = "-", rep = "-", repReq = "-";
    if (wt) {
        tgt = `${wt.aug}@${wt.faction}`;
        favor = sing.getFactionFavor(wt.faction);
        rep = sing.getFactionRep(wt.faction);
        repReq = wt.aug === PILOT_NEUROFLUX ? "-" : Math.round(sing.getAugmentationRepReq(wt.aug));
        const willDonate = wt.aug !== PILOT_NEUROFLUX &&
            favor >= (ns.getFavorToDonate ? ns.getFavorToDonate() : 150);
        if (willDonate) {
            const gap = Math.max(0, sing.getAugmentationRepReq(wt.aug) - rep);
            donate = gap > 0
                ? `donate($${Math.round(Math.min(snap.money * PILOT_SPEND_FRAC, donationForRep(ns, gap) * DONATE_SLOP))})`
                : "work";
        } else {
            donate = "work";
        }
    }

    debugLog(ns, PILOT_DEBUG_LOG, {
        row: workState.focusOwner ?? "-",
        over: workState.overridden ? 1 : 0,
        busy: snap.isBusy ? 1 : 0,
        cur: describeWork(snap.currentWork) ?? "-",
        src: snap.workSource ?? "-",
        tgt,
        act: donate,
        favor,
        rep,
        repReq,
        prioGrind: snap.grindTarget ? `${snap.grindTarget.aug}@${snap.grindTarget.faction}` : "-",
        // aug inventory by tier × rep-state (locked = rep not met, unlk = rep met, unbought)
        pL: d.prioLocked, pU: d.prioUnlocked, rL: d.restLocked, rU: d.restUnlocked,
        readyNow: snap.acquirableNow ?? 0,
        income: state.income.ema ?? 0,
        moneyRaw: snap.moneyRaw,
        floor: snap.moneyFloor,
        money: snap.money,
        facs: snap.joinedFactions.length,
    });
}

/** Aug inventory counts for the debug log: over joined factions, how many augs
 *  (deduped, NeuroFlux/owned excluded) are priority vs rest × rep-locked vs rep-met.
 *  "restU > 0 while grinding NeuroFlux" is the smoking gun for "non-priority augs
 *  should be bought first". Reuses only already-charged NS functions. */
function augDiag(ns, snap) {
    const sing = ns.singularity;
    const owned = new Set(sing.getOwnedAugmentations(true));
    const met = new Map(); // aug -> rep-met at ANY joined faction
    const prio = new Map(); // aug -> is priority
    for (const faction of snap.joinedFactions) {
        const rep = sing.getFactionRep(faction);
        for (const aug of sing.getAugmentationsFromFaction(faction)) {
            if (aug === PILOT_NEUROFLUX || owned.has(aug)) continue;
            const isMet = rep >= sing.getAugmentationRepReq(aug);
            met.set(aug, (met.get(aug) ?? false) || isMet);
            prio.set(aug, PRIORITY_AUGS.has(aug));
        }
    }
    let prioLocked = 0, prioUnlocked = 0, restLocked = 0, restUnlocked = 0;
    for (const [aug, isMet] of met) {
        if (prio.get(aug)) isMet ? prioUnlocked++ : prioLocked++;
        else isMet ? restUnlocked++ : restLocked++;
    }
    return { prioLocked, prioUnlocked, restLocked, restUnlocked };
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
    const work = snap.workTarget;

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
            // Effective grind (priority target, else non-priority/NeuroFlux fallback) —
            // for display; lifecycle keys its plateau on grindTarget above, not this.
            workTarget: work ? { aug: work.aug, faction: work.faction, etaSec: Number.isFinite(work.eta) ? Math.round(work.eta) : null } : null,
        },
        nfAffordableLevels: snap.nfAffordableLevels ?? 0,
        incomePerSec: state.income.ema ?? 0,
        // Read by lifecycle.js (docs/plans/reset-lifecycle.md): how many priority augs
        // the reset batch could afford now (rep met AND money saved), + when that count
        // last grew — its install stagnation signal (stalls on money OR rep, whichever binds).
        acquirableNow: snap.acquirableNow ?? 0,
        lastAcquireTs: snap.lastAcquireTs ?? null,
        // Which grind tier pilot is on ("priority"/"non-priority"/"neuroflux"/"none") —
        // lifecycle's grindPending = still on a real-aug tier. And whether The Red Pill
        // is rep-met (→ lifecycle installs ASAP to claim it).
        workSource: snap.workSource ?? "none",
        redPillReady: snap.redPillReady ?? false,
        // wallet-reservations.md: money currently earmarked for the acquirable-aug
        // batch (0 in the NeuroFlux-only branch — NF is never reserved).
        reservedForAugs: snap.reservedForAugs ?? 0,
        // home-ram.md: current size, live next-upgrade cost (gated by
        // HOME_RAM_SPEND_FRAC), and how many upgrades this process has bought.
        homeRam: { gb: snap.homeRam, nextCost: snap.nextHomeRamCost ?? null, bought: state.homeRamBought ?? 0 },
        // faction-prereqs-training.md: per-faction unmet invite-requirement types for
        // every PLANNED_FACTIONS candidate still worth pursuing (may be []).
        factionPlans: state.plans?.byFaction ?? [],
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
    ns.print(`║ Home RAM: ${s.homeRam.gb.toFixed(0)}GB${s.homeRam.nextCost != null ? `  |  next $${Math.round(s.homeRam.nextCost).toLocaleString()}` : ""}  |  bought ${s.homeRam.bought}`);
    ns.print(`╠${"═".repeat(W)}`);
    ns.print(`║ Ladder: ${s.focusOwner ?? "—"}${s.working ? `  (${JSON.stringify(s.working)})` : ""}`);
    const grind = s.augs.workTarget ?? s.augs.grindTarget;
    if (grind) {
        const eta = Number.isFinite(grind.etaSec) ? `${(grind.etaSec / 60).toFixed(0)}m` : "∞";
        ns.print(`║ Grinding: ${grind.aug} @ ${grind.faction} (ETA ${eta})`);
    }
    if (s.cityTarget) {
        ns.print(`║ City faction target: ${s.cityTarget} (travel/join)`);
    }
    if (s.pendingInvites.length > 0) {
        ns.print(`║ ⚠ Pending invites (needs decision): ${s.pendingInvites.join(", ")}`);
    }
    ns.print(`╚${"═".repeat(W)}`);
}
