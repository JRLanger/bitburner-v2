/**
 * managers/gang.js — combat-gang manager (docs/plans/gang.md).
 *
 * Never-exit manager, status port 10. Two lives:
 *
 *   Formation (not in a gang yet): attempt createGang(GANG_FACTION) every tick —
 *   it returns false until the player is in the faction with enough karma, so no
 *   separate eligibility check is needed. Outside BN2 it publishes
 *   focusRequest {action:'karma-homicide', etaMs} so pilot's arbitration ladder
 *   (row 2) can lend player time to the karma grind; sleeves are the primary
 *   grinders. Progress-tolerant: the request stays published until inGang().
 *
 *   Running: RECRUIT → POWER → CLASH → DONE, recomputed from live API state
 *   every tick (nothing load-bearing is in-memory-only, so restarts and aug
 *   resets resume cleanly).
 *     RECRUIT  <12 members. Strongest earners on Terrorism (respect unlocks
 *              member slots — the biggest early lever), everyone else trains.
 *              No equipment purchases yet.
 *     POWER    full roster, clashes OFF, all earners on the Territory Warfare
 *              TASK — power (and hence win chance) grows ONLY from members
 *              assigned to it. Sequential arming: non-aug gear one member at a
 *              time, strongest first; armed members are ascension-locked.
 *     CLASH    entered when min win chance ≥ floor AND its growth has flattened
 *              (near the W_max ceiling) AND everyone is armed. Clashes ON,
 *              earners STAY on Territory Warfare (power keeps growing while NPC
 *              power decays per loss). Income ~0 here by design — status
 *              carries the phase so pilot doesn't read it as a fault. Sticky:
 *              only min win chance dropping below the floor reverts to POWER
 *              (and that clears the win history — stale CLASH samples read as
 *              falsely-flat growth).
 *     DONE     territory ≥ 0.99 — clashes off. Rep→money gate: earners work
 *              Terrorism until the faction's rep covers its highest aug
 *              requirement (faction rep accrues in proportion to respect), then
 *              switch to each member's best money task.
 *
 * Cross-phase: reactive vigilante hysteresis keeps wantedPenalty ≥ 0.95;
 * absolute-gain ascension (Δmult ≥ 0.70, not a ratio threshold); augs are
 * bought any time after RECRUIT (they survive ascension — the wipeable gear is
 * what needs the arming locks).
 *
 * See docs/scripts/gang.md (written with the implementation) for the full
 * rationale and docs/reference/advanced/gang-guide.md for the source-verified
 * mechanics this encodes.
 */

import {
    STATUS_PORT_GANG,
    GANG_FACTION,
    GANG_KARMA_REQ,
    GANG_TRAIN_THRESHOLD,
    GANG_WANTED_PENALTY_FLOOR,
    GANG_ASCEND_ABS_GAIN,
    GANG_AUG_SAFETY_MULT,
    GANG_EQUIP_BUDGET_FRAC,
    GANG_CLASH_MIN_CHANCE,
    GANG_CLASH_GROWTH_MIN,
    GANG_WIN_HISTORY_MS,
    GANG_TERRITORY_DONE,
    GANG_MAX_MEMBERS,
    GANG_RECRUIT_RESPECT_SLOTS,
    GANG_REP_TARGET_EXCLUDE,
    MECH_SPEND_FRAC,
} from "/config/constants.js";
import { publishStatus } from "/lib/status.js";
import { moneyFloor } from "/lib/flags.js";

/** Formation-loop poll interval, ms — used only before the gang exists, where
 *  there is no nextUpdate() to await. The running loop awaits ns.gang.nextUpdate()
 *  directly: racing it against a sleep is illegal (the losing Netscript async call
 *  keeps running and collides with the next tick's gang call). */
const FORMATION_POLL_MS = 5_000;

/** Combat tasks by role. Static names (stable game data) — getTaskNames() is
 *  only consulted for money-task scoring, where stats matter per member. */
const TASK_TRAIN = "Train Combat";
const TASK_RESPECT = "Terrorism";
const TASK_VIGILANTE = "Vigilante Justice";
const TASK_TERRITORY = "Territory Warfare";
const TASK_MONEY_FALLBACK = "Mug People";
const TASK_UNASSIGNED = "Unassigned";

export async function main(ns) {
    ns.disableLog("ALL");

    await formation(ns);

    // ── One-time setup (static for the life of the gang) ────────────────────
    const faction = ns.gang.getGangInformation().faction;

    // Equipment lists, cheapest first. Augs survive ascension (buy any time);
    // the rest is wiped by it (sequential arming). Rootkits are hack-only gear
    // — skipped entirely for a combat gang.
    const byCost = (a, b) => ns.gang.getEquipmentCost(a) - ns.gang.getEquipmentCost(b);
    const allEquip = ns.gang.getEquipmentNames().sort(byCost);
    const augEquip = allEquip.filter((e) => ns.gang.getEquipmentType(e) === "Augmentation");
    const gearEquip = allEquip.filter((e) => {
        const t = ns.gang.getEquipmentType(e);
        return t !== "Augmentation" && t !== "Rootkit";
    });

    // DONE-phase rep target: highest rep requirement among the faction's augs
    // (excluding repeatables and already-owned). Computed once — requirements
    // are fixed and an aug install restarts this script anyway.
    const owned = new Set(ns.singularity.getOwnedAugmentations(true));
    const exclude = new Set(GANG_REP_TARGET_EXCLUDE);
    const repTarget = Math.max(0, ...ns.singularity.getAugmentationsFromFaction(faction)
        .filter((a) => !exclude.has(a) && !owned.has(a))
        .map((a) => ns.singularity.getAugmentationRepReq(a)));

    // Money tasks scored per member from getTaskStats (see bestMoneyTask).
    const moneyTasks = ns.gang.getTaskNames()
        .map((t) => ns.gang.getTaskStats(t))
        .filter((s) => s.baseMoney > 0);

    // ── Per-run state (advisory only — safe to lose on restart) ─────────────
    const equipped = new Set(); // members whose non-aug arming is complete
    const winHistory = [];      // [{ts, v}] min-win-chance samples, GANG_WIN_HISTORY_MS window
    let vigilantes = 0;         // wanted-penalty hysteresis target
    let phase = null;

    while (true) {
        const gi = ns.gang.getGangInformation();
        const names = recruit(ns);
        const info = new Map(names.map((n) => [n, ns.gang.getMemberInformation(n)]));

        // A member the game killed in a clash must not linger in the arming set.
        for (const n of equipped) if (!info.has(n)) equipped.delete(n);

        // ── Clash state: min win chance over ALL rivals (clashes hit everyone) ──
        let minWin = 1;
        for (const g of Object.keys(ns.gang.getAllGangInformation())) {
            if (g === faction) continue;
            minWin = Math.min(minWin, ns.gang.getChanceToWinClash(g));
        }

        // Rolling growth window: flat growth means we're near the W_max ceiling
        // and further power-building yields little — time to engage.
        const now = Date.now();
        winHistory.push({ ts: now, v: minWin });
        while (winHistory.length > 1 && now - winHistory[0].ts > GANG_WIN_HISTORY_MS) winHistory.shift();
        const windowFull = now - winHistory[0].ts >= GANG_WIN_HISTORY_MS * 0.9;
        const growth = windowFull ? minWin - winHistory[0].v : Infinity;

        // ── Phase (recomputed from live state; CLASH is sticky) ─────────────
        const allArmed = names.length > 0 && names.every((n) => equipped.has(n));
        const prev = phase;
        phase = pickPhase(names.length, gi.territory, minWin, growth, allArmed, prev);
        if (prev === "CLASH" && phase === "POWER") {
            winHistory.length = 0; // stale CLASH samples read as falsely-flat growth
            equipped.clear();      // rivals grew — re-verify everyone's arming
            ns.print(`WARN: reverted CLASH→POWER (min win ${(minWin * 100).toFixed(1)}%)`);
        }

        // ── Rep→money gate (DONE phase only) ────────────────────────────────
        const factionRep = ns.singularity.getFactionRep(faction);
        const focus = phase !== "DONE" ? null : (factionRep >= repTarget ? "money" : "respect");

        // ── Ascension (absolute-gain rule + arming locks) ───────────────────
        const equipTarget = (phase === "POWER" || phase === "CLASH")
            ? [...names].sort((a, b) => combatAvg(info.get(b)) - combatAvg(info.get(a)))
                .find((n) => !equipped.has(n)) ?? null
            : null;
        const ascendLocked = (n) =>
            (phase === "POWER" && (equipped.has(n) || n === equipTarget)) ||
            (phase === "CLASH" && n === equipTarget);

        for (const n of names) {
            if (ascendLocked(n)) continue;
            const r = ns.gang.getAscensionResult(n);
            if (!r) continue;
            const ratio = (r.str + r.def + r.dex + r.agi) / 4; // new/old ratio, NOT the new value
            const m = info.get(n);
            const cur = (m.str_asc_mult + m.def_asc_mult + m.dex_asc_mult + m.agi_asc_mult) / 4;
            if ((ratio - 1) * cur < GANG_ASCEND_ABS_GAIN) continue;
            if (ns.gang.ascendMember(n)) {
                equipped.delete(n); // upgrades[] wiped — needs re-arming
                info.set(n, ns.gang.getMemberInformation(n));
                ns.print(`ascended ${n}: ×${ratio.toFixed(2)} (mult ${cur.toFixed(2)}→${(cur * ratio).toFixed(2)})`);
            }
        }

        // ── Equipment ───────────────────────────────────────────────────────
        if (phase !== "RECRUIT") buyEquipment(ns, phase, names, info, equipped, equipTarget, augEquip, gearEquip);

        // ── Wanted-penalty hysteresis ───────────────────────────────────────
        if (gi.wantedPenalty < GANG_WANTED_PENALTY_FLOOR && gi.wantedLevelGainRate > 0) {
            vigilantes = Math.min(vigilantes + 1, names.length);
        } else if (gi.wantedLevelGainRate <= 0 && vigilantes > 0) {
            vigilantes--;
        }

        // ── Task assignment ─────────────────────────────────────────────────
        assignTasks(ns, phase, focus, names, info, vigilantes, moneyTasks);
        ns.gang.setTerritoryWarfare(phase === "CLASH");

        // ── Status + tail ───────────────────────────────────────────────────
        const avgStats = names.length
            ? names.reduce((s, n) => s + combatAvg(info.get(n)), 0) / names.length : 0;
        // Short phase label for the dashboard row's header line (managerRow reads
        // snap.action). Adds the most relevant per-phase detail inline.
        const action = phase === "RECRUIT" ? `RECRUIT · ${names.length}/${GANG_MAX_MEMBERS}`
            : phase === "POWER" ? `POWER · win ${Math.round(minWin * 100)}%`
            : phase === "CLASH" ? `CLASH · win ${Math.round(minWin * 100)}%`
            : `DONE · ${focus}`;
        publishStatus(ns, STATUS_PORT_GANG, {
            ts: Date.now(),
            phase: phase.toLowerCase(),
            action,
            karmaNeeded: 0,
            members: names.length,
            avgStats: Math.round(avgStats),
            respect: gi.respect,
            wantedPenalty: gi.wantedPenalty,
            income: gi.moneyGainRate * 5, // moneyGainRate is per 200ms game cycle → ×5 for $/s
            territory: gi.territory,
            warfare: phase === "CLASH",
            minWinChance: minWin,
            focus,
            focusRequest: null,
        });
        render(ns, phase, gi, names, minWin, growth, windowFull, equipped, equipTarget, focus, factionRep, repTarget, vigilantes);

        await ns.gang.nextUpdate();
    }
}

// ── Formation ───────────────────────────────────────────────────────────────

/**
 * Loop until inGang(). createGang is attempted every tick (returns false until
 * faction membership + karma line up). Outside BN2, publish the karma
 * focusRequest with a measured-rate ETA so pilot's ladder row 2 can assist;
 * sleeve karma lands on the player total, so the measured rate already includes
 * their share.
 */
async function formation(ns) {
    if (ns.gang.inGang()) return;
    const inBn2 = ns.getResetInfo().currentNode === 2;
    let rate = 0; // karma/s EMA (karma falls, so rate > 0 means progress)
    let prevKarma = null, prevTs = Date.now();

    while (!ns.gang.inGang()) {
        if (ns.gang.createGang(GANG_FACTION)) break;

        const karma = ns.getPlayer().karma;
        const needed = inBn2 ? 0 : Math.max(0, karma - GANG_KARMA_REQ);
        const now = Date.now();
        if (prevKarma !== null && now > prevTs) {
            const r = (prevKarma - karma) / ((now - prevTs) / 1000);
            if (r > 0) rate = rate > 0 ? 0.3 * r + 0.7 * rate : r;
        }
        prevKarma = karma;
        prevTs = now;

        publishStatus(ns, STATUS_PORT_GANG, {
            ts: now,
            phase: "karma",
            action: inBn2 ? "forming · awaiting faction" : `forming · karma ${ns.format.number(needed)} left`,
            karmaNeeded: needed,
            members: 0,
            focus: null,
            focusRequest: needed > 0
                ? { action: "karma-homicide", etaMs: rate > 0 ? (needed / rate) * 1000 : Infinity }
                : null,
        });
        ns.print(inBn2
            ? `waiting to create gang with ${GANG_FACTION} (BN2 — join faction)`
            : `karma ${ns.format.number(karma)} / ${ns.format.number(GANG_KARMA_REQ)} (rate ${rate.toFixed(2)}/s)`);
        await ns.sleep(FORMATION_POLL_MS);
    }
    ns.print(`gang created with ${GANG_FACTION}`);
}

// ── Phase machine ───────────────────────────────────────────────────────────

/** RECRUIT → POWER → CLASH → DONE, from live state. CLASH is sticky above the
 *  win-chance floor; growth un-flattening alone never reverts it. */
function pickPhase(memberCount, territory, minWin, growth, allArmed, prev) {
    if (memberCount < GANG_MAX_MEMBERS) return "RECRUIT";
    if (territory >= GANG_TERRITORY_DONE) return "DONE";
    if (minWin < GANG_CLASH_MIN_CHANCE) return "POWER";
    if (prev === "CLASH") return "CLASH";
    return (growth < GANG_CLASH_GROWTH_MIN && allArmed) ? "CLASH" : "POWER";
}

// ── Members ─────────────────────────────────────────────────────────────────

/** Recruit into the lowest free g<N> slot (death-safe: the roster is re-derived
 *  from the API, so a killed member's name is simply reused). Returns the
 *  post-recruit roster. */
function recruit(ns) {
    let names = ns.gang.getMemberNames();
    while (ns.gang.canRecruitMember()) {
        const taken = new Set(names);
        let i = 0;
        while (taken.has(`g${i}`)) i++;
        if (!ns.gang.recruitMember(`g${i}`)) break;
        ns.gang.setMemberTask(`g${i}`, TASK_TRAIN);
        ns.print(`recruited g${i}`);
        names = ns.gang.getMemberNames();
    }
    return names;
}

/** Average of the four combat stats — readiness and arming-order metric. */
function combatAvg(m) {
    return (m.str + m.def + m.dex + m.agi) / 4;
}

/**
 * Best money task for a member, by expected rate: baseMoney × statWeight, with
 * statWeight = Σ(taskWeight/100 × stat) − 3.2 × difficulty (the engine's income
 * formula shape — territory/wanted multipliers are task-independent, so they
 * don't affect the ranking). Falls back to Mug People when nothing scores > 0.
 */
function bestMoneyTask(m, moneyTasks) {
    let best = TASK_MONEY_FALLBACK, bestScore = 0;
    for (const t of moneyTasks) {
        const statWeight =
            (t.hackWeight / 100) * m.hack + (t.strWeight / 100) * m.str +
            (t.defWeight / 100) * m.def + (t.dexWeight / 100) * m.dex +
            (t.agiWeight / 100) * m.agi + (t.chaWeight / 100) * m.cha -
            3.2 * t.difficulty;
        const score = t.baseMoney * statWeight;
        if (score > bestScore) { bestScore = score; best = t.name; }
    }
    return best;
}

// ── Equipment ───────────────────────────────────────────────────────────────

/**
 * Augs for everyone (survive ascension — no timing risk, gated on the 5× money
 * buffer). Non-aug gear for ONE member at a time (the equip target) in
 * POWER/CLASH, or for everyone in DONE. All purchases respect the shared
 * per-tick MECH_SPEND_FRAC cap, the per-purchase GANG_EQUIP_BUDGET_FRAC cap,
 * and lifecycle's moneyFloor reserve.
 */
function buyEquipment(ns, phase, names, info, equipped, equipTarget, augEquip, gearEquip) {
    const money0 = ns.getServerMoneyAvailable("home");
    const tickCap = money0 * MECH_SPEND_FRAC;
    let spent = 0;

    const canSpend = (cost) =>
        spent + cost <= tickCap &&
        cost <= money0 * GANG_EQUIP_BUDGET_FRAC &&
        ns.getServerMoneyAvailable("home") - cost >= moneyFloor(ns);

    const buy = (n, eq, extraGate = true) => {
        const have = new Set([...info.get(n).upgrades, ...info.get(n).augmentations]);
        if (have.has(eq)) return false;
        const cost = ns.gang.getEquipmentCost(eq);
        if (!extraGate || !canSpend(cost)) return false;
        if (!ns.gang.purchaseEquipment(n, eq)) return false;
        spent += cost;
        info.set(n, ns.gang.getMemberInformation(n));
        ns.print(`bought ${eq} → ${n}`);
        return true;
    };

    for (const n of names) {
        for (const eq of augEquip) {
            buy(n, eq, ns.getServerMoneyAvailable("home") >= ns.gang.getEquipmentCost(eq) * GANG_AUG_SAFETY_MULT);
        }
    }

    if ((phase === "POWER" || phase === "CLASH") && equipTarget !== null) {
        for (const eq of gearEquip) buy(equipTarget, eq);
        const have = new Set([...info.get(equipTarget).upgrades, ...info.get(equipTarget).augmentations]);
        if (gearEquip.every((eq) => have.has(eq))) {
            equipped.add(equipTarget);
            ns.print(`${equipTarget} fully armed`);
        }
    }

    if (phase === "DONE") {
        for (const n of names) for (const eq of gearEquip) buy(n, eq);
    }
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Assign every member's task for this tick, by phase. Members are split into
 * trainees (< GANG_TRAIN_THRESHOLD avg combat) and earners; earners are sorted
 * weakest-first so vigilante duty (and money in DONE) lands on the weakest
 * while the strongest carry respect/territory.
 */
function assignTasks(ns, phase, focus, names, info, vigilantes, moneyTasks) {
    const set = (n, task) => {
        if (info.get(n).task !== task) ns.gang.setMemberTask(n, task);
    };
    const sorted = [...names].sort((a, b) => combatAvg(info.get(a)) - combatAvg(info.get(b)));
    const trainees = sorted.filter((n) => combatAvg(info.get(n)) < GANG_TRAIN_THRESHOLD);
    const earners = sorted.filter((n) => combatAvg(info.get(n)) >= GANG_TRAIN_THRESHOLD);
    for (const n of trainees) set(n, TASK_TRAIN);

    const vigil = Math.min(vigilantes, earners.length);

    // RECRUIT respect slots go to a STABLE set — the oldest members (lowest g<N>
    // index) among the non-vigilante earners — not the live-strongest. Terrorism
    // grants far less combat XP than training, so a rank-based pick would reshuffle
    // every tick (the Terrorism member falls behind, a trainee overtakes it) and
    // flap tasks; oldest≈strongest anyway, so this costs almost no respect rate.
    const idx = (n) => parseInt(n.slice(1), 10) || 0;
    const respectSet = phase !== "RECRUIT" ? null : new Set(
        earners.slice(vigil).sort((a, b) => idx(a) - idx(b)).slice(0, GANG_RECRUIT_RESPECT_SLOTS));

    for (let i = 0; i < earners.length; i++) {
        const n = earners[i];
        if (i < vigil) { set(n, TASK_VIGILANTE); continue; }
        if (phase === "RECRUIT") {
            set(n, respectSet.has(n) ? TASK_RESPECT : TASK_TRAIN);
        } else if (phase === "POWER" || phase === "CLASH") {
            set(n, TASK_TERRITORY);
        } else { // DONE
            set(n, focus === "respect" ? TASK_RESPECT : bestMoneyTask(info.get(n), moneyTasks));
        }
    }
}

// ── Tail display ────────────────────────────────────────────────────────────

function render(ns, phase, gi, names, minWin, growth, windowFull, equipped, equipTarget, focus, factionRep, repTarget, vigilantes) {
    const pct = (v) => (v * 100).toFixed(1) + "%";
    ns.clearLog();
    ns.print(`gang ${gi.faction} | ${phase} | ${names.length}/${GANG_MAX_MEMBERS} members | vigil ${vigilantes}`);
    ns.print(`  $${ns.format.number(gi.moneyGainRate * 5)}/s  respect ${ns.format.number(gi.respect)}  ` +
        `wanted ${pct(gi.wantedPenalty)}  territory ${pct(gi.territory)}  power ${ns.format.number(gi.power)}`);
    if (phase === "POWER") {
        const g = windowFull ? `Δwin ${(growth * 100).toFixed(3)}% (need <${(GANG_CLASH_GROWTH_MIN * 100).toFixed(1)}%)` : "Δwin measuring…";
        ns.print(`  min win ${pct(minWin)} (floor ${pct(GANG_CLASH_MIN_CHANCE)})  ${g}  armed ${equipped.size}/${names.length}` +
            (equipTarget ? `  arming ${equipTarget}` : ""));
    } else if (phase === "CLASH") {
        ns.print(`  CLASHING — min win ${pct(minWin)}; income paused by design` +
            (equipTarget ? `  re-arming ${equipTarget}` : ""));
    } else if (phase === "DONE") {
        ns.print(focus === "respect"
            ? `  focus respect — faction rep ${ns.format.number(factionRep)}/${ns.format.number(repTarget)}`
            : `  focus money — rep target met`);
    }
    for (const n of ns.gang.getMemberNames()) {
        const m = ns.gang.getMemberInformation(n);
        ns.print(`  ${n.padEnd(5)} ${m.task.padEnd(20)} avg ${String(Math.floor(combatAvg(m))).padStart(5)}`);
    }
}
