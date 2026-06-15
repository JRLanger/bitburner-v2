# Bitburner Gang Management: Verified Mechanics & Territory Guide

> All formulas in this document are extracted directly from the Bitburner source code
> (`bitburner-official/bitburner-src`, dev branch). Every API call uses the correct field names.

## Table of Contents
1. [How Gang Power Works](#1-how-gang-power-works)
2. [How Territory Works](#2-how-territory-works)
3. [Win Chance Formula](#3-win-chance-formula)
4. [Optimal CLASH Entry: Dynamic Win Chance Threshold](#4-optimal-clash-entry-dynamic-win-chance-threshold)
5. [Territory Growth Strategy (Combat Gangs)](#5-territory-growth-strategy-combat-gangs)
6. [Territory Growth Strategy (Hacking Gangs)](#6-territory-growth-strategy-hacking-gangs)
7. [Gang Income Formula](#7-gang-income-formula)
8. [Wanted Level Mechanics](#8-wanted-level-mechanics)
9. [Equipment Strategy & Ascension Locking](#9-equipment-strategy--ascension-locking)
10. [Task Reference](#10-task-reference)
11. [Correct API Reference](#11-correct-api-reference)
12. [Gang Member Stat Fields](#12-gang-member-stat-fields)
13. [Common Mistakes](#13-common-mistakes)
14. [Gang Selection: Faction Differences & Augmentations](#14-gang-selection-faction-differences--augmentations)

---

## 1. How Gang Power Works

### The Power Formula (from source)

Gang power accumulates every **100 game cycles** (~20 seconds at normal speed, faster with bonus time):

```
gang.powerGainPerUpdate = 0.015 × max(0.002, territory) × Σ member.calculatePower()
```

Where `member.calculatePower()` is:

```
memberPower = (hack + str + def + dex + agi + cha) / 95
```

All six stats contribute **equally** to power. This is a raw stat sum divided by 95 — not weighted, not using multipliers directly. Stats are what matter, and stats are raised by:

- **Base XP** — earned by doing tasks
- **Equipment multipliers** (`str_mult`, `def_mult`, etc.) — applied via purchased gear
- **Ascension multipliers** (`str_asc_mult`, etc.) — permanent, survive resets

### Key Implications

- Every member on "Territory Warfare" contributes power; members on any other task contribute **zero** to power.
- Power gain scales linearly with the number of members on Territory Warfare.
- Power gain also scales with your **current territory** — larger territory = faster power growth (positive feedback loop).
- A member with higher total stats is worth more in a territory push than a member still in training.
- All six stats count, so combat equipment (armor, vehicles) still helps a hacking gang member's power.

---

## 2. How Territory Works

### Update Cycle

Territory and power both update every **100 game cycles**. At normal speed (200 ms/cycle) this is 20 seconds. With bonus time the game fast-forwards, so the 100-cycle threshold is reached much faster in wall-clock time.

### Clash Chance

When `ns.gang.setTerritoryWarfare(true)` is set, the clash chance is **1.0** (clashes always happen). When set to `false`, the clash chance decreases by 0.01 per territory update. In practice: turn it on = always clash; turn it off = clashes fade out.

### Territory Gain Per Won Clash (from source)

```javascript
const powerBonus = Math.max(1, 1 + Math.log(winnerPower / loserPower) / Math.log(50));
const territoryGained = Math.min(loserTerritory, powerBonus * 0.0001 * (Math.random() + 0.5));
```

- Base territory gained per win: **0.00005 to 0.00015** (random component: 0.5–1.5)
- **Power bonus**: if your power is 50× the loser's, `powerBonus = 2` (double gains)
- If your power is 2500× the loser's, `powerBonus = 3` (triple gains)
- Going from 1/7 territory (~14.3%) to 100% requires on the order of **6000–12000 won clashes** at base rate — which is why power ratio matters for speed

### Territory Loss Per Lost Clash

Lost clashes transfer territory the same way (you become the loser). Additionally, NPC gangs that lose have their power reduced by a factor of `1/1.01` per loss, so dominating one gang makes them progressively weaker.

### Member Deaths During Clashes

Clash losers can lose gang members. Death chance is reduced by member **defense** stats. High-defense members are safer during clashes.

---

## 3. Win Chance Formula

From source (`AllGangs.ts`):

```javascript
function getClashWinChance(thisGang, otherGang) {
  return AllGangs[thisGang].power / (AllGangs[thisGang].power + AllGangs[otherGang].power);
}
```

Simple ratio: your power divided by the sum of both powers.

| Your Power | Enemy Power | Win Chance |
|------------|-------------|------------|
| 1          | 1           | 50%        |
| 3          | 1           | 75%        |
| 9          | 1           | 90%        |
| 19         | 1           | 95%        |

**Starting conditions**: All 7 gangs (including yours) start with power = 1 and territory = 1/7. You start at 50% win chance against every rival.

**Why not engage at 50%?** At 50% you win and lose in equal measure. Territory gains per win and losses per loss are roughly symmetric, so you make no net progress. You want a meaningful edge before engaging.

**Recommended thresholds**:
- `< 0.55` — power build mode (clashes OFF, all earners on Territory Warfare)
- `≥ 0.55` — engage clashes (clashes ON, normal task distribution)

A 55% win rate generates steady net territory gain. The NPC gangs' power penalty on each loss accelerates the advantage over time.

### ⚠️ Use the MINIMUM win chance across ALL rivals — not just one

When you call `setTerritoryWarfare(true)`, the game clashes against **every rival simultaneously**. You cannot selectively target weaker gangs. If you have 80% win chance vs 5 rivals but 40% vs one strong rival, enabling warfare means:

- You gain territory from the 5 weak gangs ✅
- You **lose** territory to the 1 strong gang ❌
- The strong gang has the power advantage, so the territory gain formula (`powerBonus * 0.0001 * random`) awards *them* more per win than it awards *you* from the weak gangs
- Losing clashes can also kill members, reducing your power

**Stay in power-build mode until the worst rival is also ≥ 55%.** Always use `Math.min(...)` across all rivals' win chances as your engagement trigger.

---

## 4. Optimal CLASH Entry: Dynamic Win Chance Threshold

### Why the Threshold Matters Enormously

Territory gain per update cycle is not linear in win chance — the `powerBonus` multiplier creates a strongly superlinear relationship. Starting CLASH at a higher win chance gives both more territory per *won* clash and a higher win rate, compounding the advantage.

All formulas verified from `Gang.ts` source.

### Net Territory Gain Rate Formula

Each game update (100 cycles ≈ 20s normal speed), the player is involved in ~2 clashes (once as challenger picking a random rival, once as a randomly-selected opponent). Expected net territory per update:

```
net = 2 × [ W × powerBonus(W) − (1−W) ] × 0.0001

where:
  powerBonus(W) = max(1,  1 + ln(W/(1−W)) / ln(50))
  W             = win chance vs the representative rival
```

When you are stronger (W > 0.5), the losing rival's `powerBonus` is always 1.0 (capped at `max(1, …)`), so only your wins carry a bonus — losses always cost the base `0.0001`.

### Territory Rate at Different Win Chances

| Win % | powerBonus | Net territory/update | Updates to 100% | vs 55% |
|-------|-----------|----------------------|-----------------|--------|
| 55% | 1.051 | 0.0000256 | **33,477** | 1× |
| 60% | 1.104 | 0.0000525 | 16,323 | 2.1× |
| 65% | 1.158 | 0.0000805 | 10,646 | 3.1× |
| 70% | 1.216 | 0.0001102 | 7,776 | 4.3× |
| 75% | 1.281 | 0.0001422 | 6,026 | 5.6× |
| 80% | 1.354 | 0.0001766 | 4,852 | **6.9×** |
| 85% | 1.443 | 0.0002153 | 3,980 | 8.4× |
| 90% | 1.562 | 0.0002612 | 3,281 | 10.2× |
| 95% | 1.753 | 0.0003230 | 2,653 | 12.6× |

> These are *static* estimates (treating W as constant throughout CLASH). In practice, NPC power decays by 1% per lost clash, so win chance improves over time and actual CLASH time is shorter — especially at higher starting W.

### The W_max Ceiling

During POWER phase (members on Territory Warfare, clashes off), power grows linearly:

```
Player:   P(t) = P₀ + R_p × t
Each NPC: E(t) = E₀ + R_n × t

R_p = 0.015 × territory × Σ(memberPower for TW-assigned members)
R_n ≈ 0.5×min(0.85, E×0.005) + 0.5×(0.5625 × territory × PowerMultiplier)
    ≈ 0.0025×E + 0.040×PowerMultiplier   (per update, early game)
```

The equilibrium win chance — the ceiling you asymptotically approach — is:

```
W_max = R_p / (R_p + R_n)
```

**Training past this point is impossible.** Win chance growth rate approaches zero as W → W_max. NPC growth is dominated by a small multiplicative term (≤ 0.5% per update, capped hard at 0.85) plus an additive territory term — far slower than player growth from a well-trained 12-member roster.

Example W_max values (combat gang, avg stat 300, territory = 1/7):

| R_p | NPC PowerMultiplier | R_n | W_max |
|-----|--------------------|----|-------|
| 0.336 | 1 | 0.043 | **88.7%** |
| 0.336 | 2 | 0.083 | **80.2%** |
| 0.336 | 3 | 0.122 | **73.3%** |

Higher member stats → higher R_p → higher W_max.

### Break-Even Analysis: When Is More Training Worth It?

Training from W₁ to W₂ is worth the time spent if `T_power_increase < T_clash_savings`:

| Training step | T_clash saved | Max worthwhile T_power |
|---------------|--------------|------------------------|
| 55% → 60% | 17,154 updates ≈ 95h | Always worth it |
| 60% → 65% | 5,677 updates ≈ 31h | Always worth it |
| 65% → 70% | 2,870 updates ≈ 16h | Almost always worth it |
| 70% → 75% | 1,750 updates ≈ 9.7h | Almost always worth it |
| 75% → 80% | 1,174 updates ≈ 6.5h | Very likely worth it |
| 80% → 85% | 872 updates ≈ 4.8h | Likely worth it |
| 85% → 90% | 699 updates ≈ 3.9h | Situational |

*(1 update = 100 game cycles = 20s normal speed, faster with bonus time)*

At realistic power growth rates (R_p ≈ 0.336), moving from 55% to 70% takes ~5-10 updates — a tiny fraction of the 2,870 updates saved. **Training to near W_max is almost always the right call.**

### T_total Comparison (W_max ≈ 80%, typical scenario)

| Entry win % | T_power | T_clash | T_total | Speedup |
|-------------|---------|---------|---------|---------|
| 55% | 0 | 33,477 | 33,477 | 1× |
| 70% | ~10 | 7,776 | 7,786 | 4.3× faster |
| 75% | ~24 | 6,026 | 6,050 | 5.5× faster |
| **79%** | **~108** | **5,104** | **5,212** | **6.4× faster** |
| 80% (W_max) | ∞ | — | — | — |

### Why a Fixed Threshold Is Wrong

A fixed threshold (e.g., 55%) is wrong because W_max depends on member stats and NPC growth rates — both unknown at script start. The optimal entry point is dynamic:

- Better trained members → higher R_p → higher W_max → wait longer
- Faster NPC growth → lower W_max → enter sooner

### The Dynamic Threshold: Enter When Growth Flattens

Instead of a fixed percentage, `gang.js` tracks win chance growth over a rolling 3-minute window:

```javascript
// Constants in gang.js:
CLASH_WIN_FLOOR  = 0.55    // absolute safety minimum — never engage below this
CLASH_GROWTH_MIN = 0.005   // enter CLASH when win Δ < 0.5% over WIN_HISTORY_LEN cycles
WIN_HISTORY_LEN  = 60      // 60 × 3s = 180s ≈ 9 game update cycles at normal speed

// Each cycle:
winChanceHistory.push(minWinChance);
winChanceGrowth  = minWinChance - winChanceHistory[0];   // net change over window
winChanceSlowing = winChanceGrowth < CLASH_GROWTH_MIN;

// CLASH entered when:
//   minWinChance >= CLASH_WIN_FLOOR    (safety floor)
//   winChanceSlowing == true           (growth flattened → near W_max)
//   allEquipped == true                (all members have their power gear)
```

The tail display shows live growth rate and status in POWER phase:
```
Territory: 14.3%  — building power, clashes OFF  |  Δwin: +0.312% / 180s  growing — need <0.50%
```
When growth flattens and all members are armed, CLASH engages automatically.

### Keep Members on Territory Warfare During CLASH

`calculatePower()` only counts members assigned to "Territory Warfare". Moving earners to income/respect tasks the moment clashes start freezes your power — the only win-chance improvement comes from NPC decay, which is slow at first.

**The optimal approach: keep all earners on Territory Warfare throughout CLASH.** This means:
- Your power grows at the same rate as POWER phase
- NPC power decays from every lost clash (×1/1.01 per loss)
- Win chance improves from **both directions simultaneously**
- Territory accumulates faster at higher win chances (superlinear relationship)

Income drops to near zero during CLASH (TW has no money weight), but the CLASH phase is short after entering near W_max, and DONE phase resumes full income with territory bonuses. This is the implementation in `gang.js`.

### NPC Power Decay During CLASH

Once CLASH starts, enemy power decreases by `× (1/1.01)` per lost clash (source: `Gang.ts`). With all earners also on TW, this compounds with your own power growth — enemy power eventually falls faster than it grows, win chance improves rapidly, and territory accumulates faster over time. The static T_clash estimates in the table above are conservative; actual CLASH duration is significantly shorter.

---

## 5. Territory Growth Strategy (Combat Gangs)

### Why Combat Gangs Dominate Territory

Combat gang members train Strength, Defense, Dexterity, and Agility — four stats out of six in the power formula. With all four at high levels, their `memberPower = (str + def + dex + agi + hack + cha) / 95` is maximized for the stats they actively build. 100% territory is achievable.

### Phase 1: Recruit All 12 Members + Train

**Recruiting is the first priority.** Power gain per update cycle scales linearly with the number of members on Territory Warfare. 12 members = 4× more power than 3 members. Getting to 12 as fast as possible is the single biggest lever for fast territory growth — do not skip this by going straight to a power build with 3 members.

```
Starting 3 members:
  → Assign to Terrorism (highest respect for combat gangs; unlocks recruits fast)
  → Check canRecruitMember() every cycle — recruit immediately when true
  → New recruit → Train Combat immediately

Members 4–11 phase:
  → 1–2 strongest members: Terrorism (keep earning respect to unlock next slot)
  → Everyone else: Train Combat
  → Recruit as fast as slots open

All 12 recruited:
  → All members: Train Combat until avgStat ≥ 300
  → Buy equipment every cycle (cheapest first)
  → Ascend when multiplier gain is worth it (see ascension pattern below)
```

**Why Terrorism and not a money task?** You need respect to unlock member slots. Respect from Terrorism accumulates fast and unlocks all 12 slots much sooner than moderate-income tasks. Money is secondary at this stage — equipment purchases are gated on player money (`ns.getServerMoneyAvailable("home")`), not gang income.

**API note**: Check equipment with `ns.gang.getEquipmentNames()` + `ns.gang.getEquipmentCost(name)`. Check what a member owns via `info.upgrades` and `info.augmentations` (both arrays of names).

### Phase 2: Territory Push (Power Build)

Once your strongest members are trained, switch to territory expansion.

```
Condition: minWinChance < 0.55 (against worst rival)

Action:
  - All earners (stat ≥ threshold) → "Territory Warfare"
  - Trainees → stay on "Train Combat"
  - setTerritoryWarfare(false)   ← clashes OFF
```

**Why clashes OFF during power build?** You're weaker than your rivals at this point. Engaging would cost you territory and reduce your power (via member deaths). Let power accumulate safely.

**How long?** Power grows each update. You check `ns.gang.getChanceToWinClash(rivalName)` each cycle. As soon as the worst-case rival drops below 45% win chance against you (i.e., your win chance ≥ 55%), move to engagement.

### Phase 3: Engagement (CLASH)

```
Condition: win chance growth rate has flattened (near W_max) AND all members equipped
           (see Section 4 for the dynamic threshold)

Action:
  - Keep ALL earners on "Territory Warfare"   ← critical, see note below
  - setTerritoryWarfare(true)                 ← clashes ON
  - Reactive vigilante management for wanted level (pulls from TW if needed)
```

**Why keep everyone on TW during CLASH:**
`calculatePower()` only sums members assigned to Territory Warfare. Moving earners to income tasks freezes power — win chance can only improve through NPC power decay (~1% per lost clash), which is slow initially. Keeping earners on TW means power continues growing *simultaneously* with NPC decay, improving win chance from both directions at once. Territory accumulates significantly faster.

The cost is near-zero income during CLASH (TW has no money weight). This is acceptable because:
- CLASH should be short after entering at near W_max
- DONE phase resumes full income with territory bonuses (1.4–2× depending on task)

**Clashes fire every 100 game cycles regardless of task assignment.** The clash outcome is determined by accumulated power (which is now growing). You gain territory AND power simultaneously during this phase.

If win chance drops below `CLASH_WIN_FLOOR` (a rival grew significantly stronger), the script reverts to POWER mode automatically.

### Phase 4: Post-100% Territory

Once `gi.territory >= 0.99`:
- `setTerritoryWarfare(false)` — no more clashes needed
- All members back to income/respect tasks
- Gang income gains a territory bonus:
  - Human Trafficking: 1.5× money from territory
  - Terrorism: 2× respect from territory
  - Traffick Illegal Arms: 1.4× money from territory

---

## 6. Territory Growth Strategy (Hacking Gangs)

### Why Hacking Gangs Struggle for Territory

The power formula is symmetric across all six stats. A hacking gang member trained purely on hacking has:
- High `hack` (maybe 60% of total stat sum)
- Low `str`, `def`, `dex`, `agi` (trained minimally or not at all)
- Moderate `cha`

Compared to a combat gang member with balanced str/def/dex/agi training, the hacking member generates **less raw power per member** for the same time investment. The 4 combat stats make up ~67% of the power formula; hacking makes up only ~17%.

**Realistic territory ceiling without combat training: 40–60%.**

### Option A: Skip Territory (Recommended for Most Players)

Hacking gangs excel at faction reputation (augmentation access) and moderate income. Let combat gangs fight over territory and focus on what you do well:

- All members on "Cyberterrorism" (highest respect) or "Money Laundering" (highest income)
- Manage wanted level with "Ethical Hacking" reactively
- `setTerritoryWarfare(false)` permanently

### Option B: Hybrid Combat Training (For Players Who Want Territory)

This is the only way for a hacking gang to meaningfully compete for territory.

**Do not start a power build with pure-hacking members.** A member with hack=2000 and all combat stats at 10 has `memberPower ≈ (2000+10+10+10+10+50)/95 ≈ 22`. A combat gang member with all stats at 500 has `memberPower ≈ (100+500+500+500+500+100)/95 ≈ 23`. The hacking member barely competes despite having 20× the hacking skill, because the four combat stats they lack make up 67% of the formula.

**The correct approach — train combat stats first, then power build:**

```
Phase 1 (same as combat gang: recruit all 12, earn respect):
  → Assign to Cyberterrorism (highest respect for hacking gangs)
  → Recruit all 12 members as slots open

Phase 2 (hybrid training):
  → Half of members: Train Hacking
  → Other half: Train Combat   ← critical for territory power
  → Buy combat equipment (armor, vehicles) in addition to hacking gear
  → Rotate: once a member's hack is strong enough, shift them to Train Combat

Phase 3 (power build — only when members have meaningful combat stats):
  → All earners on Territory Warfare (clashes OFF)
  → Wait for win chance ≥ 55% vs ALL rivals before enabling clashes

Phase 4 (engagement):
  → setTerritoryWarfare(true)
  → Members back to Cyberterrorism/Money Laundering while clashes run
```

**Expected outcome**: Can reach 70–85% territory with concerted effort. Rarely 100% without near-maxed combat stats on most members.

**Trade-off**: Time spent training combat is time not building hacking multipliers for income and reputation.

### Wanted Level — Critical for Hacking Gangs

Keep `gi.wantedPenalty` above 0.95 by reactively assigning one member to "Ethical Hacking" when it drops below the threshold. See [Section 8](#8-wanted-level-mechanics) for the full formula and mechanics.

---

## 7. Gang Income Formula

### The Formula (from `Gang/formulas/formulas.ts`)

```typescript
export function calculateMoneyGain(gang, member, task): number {
  if (task.baseMoney === 0) return 0;

  let statWeight =
    (task.hackWeight / 100) * member.hack +
    (task.strWeight  / 100) * member.str  +
    (task.defWeight  / 100) * member.def  +
    (task.dexWeight  / 100) * member.dex  +
    (task.agiWeight  / 100) * member.agi  +
    (task.chaWeight  / 100) * member.cha;
  statWeight -= 3.2 * task.difficulty;

  if (statWeight <= 0) return 0;

  const territoryMult   = Math.max(0.005, Math.pow(gang.territory * 100, task.territory.money) / 100);
  const respectMult     = gang.respect / (gang.respect + gang.wantedLevel);  // wanted penalty
  const territoryPenalty = (0.2 * gang.territory + 0.8) * currentNodeMults.GangSoftcap;

  return Math.pow(5 * task.baseMoney * statWeight * territoryMult * respectMult, territoryPenalty);
}
```

### What Affects Gang Income

| Factor | Effect |
|--------|--------|
| Member stats (hack/str/def/dex/agi/cha) | Weighted by task — the primary lever |
| Task `baseMoney` | Fixed per task; money tasks have the highest values |
| Territory | `(territory × 100)^taskExponent / 100` — compound benefit at high territory |
| Wanted penalty | `respect / (respect + wantedLevel)` — always < 1 |
| `GangSoftcap` BitNode multiplier | Applied as the exponent — affects all income |

### What Does NOT Affect Gang Income

**`Player.mults.crime_money` and `Player.mults.crime_success` have zero effect on gang income.** The formula never references `Player.mults` at any point. Augmentations that boost crime money or crime success rate are useless for gang passive income.

The only `Player.mults` used in the gang pipeline is `faction_rep`, applied to the respect→faction reputation conversion — not to money.

### Member Stats in the Formula

`member.hack`, `member.str`, etc. are the member's computed stat levels, derived from their XP × equipment multiplier × ascension multiplier. They are entirely independent of player-level multipliers.

---

## 8. Wanted Level Mechanics

### The Penalty Formula

```
wantedPenalty = respect / (respect + wantedLevel)
```

This is applied as a direct multiplier to both money and respect gains. Higher wanted level → lower penalty → less income and respect per cycle.

### Floor: Wanted Level Cannot Go Below 1

The game hard-clamps wanted level at 1 (from `Gang.ts`):

```typescript
if (this.wanted < 1) this.wanted = 1;
```

There is no mechanic to achieve negative wanted or a bonus above 1.0. The penalty is always strictly less than 1.

### Ideal Wanted Level

The best achievable penalty is at `wantedLevel = 1`:

```
penalty = respect / (respect + 1)
```

This approaches 1.0 asymptotically as respect grows. The penalty is effectively negligible once respect is large enough.

### What Actually Matters: The Ratio

The penalty depends entirely on how large wanted is **relative to respect**:

| Respect | Wanted | Penalty |
|---------|--------|---------|
| 1,000 | 1 | 99.9% |
| 1,000 | 50 | 95.2% |
| 1,000 | 100 | 90.9% |
| 1,000 | 500 | 66.7% |
| 10,000 | 500 | 95.2% |
| 100,000 | 5,000 | 95.2% |

The 0.95 threshold in `gang.js` (`WANTED_PENALTY_MIN = 0.95`) maps to `wanted < respect / 20`. That is: at any given respect level, wanted must stay below 5% of respect to remain above the threshold.

### When to Reduce Wanted Level

Monitor `gi.wantedPenalty` (returned by `getGangInformation()`), not the raw wanted level value. The raw wanted number is meaningless without context; the penalty is the actual impact.

- If `wantedPenalty < 0.95` → assign one member to the vigilante task (Ethical Hacking / Vigilante Justice)
- If `wantedLevelGainRate <= 0` → the assigned vigilante is winning; release back to income/respect when penalty recovers
- Wanted naturally grows as members do high-income tasks; reactive management is sufficient — no need to pre-assign vigilantes

---

## 9. Equipment Strategy & Ascension Locking

### The Core Problem: Ascension Destroys Equipment

When a gang member ascends, their XP resets to 0. Crucially, this also wipes all purchased equipment stored in `member.upgrades[]`. **Augmentations (`member.augmentations[]`) survive ascension.** This creates a tension: you want to ascend frequently to compound multipliers, but you cannot buy equipment if it will just be wiped the next ascension.

The solution is a **phase-based equipment strategy** that buys equipment only when it makes sense, and locks specific members from ascending to protect purchased gear.

### Equipment Types and When They Matter

`ns.gang.getEquipmentType(name)` returns one of: `"Weapon"`, `"Armor"`, `"Vehicle"`, `"Rootkit"`, `"Augmentation"`.

| Type | Survives Ascension? | Relevant for |
|------|--------------------|-|
| Augmentation | ✅ Yes | Always buy — safe at any phase |
| Weapon | ❌ No (wipes) | Combat gangs: boosts str/def |
| Armor | ❌ No (wipes) | Combat gangs: boosts def |
| Vehicle | ❌ No (wipes) | Both gang types: boosts agi/cha |
| Rootkit | ❌ No (wipes) | Hacking gangs: boosts hack |

**Non-aug equipment** (`upgrades[]`) is worth buying only when the member won't ascend soon — i.e., when they're locked.

**Income-relevant gear varies by gang type:**
- **Combat gangs** earn money via Human Trafficking/Terrorism (weighted str/def/dex/agi/cha) → Weapons, Armor, Vehicles relevant; Rootkits irrelevant
- **Hacking gangs** earn via Money Laundering/Cyberterrorism (weighted hack/cha) → Rootkits, Vehicles relevant; Weapons and Armor irrelevant

### The Four Phases

```
RECRUIT → POWER → CLASH → DONE
```

POWER/CLASH are skipped if territory is not being pursued.

#### RECRUIT Phase
- Condition: fewer than 12 members recruited
- Equipment: **nothing** — any gear purchased now will be wasted as members ascend frequently during early training
- Reasoning: augmentation prices are too high for early game; non-aug gear will be wiped by the first ascension anyway

#### POWER Phase
- Condition: 12 members, min win chance < 0.55 OR not all members fully equipped
- All earners → Territory Warfare (clashes OFF, power building)
- Equipment strategy: **arm one member at a time, most powerful first**
  - Sort members by avgStat descending — strongest first
  - The current "equip target" receives all non-aug power gear in order of cost
  - Once fully equipped, they are added to `equippedInPowerPhase` set and locked from ascending
  - Move to the next unequipped member
- Augments: buy for ALL members whenever `homeMoney ≥ cost × 5` (AUGMENT_SAFETY_MULT)
- Why arm strongest first: the most powerful member contributes the most to territory win chance; getting them locked and fully equipped fastest accelerates the path to CLASH

#### CLASH Phase
- Condition: min win chance ≥ 0.55 vs ALL rivals AND all members in `equippedInPowerPhase`
- `setTerritoryWarfare(true)` — clashes actively running
- Equipment: **augments only** (non-aug gear is safe since all members are locked)
- Ascending: **fully locked for all members** — any ascension would wipe expensive gear
- Why the allEquipped gate: entering CLASH with one member still un-equipped means that member would lose gear if they somehow ascended. Cleaner to fully arm everyone first.

#### DONE Phase
- Condition: territory ≥ 99% (or territory skipped)
- `setTerritoryWarfare(false)` — clashes off
- Ascending resumes for all members — no locking
- Equipment: income-relevant non-aug gear for all + augments for all
- Why ascending resumes: at this point maximizing member stats for income is the goal; ascension grows multipliers permanently, and income gear will be re-purchased after each ascension

### The `equippedInPowerPhase` Set

This is the key state mechanism in `gang.js`. It's a `Set<memberName>` that persists across loop cycles.

**Rules:**
- A member is added when they own every item in `powerEquipList` (all non-aug equipment)
- The set is cleared when reverting from CLASH back to POWER (e.g., a rival grew stronger and win chance dropped below threshold)
- The set is also cleared when entering DONE
- On reversion, the equipment queue restarts from the top — check all members again

**Why a persistent set instead of re-checking each cycle?**
Because `member.upgrades[]` changes mid-purchase (each `purchaseEquipment()` call modifies it), and the set provides a stable "this member is done" marker. Without it, a member who just received their last piece of gear would be immediately unlocked and could ascend before the script finishes the cycle.

### Ascension Lock Logic

```javascript
const isAscensionLocked = n =>
  phase === "CLASH" ||
  (phase === "POWER" && (equippedInPowerPhase.has(n) || n === equipTarget));
```

- **CLASH**: everyone locked, no exceptions
- **POWER**: only the current equip target + already-fully-equipped members are locked
  - Unequipped members (not yet the target) can ascend freely — they have no gear to lose
- **RECRUIT / DONE**: nobody locked

### Display Indicators in gang.js

In the tail log, the member table prefix column shows:
- `→` — this member is the current equip target in POWER phase
- `=` — this member is locked from ascending (already equipped in POWER, or any member in CLASH)
- ` ` — free to ascend

The `Arming` status line (shown only in POWER phase) shows:
```
Arming: 3/12 armed | arming: G-7
```
or when waiting for win chance:
```
Arming: 12/12 armed | waiting for win chance ≥ 55.0%
```

### Augmentation Safety Multiplier

Augments are bought only when `homeMoney() >= cost * AUGMENT_SAFETY_MULT` (default: 5×).

**Why:** Augments are expensive relative to non-aug gear. Buying one that costs $1 billion requires $5 billion on hand. This prevents the script from draining home money below the level needed for other purchases (pservers, hacking upgrades, etc.) by requiring a substantial buffer.

### The CLASH Gate: Both Conditions Required

```javascript
if (minWinChance < CLASH_WIN_MIN || !allEquipped) return "POWER";
```

Phase is CLASH only when:
1. `minWinChance ≥ 0.55` vs ALL rivals (the original condition)
2. `allEquipped` — every member is in `equippedInPowerPhase`

**Why both?** Without condition 2, we'd enter CLASH with members who still need gear. Those members would be stuck in CLASH (ascending locked) but also not getting non-aug gear (CLASH only buys augments). It's cleaner and faster to keep building power until everyone is armed, then enter the clash phase with a fully equipped, fully locked gang.

### Balanced Mode — Future Enhancement (Deferred)

The current "balanced" focus mode splits earners 50/50 between respect and money tasks throughout DONE phase. A planned improvement would check faction reputation against the cost of the most expensive unowned augment and switch from respect to money focus once the threshold is met.

This requires:
- `ns.singularity.getFactionRep(faction)` — 5 GB (×16 = 80 GB without SF4)
- `ns.singularity.getAugmentationsFromFaction(faction)` — 5 GB (×16 = 80 GB without SF4)
- `ns.singularity.getAugmentationRepReq(augName)` — 5 GB (×16 = 80 GB without SF4)
- `ns.singularity.getOwnedAugmentations(includeInstalled?)` — 5 GB (×16 = 80 GB without SF4)

Without Source File 4 (Singularity), these functions cost 16× their normal RAM — 80 GB each, or 320 GB total just for the four calls. This is not practical before SF4. This enhancement is deferred until Singularity scripts are built.

---

## 10. Task Reference

### Combat Gang Tasks

| Task | Primary Use | Notes |
|------|-------------|-------|
| Train Combat | Stat building | Trains str/def/dex/agi |
| Train Hacking | Stat building | Trains hack |
| Train Charisma | Stat building | Trains cha |
| Territory Warfare | Power building / Territory | All stats contribute; members can die in clashes |
| Vigilante Justice | Wanted reduction | Reduces wanted level |
| Terrorism | Respect (high) | High wanted gain; 2× with 100% territory |
| Human Trafficking | Money (high) | Best money task; 1.5× with 100% territory |
| Traffick Illegal Arms | Money (medium) | 1.4× money with territory |
| Strongarm Civilians | Money (lower) | 1.6× money with territory |
| Run a Con | Money (low) | Low wanted gain |
| Deal Drugs | Money (low) | 1.2× with territory |
| Mug People | Low income/respect | Early game only |

### Hacking Gang Tasks

| Task | Primary Use | Notes |
|------|-------------|-------|
| Train Hacking | Stat building | |
| Train Combat | Stat building | Boosts power for territory |
| Train Charisma | Stat building | |
| Territory Warfare | Power building / Territory | Same as combat gang |
| Ethical Hacking | Wanted reduction | Hacking gang equivalent of Vigilante Justice |
| Cyberterrorism | Respect (high) | Best respect task |
| Money Laundering | Money (high) | Best money task for hacking gangs |
| Phishing | Money (low) | Low wanted gain |
| Ransomware | Money (medium) | Higher wanted gain |
| Identity Theft | Money | Medium |
| Trafficking Illegal Arms | Money | Available to hacking gang too |

### Territory Warfare Task Stats (from source)

```
hackWeight:  15%
strWeight:   20%
defWeight:   20%
dexWeight:   20%
agiWeight:   20%
chaWeight:    5%
difficulty:   5
```

These weights affect XP distribution from doing the task, not the power formula. The power formula uses raw stats equally.

---

## 11. Correct API Reference

### Gang Namespace Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `ns.gang.inGang()` | `boolean` | Check if you're in a gang |
| `ns.gang.createGang(faction)` | `boolean` | Create gang; returns false if requirements not met |
| `ns.gang.getGangInformation()` | `GangGenInfo` | Current gang state |
| `ns.gang.getMemberNames()` | `string[]` | List of all member names |
| `ns.gang.getMemberInformation(name)` | `GangMemberInfo` | Full member stats |
| `ns.gang.canRecruitMember()` | `boolean` | Whether a new slot is available |
| `ns.gang.recruitMember(name)` | `boolean` | Recruit; returns false if can't |
| `ns.gang.setMemberTask(name, task)` | `boolean` | Assign task |
| `ns.gang.getAscensionResult(name)` | `GangMemberAscension \| undefined` | Preview ascension multiplier gain |
| `ns.gang.ascendMember(name)` | `GangMemberAscension \| undefined` | Ascend member; resets XP |
| `ns.gang.getEquipmentNames()` | `string[]` | All purchasable equipment names |
| `ns.gang.getEquipmentCost(name)` | `number` | Cost of a specific piece of equipment |
| `ns.gang.getEquipmentType(name)` | `string` | `"Weapon"`, `"Armor"`, `"Vehicle"`, `"Rootkit"`, `"Augmentation"` |
| `ns.gang.purchaseEquipment(member, equip)` | `boolean` | Buy named equipment for member |
| `ns.gang.getAllGangInformation()` | `Record<string, GangOtherInfo>` | All gangs' power and territory |
| `ns.gang.getChanceToWinClash(gangName)` | `number` | Your win probability vs that gang (0–1) |
| `ns.gang.setTerritoryWarfare(engage)` | `void` | Enable/disable clash engagement |

### GangGenInfo Fields (from `getGangInformation()`)

```typescript
{
  faction: string,           // Your gang's faction name
  isHacking: boolean,        // true = hacking gang
  moneyGainRate: number,     // $/cycle (multiply by 5 for $/sec at normal speed)
  power: number,             // Current gang power
  respect: number,           // Total accumulated respect
  territory: number,         // Territory fraction (0–1)
  territoryClashChance: number, // Current clash probability
  territoryWarfareEngaged: boolean,
  wantedLevel: number,       // Current wanted level
  wantedLevelGainRate: number,  // Rate of wanted change (can be negative)
  wantedPenalty: number,     // = respect / (respect + wantedLevel); range 0–1
}
```

**No `money` field** — use `ns.getServerMoneyAvailable("home")` for player money.

**No `rival_gangs` field** — use `ns.gang.getAllGangInformation()` for rivals.

### GangMemberInfo Fields (from `getMemberInformation()`)

```typescript
{
  name: string,
  task: string,              // Current task name

  // Raw stat values (what the power formula uses)
  hack: number,
  str: number,
  def: number,
  dex: number,
  agi: number,
  cha: number,

  // XP accumulated
  hack_exp: number,
  str_exp: number,
  def_exp: number,
  dex_exp: number,
  agi_exp: number,
  cha_exp: number,

  // Equipment multipliers (from purchased gear)
  hack_mult: number,
  str_mult: number,
  def_mult: number,
  dex_mult: number,
  agi_mult: number,
  cha_mult: number,

  // Ascension multipliers (permanent)
  hack_asc_mult: number,
  str_asc_mult: number,
  def_asc_mult: number,
  dex_asc_mult: number,
  agi_asc_mult: number,
  cha_asc_mult: number,

  // Owned equipment
  upgrades: string[],        // equipment names
  augmentations: string[],   // augmentation names
}
```

**There is no `acc` or `acc_mult` field.** Accuracy is not a stat in Bitburner gang members.

### GangMemberAscension Fields (from `ascendMember()` / `getAscensionResult()`)

```typescript
{
  respect: number,   // Respect lost by ascending
  hack: number,      // New hack ascension multiplier
  str: number,       // New str ascension multiplier
  def: number,
  dex: number,
  agi: number,
  cha: number,
}
```

Use `getAscensionResult(name)` **before** ascending to check if it's worth it. Returns `undefined` if the member cannot be ascended.

### Correct Equipment Buying Pattern

```javascript
// Get all equipment names from the API — never hardcode names
const allEquip = ns.gang.getEquipmentNames()
  .sort((a, b) => ns.gang.getEquipmentCost(a) - ns.gang.getEquipmentCost(b));

for (const memberName of ns.gang.getMemberNames()) {
  const info = ns.gang.getMemberInformation(memberName);
  const owned = new Set([...info.upgrades, ...info.augmentations]);
  for (const eq of allEquip) {
    if (owned.has(eq)) continue;
    const cost = ns.gang.getEquipmentCost(eq);
    if (ns.getServerMoneyAvailable("home") >= cost) {
      ns.gang.purchaseEquipment(memberName, eq);
    }
  }
}
```

### Correct Win Rate Check

```javascript
const allGangs = ns.gang.getAllGangInformation();
const myFaction = ns.gang.getGangInformation().faction;

let minWinChance = 1;
let worstRival = "";
for (const [gangName] of Object.entries(allGangs)) {
  if (gangName === myFaction) continue;
  const chance = ns.gang.getChanceToWinClash(gangName);
  if (chance < minWinChance) {
    minWinChance = chance;
    worstRival = gangName;
  }
}
```

### Correct Ascension Check

```javascript
// Use descending thresholds based on current multiplier level
const ASCEND_THRESHOLDS = [1.60, 1.55, 1.50, 1.45, 1.40, 1.35, 1.30, 1.25, 1.20, 1.15, 1.10, 1.05];

function ascendThreshold(currentMult) {
  const tier = Math.min(ASCEND_THRESHOLDS.length - 1, Math.max(0, Math.floor(Math.log2(currentMult))));
  return ASCEND_THRESHOLDS[tier];
}

for (const name of ns.gang.getMemberNames()) {
  const result = ns.gang.getAscensionResult(name);
  if (!result) continue; // can't ascend yet

  const info = ns.gang.getMemberInformation(name);
  const isHacking = ns.gang.getGangInformation().isHacking;
  const pendingMult = isHacking ? result.hack : (result.str + result.def + result.dex + result.agi) / 4;
  const curMult = isHacking ? info.hack_asc_mult : (info.str_asc_mult + info.def_asc_mult + info.dex_asc_mult + info.agi_asc_mult) / 4;

  if (pendingMult >= ascendThreshold(curMult)) {
    ns.gang.ascendMember(name);
  }
}
```

---

## 12. Gang Member Stat Fields

### How Stats Are Calculated (from source)

```typescript
calculateSkill(exp, mult = 1) {
  return Math.max(Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)), 1);
}
```

Where `mult` combines equipment multiplier × ascension multiplier. Stats are logarithmic in XP — early XP matters more per unit, but multipliers from equipment and ascension amplify the base level.

### Training Graduation Threshold

A member should graduate from training to income/respect tasks when their relevant stats are strong enough to generate meaningful income. The `gang.js` script uses **avg stat ≥ 300** as the graduation threshold. This is a reasonable starting point.

For territory purposes, members with higher stats generate more power per update cycle. A member with avgStat 1000 contributes ~3× more power than one with avgStat 300.

---

## 13. Common Mistakes

| Mistake | Correct Approach |
|---------|-----------------|
| Using `gangInfo.money` | Use `ns.getServerMoneyAvailable("home")` |
| Using `gangInfo.rival_gangs` | Use `ns.gang.getAllGangInformation()` |
| Using `ns.gang.setArmed(true)` / `setHacking()` / `setCommerce()` | Use `ns.gang.setTerritoryWarfare(boolean)` |
| Hardcoding equipment names like `"Weapon"` or `"Armor"` | Use `ns.gang.getEquipmentNames()` and buy by exact name |
| Using `info.acc_mult` or `info.acc` | No accuracy stat exists; use `str_mult`, `def_mult`, etc. |
| Checking `ascendResult.acc_mult` | Ascension result fields are `hack`, `str`, `def`, `dex`, `agi`, `cha` |
| Ascending without checking result first | Always call `getAscensionResult(name)` first; it returns undefined if not possible |
| Buying non-aug equipment without locking members | Equipment in `upgrades[]` is wiped on ascension; only `augmentations[]` survive. Don't spend money on gear that will be immediately lost. |
| Buying equipment for all members at once during power build | Arms everyone simultaneously but nobody is ever "locked" long enough to keep their gear. Buy one member at a time, lock them, then move to the next. |
| Engaging clashes before all members are fully equipped | If clashes start while some members still need gear, those members stay locked in CLASH phase but receive no non-aug equipment — wasted opportunity. Arm everyone first. |
| Engaging clashes immediately at game start | All gangs start at equal power (1 each); build power first |
| Checking `gi.wantedLevel > 50` as a fixed penalty threshold | Use `gi.wantedPenalty < 0.95` instead — the threshold scales with respect |
| Assigning members via index (members[0], members[1]) | Sort by stat or use `canRecruitMember()` / named tracking |
| Infinite recruit loop without checking result | `recruitMember()` returns false when not enough respect; always check and break |

---

## 14. Gang Selection: Faction Differences & Augmentations

> Sourced directly from `bitburner-official/bitburner-src` dev branch:
> `src/Gang/Gang.ts`, `src/Gang/data/power.ts`, `src/Faction/FactionHelpers.tsx`,
> `src/Gang/data/upgrades.ts`, `src/Augmentation/Augmentations.ts`.

### Three Distinct Places to Buy Augmentations

These are completely separate systems and are easy to confuse:

| Where | What you're buying | Who benefits | List size |
|---|---|---|---|
| **Faction page** (no gang) | Player augmentations | Your character | Small — 5–14 per faction |
| **Faction page** (gang active) | Player augmentations | Your character | Nearly ALL augments in the game |
| **Gang equipment panel** | Gang member equipment | Gang members only | 31 items (10 are type Augmentation), same for every faction |

### Gang Type by Faction

The `isHacking` flag is set at gang creation and cannot be changed. It determines your entire task set, equipment strategy, and territory viability.

| Faction | Type |
|---|---|
| Slum Snakes | Combat |
| Tetrads | Combat |
| The Syndicate | Combat |
| The Dark Army | Combat |
| Speakers for the Dead | Combat |
| NiteSec | Hacking |
| The Black Hand | Hacking |

### NPC PowerMultiplier — Rivals Only

`src/Gang/data/power.ts` defines a per-faction `PowerMultiplier`. Confirmed in `Gang.ts`: **this multiplier applies only to NPC rival power gain, not the player's gang.** The player's power is always calculated via `calculatePower()` with no faction modifier.

Practical implication: if you pick **Speakers for the Dead** or **The Black Hand**, those same-named NPC rivals grow power 5× faster than a Slum Snakes NPC would — making them harder to displace during territory warfare.

| Faction | NPC PowerMultiplier |
|---|---|
| Slum Snakes | 1 |
| Tetrads | 2 |
| The Syndicate | 2 |
| The Dark Army | 2 |
| Speakers for the Dead | **5** |
| NiteSec | 2 |
| The Black Hand | **5** |

### How the Gang Augmentation List Works (source: `FactionHelpers.tsx`)

The function `getFactionAugmentationsFiltered` controls what you see on the faction page:

```
if player has an active gang with this faction:
  → return (almost) all augmentations in the game
  → exclude: special augmentations, Congruity Implant
  → BN2 only: also include The Red Pill
  → faction-unique augmentations (exclusive to one faction) are subject to RNG filtering:
      kept if: the aug belongs to THIS faction, OR rng() >= 1 - GangUniqueAugs
      GangUniqueAugs is a BitNode multiplier; at 1.0 all unique augs are always available

else (no gang, normal faction membership):
  → return only this faction's base augmentation list (the small list)
```

**This is why you see ~79 augments through a Slum Snakes gang** — the game is offering nearly the entire augment catalogue through the faction page, not Slum Snakes' base list of 5. The same happens with any gang faction.

The small faction-specific lists below are what you get **before** creating a gang (or in bitnodes where gangs are unavailable).

### Faction Base Augmentation Lists (pre-gang / no gang)

These are the augments available on the faction page when you have **not** yet created a gang. They're sourced from `Augmentations.ts` where each augment lists its associated factions.

#### Slum Snakes (Combat) — 5 augments
1. LuminCloaking-V1 — agility, charisma, crime money
2. LuminCloaking-V2 — agility, defense, charisma exp, crime money
3. SmartSonar — dexterity, dexterity exp, crime money *(exclusive to Slum Snakes)*
4. Targeting I — dexterity
5. Wired Reflexes — agility, dexterity

#### Tetrads (Combat) — 6 augments
1. Bionic Arms — strength, dexterity
2. Glib — charisma exp, company rep
3. HemoRecirculator — strength, defense, agility, dexterity, charisma
4. LuminCloaking-V1 — agility, charisma, crime money
5. LuminCloaking-V2 — agility, defense, charisma exp, crime money
6. Power Recirculator — all stats + all exp stats

#### The Syndicate (Combat) — 12 augments
1. ADR-V1 Pheromone Gene — company rep, faction rep, charisma exp
2. Bionic Legs — agility
3. Bionic Spine — strength, defense, agility, dexterity
4. BrachiBlades — strength, defense, crime success, crime money
5. Combat Rib I — strength, defense
6. Combat Rib II — strength, defense
7. Combat Rib III — strength, defense
8. HemoRecirculator — strength, defense, agility, dexterity, charisma
9. Nanofiber Weave — strength, defense, charisma
10. Power Recirculator — all stats + all exp stats
11. Shadow's Simulacrum — company rep, faction rep
12. Subdermal Armor — defense

#### The Dark Army (Combat) — 12 augments
1. Combat Rib I — strength, defense
2. Combat Rib II — strength, defense
3. Combat Rib III — strength, defense
4. Graphene Bionic Arms Upgrade — strength, dexterity *(Graphene tier)*
5. HemoRecirculator — strength, defense, agility, dexterity, charisma
6. Magnetism — charisma, company rep
7. Nanofiber Weave — strength, defense, charisma
8. Power Recirculator — all stats + all exp stats
9. Primer — charisma, charisma exp
10. Shadow's Simulacrum — company rep, faction rep
11. Targeting I — dexterity
12. Targeting II — dexterity

#### Speakers for the Dead (Combat) — 9 augments
1. Bionic Legs — agility
2. Bionic Spine — strength, defense, agility, dexterity
3. Eloquence — charisma, crime success, work money *(exclusive to Speakers)*
4. Golden Tongue Implant — charisma, charisma exp
5. Graphene BrachiBlades Upgrade — strength, defense, crime success, crime money *(Graphene tier, exclusive to Speakers)*
6. Nanofiber Weave — strength, defense, charisma
7. Shadow's Simulacrum — company rep, faction rep
8. Synthetic Heart — agility, strength, charisma
9. Synfibril Muscle — strength, defense

#### NiteSec (Hacking) — 10 augments
1. Artificial Synaptic Potentiation — hacking speed, hacking chance, hacking exp
2. BitWire — hacking
3. CRTX42-AA Gene Modification — hacking, hacking exp
4. Cranial Signal Processors G1 — hacking speed, hacking
5. Cranial Signal Processors G2 — hacking speed, hacking chance, hacking
6. Cranial Signal Processors G3 — hacking speed, hacking money, hacking
7. DataJack — hacking money
8. Neurotrainer II — all exp stats
9. Neuralstimulator — hacking speed, hacking chance, hacking exp
10. Neural-Retention Enhancement — hacking exp

#### The Black Hand (Hacking) — 7 augments
1. Artificial Synaptic Potentiation — hacking speed, hacking chance, hacking exp
2. Cranial Signal Processors G3 — hacking speed, hacking money, hacking
3. Cranial Signal Processors G4 — hacking speed, hacking money, hacking grow *(exclusive to The Black Hand)*
4. DataJack — hacking money
5. Magnetism — charisma, company rep
6. Neuralstimulator — hacking speed, hacking chance, hacking exp
7. The Black Hand — strength, dexterity, hacking, hacking speed, hacking money *(exclusive to The Black Hand)*

### Gang Member Equipment Augmentations (source: `data/upgrades.ts`)

Separate from player augmentations. These are bought for gang members from the Equipment panel. There are **31 total items** (weapons, armor, vehicles, rootkits, and augmentations), and the list is **identical regardless of which gang faction you chose**. The 10 items of type Augmentation are:

1. Bionic Arms — str_mult, dex_mult
2. Bionic Legs — agi_mult
3. Bionic Spine — str_mult, def_mult, dex_mult, agi_mult
4. BrachiBlades — str_mult, def_mult, crime_success_mult, crime_money_mult
5. Nanofiber Weave — str_mult, def_mult
6. Synthetic Heart — agi_mult, str_mult
7. Synfibril Muscle — str_mult, def_mult
8. BitWire — hack_mult
9. Neuralstimulator — hack_chance_mult, hack_speed_mult, hack_exp_mult
10. DataJack — hack_money_mult
11. Graphene Bone Lacings — str_mult, def_mult *(Graphene tier)*

### Which Faction Should You Pick?

Since the gang augmentation list (player augments via faction page) is almost identical regardless of which faction you pick, **the faction choice matters much less than it appears**. The practical considerations are:

**Join requirements** — the real differentiator early in a run:
- Slum Snakes: Karma ≤ −9 (easiest to qualify for)
- NiteSec: Hack ≥ 80, Karma ≤ −9
- Tetrads: Combat ≥ 75, Karma ≤ −18
- The Dark Army: Hack ≥ 300, Combat ≥ 300, Karma ≤ −45
- The Black Hand: Hack ≥ 100, Combat ≥ 100, Karma ≤ −45
- Speakers for the Dead: Hack ≥ 100, Combat ≥ 300, Karma ≤ −45
- The Syndicate: Hack ≥ 200, Combat ≥ 200, Karma ≤ −90

**Faction-exclusive augments** — visible in the gang list but subject to `GangUniqueAugs` RNG filtering in some bitnodes:
- SmartSonar: Slum Snakes only
- Eloquence + Graphene BrachiBlades: Speakers for the Dead only
- Cranial Signal Processors G4 + The Black Hand aug: The Black Hand only

**The Red Pill** — only available through a gang in BitNode 2.

**Bottom line:** Pick the faction whose join requirements you can hit earliest. The gang augment list is nearly the same across all factions once the gang is active. The gang type (hacking vs combat) matters far more than which specific faction you choose.
