# Sleeves Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sleeves` manager that assigns each duplicate sleeve its highest-value task every tick (sync → shock → karma → faction → gym → crime), buys sleeves/memory/augs under the shared spend cap, and logs machine-checkable evidence to `/data/sleeve-log.txt`.

**Architecture:** One long-running manager (`src/managers/sleeves.js`) launched by booster like the other managers. The task-selection logic is a **pure function** (`chooseTask`) with no `ns` dependency, so it is unit-tested by an in-game self-test script (this project has no node test runner — verification is in-game runs + `/data/*.txt` logs, following the `src/dev/validate-model.js` pattern). The `ns` wiring (assignment, spending, status, logging) is verified in-game via the rolling log.

**Tech Stack:** Bitburner Netscript v3.0.1, ES modules with Bitburner-absolute imports (`/lib/...`, `/config/...`). No new dependencies.

## Global Constraints

- **Target Netscript v3.0.1** — every `ns.sleeve.*` name in this plan is verified against `docs/reference/NetscriptDefinitions.d.ts`. Do not substitute from memory.
- **RAM model:** RAM is charged per distinct `ns` function referenced, NOT per call. Tick rate never saves RAM. `ns.read`/`ns.write`/port ops are 0-GB. Never add an `ns.sleeve.*` call purely to log.
- **Import style:** Bitburner-absolute (`import { X } from "/config/constants.js"`). Match existing managers.
- **One task change per sleeve per tick**; skip reassignment when the current task already matches the target (thrash guard).
- **Spend cap:** all purchases share the per-tick `MECH_SPEND_FRAC` (0.25) fraction-of-money cap, mirroring `gang.js` (`tickCap = money * MECH_SPEND_FRAC`).
- **Verified enum strings:** CrimeType `"Homicide"`/`"Heist"`; FactionWorkType `"hacking"`/`"field"`/`"security"`; GymType `"str"`/`"def"`/`"dex"`/`"agi"`; gym `"Powerhouse Gym"` in city `"Sector-12"`. Sleeve stats live on `sleeve.skills.{strength,defense,dexterity,agility,hacking,charisma}`; trauma/align on `sleeve.shock`/`sleeve.sync`.

---

### Task 1: Constants

**Files:**
- Modify: `src/config/constants.js` (add sleeve block near the other `STATUS_PORT_*` / manager-path exports; append the new constants in the arbitration/mechanic section)

**Interfaces:**
- Produces: `STATUS_PORT_SLEEVES`, `SLEEVE_LOOP_SLEEP`, `SLEEVE_SHOCK_MAX`, `SLEEVE_SYNC_MIN`, `SLEEVE_STAT_FLOOR`, `SLEEVE_DEBUG`, `SLEEVE_DEBUG_LOG`, `SLEEVE_MANAGER`.

- [ ] **Step 1: Add the manager path constant**

Next to the other `_MANAGER` exports (near line 352-356):

```js
export const SLEEVE_MANAGER = "/managers/sleeves.js";
```

- [ ] **Step 2: Add the status port constant**

Next to the other `STATUS_PORT_*` exports (port 11 is free; 10 is gang):

```js
export const STATUS_PORT_SLEEVES = 11;
```

- [ ] **Step 3: Add the sleeve tuning + logging constants**

In the mechanic/arbitration section (after `MECH_SPEND_FRAC`):

```js
// ── sleeves (docs/superpowers/specs/2026-08-01-sleeves-design.md) ────────────
export const SLEEVE_LOOP_SLEEP = 20_000;   // fixed tick; no nextUpdate() in this API. Tick rate never saves RAM.
export const SLEEVE_SHOCK_MAX = 90;        // only actively recover when shock is high; low shock decays passively
export const SLEEVE_SYNC_MIN = 95;         // sync scales exp transfer linearly (sync/100) — keep near max
export const SLEEVE_STAT_FLOOR = 100;      // gym any combat stat below this
export const SLEEVE_DEBUG = true;          // gate for the rolling debug log
export const SLEEVE_DEBUG_LOG = "/data/sleeve-log.txt";
```

- [ ] **Step 4: Commit**

```bash
git add src/config/constants.js
git commit -m "feat(sleeves): add constants, status port, manager path"
```

---

### Task 2: Pure decision core + in-game self-test

This is the unit-tested heart of the manager. All four exports are pure (no `ns`), so the self-test can assert their behavior deterministically.

**Files:**
- Create: `src/managers/sleeves.js` (only the pure helpers in this task; `main` comes in Task 3)
- Create: `src/dev/sleeve-selftest.js` (in-game assert runner, mirrors `src/dev/validate-model.js`)

**Interfaces:**
- Produces:
  - `GYM_STAT` — `{ strength:"str", defense:"def", dexterity:"dex", agility:"agi" }`
  - `lowestCombatStat(skills)` → `{ stat: string, val: number }` (min over the 4 combat stats; ties resolve to the earliest in strength→defense→dexterity→agility order)
  - `chooseTask(sleeve, ctx)` → decision object `{ row, crime?, faction?, stat? }` where `row ∈ {"sync","recovery","karma","faction","gym","crime"}`. `ctx = { gangKarmaPhase: boolean, pilotFaction: string|null, claimedFactions: Set<string> }`.
  - `matchesCurrent(task, decision)` → boolean (true when the sleeve's current `getTask()` result already satisfies the decision)

- [ ] **Step 1: Write the failing self-test**

Create `src/dev/sleeve-selftest.js`:

```js
/**
 * sleeve-selftest.js — in-game unit test for the pure sleeve decision core.
 * Run: run /dev/sleeve-selftest.js
 * Prints PASS/FAIL per case to the terminal and appends to the log file.
 * (This project has no node test runner; this is the validate-model.js pattern.)
 */
import { chooseTask, lowestCombatStat, matchesCurrent, GYM_STAT } from "/managers/sleeves.js";
import { SLEEVE_SYNC_MIN, SLEEVE_SHOCK_MAX, SLEEVE_STAT_FLOOR } from "/config/constants.js";

const LOG = "/data/sleeve-selftest.txt";

export async function main(ns) {
    let pass = 0, fail = 0;
    const check = (name, cond) => {
        const line = `${cond ? "PASS" : "FAIL"} ${name}`;
        ns.tprint(line);
        ns.write(LOG, line + "\n", "a");
        cond ? pass++ : fail++;
    };

    // Build a sleeve with all combat stats high enough to pass the gym floor by default.
    const S = (over = {}) => ({
        sync: 100, shock: 0,
        skills: { strength: 200, defense: 200, dexterity: 200, agility: 200, hacking: 200, charisma: 200 },
        ...over,
    });
    const ctx = (over = {}) => ({ gangKarmaPhase: false, pilotFaction: null, claimedFactions: new Set(), ...over });

    // lowestCombatStat
    const low = lowestCombatStat({ strength: 10, defense: 50, dexterity: 30, agility: 40 });
    check("lowestCombatStat picks min", low.stat === "strength" && low.val === 10);

    // Ladder priority
    check("row1 sync when sync low",
        chooseTask(S({ sync: SLEEVE_SYNC_MIN - 1 }), ctx()).row === "sync");
    check("row2 recovery when shock high",
        chooseTask(S({ shock: SLEEVE_SHOCK_MAX + 1 }), ctx()).row === "recovery");
    check("sync beats recovery",
        chooseTask(S({ sync: 1, shock: 99 }), ctx()).row === "sync");
    check("row3 karma homicide",
        (() => { const d = chooseTask(S(), ctx({ gangKarmaPhase: true })); return d.row === "karma" && d.crime === "Homicide"; })());
    check("row4 faction when pilot working unclaimed",
        (() => { const d = chooseTask(S(), ctx({ pilotFaction: "Illuminati" })); return d.row === "faction" && d.faction === "Illuminati"; })());
    check("row4 falls through when faction already claimed",
        chooseTask(S(), ctx({ pilotFaction: "Illuminati", claimedFactions: new Set(["Illuminati"]) })).row === "crime");
    check("karma beats faction",
        chooseTask(S(), ctx({ gangKarmaPhase: true, pilotFaction: "Illuminati" })).row === "karma");
    check("row5 gym when a combat stat below floor",
        (() => { const d = chooseTask(S({ skills: { strength: SLEEVE_STAT_FLOOR - 1, defense: 200, dexterity: 200, agility: 200, hacking: 200, charisma: 200 } }), ctx()); return d.row === "gym" && d.stat === "strength"; })());
    check("row6 crime heist fallback",
        (() => { const d = chooseTask(S(), ctx()); return d.row === "crime" && d.crime === "Heist"; })());

    // matchesCurrent (thrash guard)
    check("matchesCurrent sync", matchesCurrent({ type: "SYNCHRO" }, { row: "sync" }) === true);
    check("matchesCurrent recovery", matchesCurrent({ type: "RECOVERY" }, { row: "recovery" }) === true);
    check("matchesCurrent crime same crime",
        matchesCurrent({ type: "CRIME", crimeType: "Heist" }, { row: "crime", crime: "Heist" }) === true);
    check("matchesCurrent crime diff crime false",
        matchesCurrent({ type: "CRIME", crimeType: "Mug" }, { row: "crime", crime: "Heist" }) === false);
    check("matchesCurrent faction same faction",
        matchesCurrent({ type: "FACTION", factionName: "Illuminati" }, { row: "faction", faction: "Illuminati" }) === true);
    check("matchesCurrent gym same stat",
        matchesCurrent({ type: "CLASS", classType: "str" }, { row: "gym", stat: "strength" }) === true);
    check("matchesCurrent null task false", matchesCurrent(null, { row: "sync" }) === false);

    ns.tprint(`\n=== ${pass} passed, ${fail} failed ===`);
}
```

- [ ] **Step 2: Run the self-test to verify it fails**

In-game terminal:

```
run /dev/sleeve-selftest.js
```

Expected: the script errors on import (`chooseTask` / `lowestCombatStat` / `matchesCurrent` / `GYM_STAT` not exported from `/managers/sleeves.js` — the file doesn't exist yet). This confirms the test is wired to the real module.

- [ ] **Step 3: Implement the pure core**

Create `src/managers/sleeves.js` with the header comment and the pure helpers (no `ns` yet):

```js
/**
 * managers/sleeves.js — duplicate-sleeve manager.
 *
 * Design: docs/superpowers/specs/2026-08-01-sleeves-design.md.
 * Each tick, assign every sleeve its highest-value task via the pure `chooseTask`
 * ladder, buy sleeves/memory/augs under the shared MECH_SPEND_FRAC cap, and log
 * machine-checkable evidence to SLEEVE_DEBUG_LOG. Sleeves run in parallel and never
 * contend for player focus — the only cross-sleeve rule is one sleeve per faction.
 */
import {
    STATUS_PORT_SLEEVES, SLEEVE_LOOP_SLEEP, SLEEVE_SHOCK_MAX, SLEEVE_SYNC_MIN,
    SLEEVE_STAT_FLOOR, SLEEVE_DEBUG, SLEEVE_DEBUG_LOG, MECH_SPEND_FRAC,
} from "/config/constants.js";
import { publishStatus, readStatus } from "/lib/status.js";
import { debugLog } from "/lib/debug-log.js";
import { STATUS_PORT_GANG, STATUS_PORT_PILOT } from "/config/constants.js";

/** stat name (as on sleeve.skills) → GymType enum the API wants. */
export const GYM_STAT = { strength: "str", defense: "def", dexterity: "dex", agility: "agi" };

const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];

/** Lowest of the four combat stats. Ties resolve to the earliest in COMBAT_STATS order. */
export function lowestCombatStat(skills) {
    let stat = COMBAT_STATS[0], val = skills[stat];
    for (const s of COMBAT_STATS) {
        if (skills[s] < val) { stat = s; val = skills[s]; }
    }
    return { stat, val };
}

/**
 * Pure task selection for one sleeve. First applicable row wins.
 * ctx = { gangKarmaPhase, pilotFaction, claimedFactions:Set }.
 * Returns { row, crime?, faction?, stat? }.
 */
export function chooseTask(sleeve, ctx) {
    if (sleeve.sync < SLEEVE_SYNC_MIN) return { row: "sync" };
    if (sleeve.shock > SLEEVE_SHOCK_MAX) return { row: "recovery" };
    if (ctx.gangKarmaPhase) return { row: "karma", crime: "Homicide" };
    if (ctx.pilotFaction && !ctx.claimedFactions.has(ctx.pilotFaction)) {
        return { row: "faction", faction: ctx.pilotFaction };
    }
    const low = lowestCombatStat(sleeve.skills);
    if (low.val < SLEEVE_STAT_FLOOR) return { row: "gym", stat: low.stat };
    return { row: "crime", crime: "Heist" };
}

/** True when the sleeve's current getTask() result already satisfies `decision`
 *  (thrash guard — skip reassignment, which would reset task progress). */
export function matchesCurrent(task, decision) {
    if (!task) return false;
    switch (decision.row) {
        case "sync": return task.type === "SYNCHRO";
        case "recovery": return task.type === "RECOVERY";
        case "karma":
        case "crime": return task.type === "CRIME" && task.crimeType === decision.crime;
        case "faction": return task.type === "FACTION" && task.factionName === decision.faction;
        case "gym": return task.type === "CLASS" && task.classType === GYM_STAT[decision.stat];
        default: return false;
    }
}
```

Note: the `STATUS_PORT_*`/`publishStatus`/`debugLog` imports are unused until Task 3 — that's fine, they're referenced there. (If your linter fails the build on unused imports, add them in Task 3 instead; this codebase does not.)

- [ ] **Step 4: Run the self-test to verify it passes**

```
run /dev/sleeve-selftest.js
```

Expected: every line `PASS`, final `=== 17 passed, 0 failed ===`. If any FAIL, fix `chooseTask`/`lowestCombatStat`/`matchesCurrent` and rerun. Then read `/data/sleeve-selftest.txt` to confirm the run was recorded.

- [ ] **Step 5: Commit**

```bash
git add src/managers/sleeves.js src/dev/sleeve-selftest.js
git commit -m "feat(sleeves): pure task-selection core + in-game self-test"
```

---

### Task 3: Manager loop — assignment, status, logging

Wire the pure core to `ns`: gather cross-manager context, assign each sleeve with fallthrough + one-per-faction claim + thrash guard, publish status, log.

**Files:**
- Modify: `src/managers/sleeves.js` (add `main`, `applyTask`, `gatherContext`, `log`, and the tick loop)

**Interfaces:**
- Consumes: `chooseTask`, `matchesCurrent`, `GYM_STAT` (Task 2); `readStatus`/`publishStatus` (`/lib/status.js`); `debugLog` (`/lib/debug-log.js`); gang status field `phase` (port 10, `"karma"` while forming); pilot status fields `working` (bool) and `augs.workTarget.faction` (port 7).
- Produces: a running manager publishing to `STATUS_PORT_SLEEVES` and appending to `SLEEVE_DEBUG_LOG`.

- [ ] **Step 1: Add the log helper and the apply function**

Append to `src/managers/sleeves.js`:

```js
/** Append one sleeve debug line, gated on SLEEVE_DEBUG. read/write are 0-GB — no added RAM. */
function log(ns, fields) { if (SLEEVE_DEBUG) debugLog(ns, SLEEVE_DEBUG_LOG, fields); }

/** Apply a decision to sleeve i. Returns truthy on success (treat undefined as failure).
 *  Faction work tries each work type until one is accepted (setToFactionWork returns
 *  undefined when the faction doesn't offer that type). */
function applyTask(ns, i, d) {
    switch (d.row) {
        case "sync": return ns.sleeve.setToSynchronize(i);
        case "recovery": return ns.sleeve.setToShockRecovery(i);
        case "karma":
        case "crime": return ns.sleeve.setToCommitCrime(i, d.crime);
        case "faction":
            for (const wt of ["field", "hacking", "security"]) {
                if (ns.sleeve.setToFactionWork(i, d.faction, wt)) return true;
            }
            return false;
        case "gym":
            ns.sleeve.travel(i, "Sector-12");
            return ns.sleeve.setToGymWorkout(i, "Powerhouse Gym", GYM_STAT[d.stat]);
        default: return false;
    }
}
```

- [ ] **Step 2: Add the context gatherer**

```js
/** Read cross-manager signals once per tick (peek — non-consuming). */
function gatherContext(ns) {
    const gang = readStatus(ns, STATUS_PORT_GANG);
    const pilot = readStatus(ns, STATUS_PORT_PILOT);
    const pilotFaction = (pilot && pilot.working) ? (pilot.augs?.workTarget?.faction ?? null) : null;
    return {
        gangKarmaPhase: gang?.phase === "karma",
        pilotFaction,
    };
}
```

- [ ] **Step 3: Add `main` with the assignment loop**

```js
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("sleeves manager started");

    let spentThisRun = 0; // carried across ticks; Task 4 increments it

    while (true) {
        const n = ns.sleeve.getNumSleeves();
        if (n === 0) { await ns.sleep(SLEEVE_LOOP_SLEEP); continue; } // gate races: nothing to do

        const base = gatherContext(ns);
        const claimedFactions = new Set();
        const counts = { sync: 0, recovery: 0, karma: 0, faction: 0, gym: 0, crime: 0 };
        let shockSum = 0, syncSum = 0;

        for (let i = 0; i < n; i++) {
            const sleeve = ns.sleeve.getSleeve(i);
            shockSum += sleeve.shock; syncSum += sleeve.sync;

            const ctx = { ...base, claimedFactions };
            let d = chooseTask(sleeve, ctx);

            // Assign; on falsy return, fall through by re-choosing with this faction
            // treated as claimed (so a failed faction row can't be re-picked forever).
            const current = ns.sleeve.getTask(i);
            if (matchesCurrent(current, d)) {                 // thrash guard: no-op
                if (d.row === "faction") claimedFactions.add(d.faction);
                counts[d.row]++;
                continue;
            }
            let ok = applyTask(ns, i, d);
            if (!ok && d.row === "faction") {                 // faction failed → retry below it
                claimedFactions.add(d.faction);               // block re-pick this tick
                log(ns, { ev: "claim", sleeve: i, faction: d.faction, ok: false });
                d = chooseTask(sleeve, { ...base, claimedFactions });
                ok = applyTask(ns, i, d);
            }
            if (d.row === "faction" && ok) {
                claimedFactions.add(d.faction);
                log(ns, { ev: "claim", sleeve: i, faction: d.faction, ok: true });
            }
            counts[d.row]++;
            log(ns, { ev: "assign", sleeve: i, from: current?.type ?? "-", to: d.row,
                      reason: d.faction ?? d.crime ?? d.stat ?? d.row, ok: !!ok });
        }

        // spendTick(ns) — added in Task 4

        publishStatus(ns, STATUS_PORT_SLEEVES, {
            ts: Date.now(),
            count: n,
            avgShock: Math.round(shockSum / n),
            avgSync: Math.round(syncSum / n),
            tasks: counts,
            spentThisRun: Math.round(spentThisRun),
        });
        log(ns, { ev: "tick", count: n, avgShock: Math.round(shockSum / n),
                  avgSync: Math.round(syncSum / n), ...counts, spentThisRun: Math.round(spentThisRun) });

        await ns.sleep(SLEEVE_LOOP_SLEEP);
    }
}
```

- [ ] **Step 4: Verify in-game (manual launch)**

In-game terminal, launch directly (booster wiring is Task 5):

```
run /managers/sleeves.js
```

Wait ~1 minute (3 ticks), then read the log:

```
nano /data/sleeve-log.txt
```

Expected assertions (Claude reads the file and checks):
- One `ev=tick` line per ~20s, with `count` = your sleeve count and row counts summing to `count`.
- Sleeves with `shock>90` show `ev=assign to=recovery`; once shock decays they flip to a lower row.
- If pilot is working a faction: exactly one `ev=claim ok=true` for it per tick; a second sleeve wanting it shows `ok=false` then an `ev=assign` to `gym`/`crime`.
- On a steady tick where nothing changed, there are **no** `ev=assign` lines (only `ev=tick`) — proves the thrash guard.

- [ ] **Step 5: Commit**

```bash
git add src/managers/sleeves.js
git commit -m "feat(sleeves): tick loop — assignment, faction claim, status, logging"
```

---

### Task 4: Spending — buy sleeves, memory, augs

Add the capex path under the shared per-tick cap.

**Files:**
- Modify: `src/managers/sleeves.js` (add `spendTick`, call it from the loop, feed `spentThisRun`)

**Interfaces:**
- Consumes: `MECH_SPEND_FRAC`; `ns.sleeve.getSleeveCost`/`purchaseSleeve`/`getMemoryUpgradeCost`/`upgradeMemory`/`getSleevePurchasableAugs`/`purchaseSleeveAug`/`getSleeve`.
- Produces: increments the loop's `spentThisRun`; emits `ev=buy` log lines.

- [ ] **Step 1: Add `spendTick`**

```js
/** Spend under the shared per-tick MECH_SPEND_FRAC cap. Returns money spent this tick.
 *  Order: buy a sleeve (BN10) → cheapest memory upgrade → cheapest affordable augs.
 *  Cheapest-first so a big-ticket item can't starve several small wins. */
function spendTick(ns) {
    const n = ns.sleeve.getNumSleeves();
    let budget = ns.getServerMoneyAvailable("home") * MECH_SPEND_FRAC;
    let spent = 0;
    const buy = (kind, sleeve, cost, doBuy) => {
        if (cost > budget || !doBuy()) return false;
        budget -= cost; spent += cost;
        log(ns, { ev: "buy", kind, sleeve, cost: Math.round(cost), spentTick: Math.round(spent) });
        return true;
    };

    // 1) Buy a new sleeve (BN10 only; returns false/throws-free otherwise).
    const sleeveCost = ns.sleeve.getSleeveCost();
    if (Number.isFinite(sleeveCost)) buy("sleeve", "-", sleeveCost, () => ns.sleeve.purchaseSleeve());

    // 2) Cheapest single memory upgrade across all sleeves.
    let memBest = null;
    for (let i = 0; i < n; i++) {
        const c = ns.sleeve.getMemoryUpgradeCost(i, 1);
        if (Number.isFinite(c) && (!memBest || c < memBest.c)) memBest = { i, c };
    }
    if (memBest) buy("memory", memBest.i, memBest.c, () => ns.sleeve.upgradeMemory(memBest.i, 1));

    // 3) Cheapest affordable aug across sleeves at shock 0 (batch happens naturally
    //    over ticks — one purchase per tick keeps within the cap and re-reads prices).
    let augBest = null;
    for (let i = 0; i < n; i++) {
        if (ns.sleeve.getSleeve(i).shock !== 0) continue;
        for (const a of ns.sleeve.getSleevePurchasableAugs(i)) {
            if (!augBest || a.cost < augBest.cost) augBest = { i, name: a.name, cost: a.cost };
        }
    }
    if (augBest) buy("aug", augBest.i, augBest.cost, () => ns.sleeve.purchaseSleeveAug(augBest.i, augBest.name));

    return spent;
}
```

Note: `getSleevePurchasableAugs(i)` returns objects with `.name` and `.cost` (verify against `docs/reference/NetscriptDefinitions.d.ts` for the exact field names before running; adjust if the defs name them differently).

- [ ] **Step 2: Wire it into the loop**

Replace the `// spendTick(ns) — added in Task 4` comment in `main` with:

```js
        spentThisRun += spendTick(ns);
```

- [ ] **Step 3: Verify in-game**

Restart the manager (`kill /managers/sleeves.js` then `run /managers/sleeves.js`) with money above the cap. After a few ticks read `/data/sleeve-log.txt`:
- `ev=buy` lines appear with `kind=sleeve|memory|aug`.
- No single tick's summed `spentTick` exceeds `0.25 × money` at tick start.
- `ev=tick spentThisRun=` grows monotonically as buys accumulate.
- After an `ev=buy kind=aug`, that sleeve's next `ev=assign` is often `sync`/`recovery`/`gym` (stats reset to 0 on aug purchase) — expected.

- [ ] **Step 4: Commit**

```bash
git add src/managers/sleeves.js
git commit -m "feat(sleeves): capex — buy sleeves, memory, augs under shared cap"
```

---

### Task 5: Wire into booster + dashboard

Make booster auto-launch the manager and the dashboard show it.

**Files:**
- Modify: `src/booster.js` (import `SLEEVE_MANAGER`, add `sleeveGate`, add entry to `MANAGERS`)
- Modify: `src/dashboard.js` (import `STATUS_PORT_SLEEVES`, read it, render a compact row)

**Interfaces:**
- Consumes: `SLEEVE_MANAGER`, `STATUS_PORT_SLEEVES`; the status object shape from Task 3.
- Produces: booster launches the manager once SF10 is present; dashboard shows a sleeves line.

- [ ] **Step 1: Add the gate and registry entry in booster**

Import `SLEEVE_MANAGER` alongside the other `_MANAGER` imports. Add the gate next to `gangGate`/`pilotGate`:

```js
function sleeveGate(servers, ns) {
    const info = ns.getResetInfo();
    return (info.ownedSF.get(10) ?? 0) > 0 || info.currentNode === 10;
}
```

Gate on SF10 only (cheap, `getResetInfo` is already used by the other gates). The manager self-checks `getNumSleeves() === 0` and idles, so no extra `ns.sleeve.*` RAM is added to booster.

Add to the `MANAGERS` array (order: after gang, alongside the other mechanic managers):

```js
    { file: SLEEVE_MANAGER, gate: sleeveGate },
```

- [ ] **Step 2: Verify booster launches it**

If you're in a BitNode with SF10/sleeves, restart booster (or wait a tick) and confirm:

```
ps home
```

Expected: `/managers/sleeves.js` appears in the process list. `nextManagerReserve` uses `getScriptRam` automatically — no RAM field needed on the entry.

- [ ] **Step 3: Add a dashboard row**

In `src/dashboard.js`: add `STATUS_PORT_SLEEVES` to the constants import, add `sleeves: readStatus(ns, STATUS_PORT_SLEEVES)` to the snapshot object (near `gang:`), and render one compact line matching the dashboard's existing row style, e.g.:

```js
// in the render section, alongside the gang row:
if (snap.sleeves) {
    const t = snap.sleeves.tasks;
    rows.push(`sleeves: ${snap.sleeves.count} | shock ${snap.sleeves.avgShock} sync ${snap.sleeves.avgSync} | ` +
        `sync${t.sync} rec${t.recovery} karma${t.karma} fac${t.faction} gym${t.gym} crime${t.crime} | ` +
        `spent ${ns.format.number(snap.sleeves.spentThisRun)}`);
}
```

Match the actual row/append idiom used in `dashboard.js` (read the surrounding render code first — the variable may not be `rows`).

- [ ] **Step 4: Verify the dashboard shows sleeves**

With the manager running, open the dashboard tail. Expected: a `sleeves:` line with live counts that track the log's `ev=tick` values.

- [ ] **Step 5: Commit**

```bash
git add src/booster.js src/dashboard.js
git commit -m "feat(sleeves): auto-launch via booster + dashboard row"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/scripts/sleeves.md` (via `/devlog`)

- [ ] **Step 1: Write the per-script doc**

Invoke the `/devlog` skill for `src/managers/sleeves.js`. It should cover: the ladder, why sync-first (linear exp transfer), the one-per-faction rule and fallthrough, the spend cap, the log-based verification approach, and the two dropped rows (Bladeburner/Company) with pointers to the reminder notes in `docs/plans/bladeburner.md` and `docs/plans/faction-prereqs-training.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/scripts/sleeves.md
git commit -m "docs(sleeves): per-script devlog"
```

---

## Self-Review

**Spec coverage:**
- Operating model (per-sleeve independent) → Task 3 loop. ✓
- Ladder rows 1-6 → `chooseTask` (Task 2), applied in Task 3. ✓
- One-per-faction claim + fallthrough → Task 3 loop. ✓
- Thrash guard → `matchesCurrent` (Task 2) + Task 3 no-op path. ✓
- Spending (sleeve/memory/aug, cap) → Task 4. ✓
- Status port 11 → Task 3; dashboard → Task 5. ✓
- Logging & verification (`tick`/`assign`/`claim`/`buy`) → Tasks 3-4; self-test → Task 2. ✓
- Constants → Task 1. ✓
- Gate (SF10) → Task 5. ✓
- Dropped rows documented → Task 6 (notes already in source plans). ✓

**Placeholder scan:** all code blocks are concrete. Two explicit "verify against the defs before running" flags (aug field names in Task 4; dashboard render idiom in Task 5) are real verification steps, not placeholders — the surrounding code is complete.

**Type consistency:** decision object `{ row, crime?, faction?, stat? }` is produced by `chooseTask` and consumed identically by `matchesCurrent`, `applyTask`, and the loop. `ctx` fields (`gangKarmaPhase`, `pilotFaction`, `claimedFactions`) match between `gatherContext`, the loop, and the self-test. `GYM_STAT` keys (stat names) match `lowestCombatStat` output and `chooseTask`'s `d.stat`.
