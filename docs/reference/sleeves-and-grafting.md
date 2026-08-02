# Bitburner: Sleeves and Grafting — Mechanics Reference

Research compiled from official Bitburner docs, the Netscript API reference, and community scripts (r/bitburner, GitHub) to inform your own automation.

---

## Part 1: Sleeves

### Concept

A Sleeve is a duplicate synthetic body running a copy of your consciousness. It works tasks independently (crime, training, faction/company work, Bladeburner) while your main character does something else. Requires **Source-File 10** (unlocked by beating BitNode-10, "Digital Carbon") to use outside BN10.

You start with a small number of sleeves; more come from completing BN10 again, or buying up to 5 from **The Covenant** (BN10+ only), plus one more per SF10 level.

Key point: sleeves don't reset when you install augmentations on your main character. They only reset (stats to 0, augs kept) when you change BitNode.

### Per-sleeve state

| Stat | Range | Meaning |
|---|---|---|
| `shock` | 0–99 (100 initially) | Trauma from being placed in a new body. Reduces exp gain by `(100-shock)/100`. Must hit 0 before buying augs for that sleeve. |
| `sync` | 1–100 | Consciousness alignment. Sleeve's exp goes to main at `sync/100`, and to *other* sleeves at `(sync/100) * (otherSleeveShockBonus)` — **linear** in sync (verified in game source `Sleeve/Work/Work.ts applySleeveGains`; the earlier "quadratic" claim below was wrong). |
| `memory` | 1–100, persistent | Sets starting `sync` next BitNode. Only upgradable via The Covenant. Worth maxing late-game. |
| stats | strength/defense/dexterity/agility/hacking/charisma/intelligence | Reset to 0 whenever you purchase an aug for that sleeve. |
| `mult` object | — | Per-sleeve multipliers (crimeMoney, crimeSuccess, workMoney, factionRep, companyRep, stat/exp mults) from installed sleeve augs. |

Shock recovers slowly on its own; `setToShockRecovery()` speeds it up a lot. Sync only rises via `setToSynchronize()` and caps at 100 (further calls are wasted time).

### Netscript API — `ns.sleeve.*`

Query: `getNumSleeves()`, `getSleeve(i)`, `getTask(i)`, `getSleeveAugmentations(i)`, `getSleevePurchasableAugs(i)` (requires shock==0), `getSleeveAugmentationPrice(name)`, `getSleeveAugmentationRepReq(name)`, `getSleeveCost()`, `getMemoryUpgradeCost(i, amount)`.

Assign task (all return bool success): `setToIdle(i)`, `setToShockRecovery(i)`, `setToSynchronize(i)`, `setToCommitCrime(i, crimeType)`, `setToUniversityCourse(i, uni, course)`, `setToGymWorkout(i, gym, stat)`, `setToCompanyWork(i, companyName)`, `setToFactionWork(i, factionName, workType)`, `setToBladeburnerAction(i, action, contract?)`, `travel(i, city)`.

Purchase: `purchaseSleeve()`, `purchaseSleeveAug(i, augName)` (requires shock==0, resets stats), `upgradeMemory(i, amount)`.

Only one sleeve can work a given faction, and only one a given company, at a time — plan assignment so you don't double up.

### Typical automation priority order (from community scripts, e.g. alainbryden/bitburner-scripts `sleeve.js`)

1. **Sync** — if `sync < 100`, `setToSynchronize()`. Exponential payoff for multi-sleeve exp sharing, so this usually goes first.
2. **Shock recovery** — if `shock` above a threshold (commonly ~97%), `setToShockRecovery()`. Some scripts add a small random chance (~5%/tick) to recover periodically even below threshold, to keep the aug-purchase path open.
3. **Training** — gym for physical stats, university for hacking/charisma, up to target thresholds (e.g. Str/Def ≈105, Dex/Agi ≈70, Hack/Cha ≈25). Gym costs roughly $12k/sec per stat; scripts gate this on a cash reserve.
4. **Mirror the player** — sleeve 0 often set to work the same faction/company the player is currently working, doubling rep gain.
5. **Bladeburner** (if unlocked) — actions like Field Analysis, Infiltrate Synthoids, Diplomacy, or taking contracts.
6. **Crime** — fallback/default task. Start with low-requirement crimes (mug) and switch to homicide once success chance crosses a threshold (~45%), since homicide gives more karma/money.
7. **Buy sleeve augs** whenever shock==0 and reputation/cash allow, typically cheapest-first, often batched (e.g. wait until you can afford 20+ before purchasing) to reduce overhead. Note stats reset on purchase, so don't assume continuity right after.

Scripts usually re-evaluate assignment on a fixed loop tick (~1s to ~30–60s), with a minimum dwell time per task to avoid thrashing (reassigning too often wastes the ramp-up of a task).

### Gotchas

- Purchasing an aug resets that sleeve's stats to 0 (mults apply immediately, raw stats don't carry over).
- NeuroFlux Governor and some Bladeburner-only augs can't be bought for sleeves.
- Exp sharing to other sleeves is **linear** in sync (`sync/100`, times the receiving sleeve's own shock bonus) — verified in game source. Still worth keeping sync high, but the payoff scales linearly, not quadratically.
- One sleeve per faction/company at a time; assign carefully.
- Memory (persistent) vs sync (resets every BitNode) are easy to conflate — memory is the investment that matters across resets.

---

## Part 2: Grafting

### Concept

Grafting lets you acquire augmentation benefits by paying money directly and waiting, instead of grinding faction reputation and doing a full augmentation "install" (which normally means a full reset). It requires **Source-File 10** and is unlocked via BitNode-10. You do it in person at **VitaLife in New Tokyo**.

Trade-off: each graft inflicts **Entropy**, a permanent-for-the-run debuff stacking roughly ~2% per graft (multiplicative, e.g. `0.98^N`) against essentially all your multipliers. Entropy resets on BitNode reset. There's a specific augmentation, the **Violet Congruity Implant**, that removes Entropy — a common end-state goal once you've grafted a batch of augs.

Why use it: fast augmentation acquisition without a reset, useful when you have money but reputation is the bottleneck, or you want to stack a chunk of augs mid-run without losing progress.

### Netscript API — `ns.grafting.*`

- `getAugmentationGraftPrice(augName)` → money cost.
- `getAugmentationGraftTime(augName)` → base ms; actual time is affected by intelligence and focus, so don't hardcode sleeps off this — use `waitForOngoingGrafting()` instead.
- `getGraftableAugmentations()` → string[] of currently graftable augs. Does **not** filter by affordability or prerequisites — you must check those yourself.
- `graftAugmentation(augName, focus=true)` → bool. Must be in New Tokyo. Starting a new graft cancels any other in-progress work (including a prior graft) — cancelling loses the money and progress already spent.
- `waitForOngoingGrafting()` → Promise, resolves when current graft finishes (or immediately if idle; rejects if current work isn't grafting). Use this to sequence multiple grafts in a loop.

Grafting is inherently sequential — one augmentation at a time, unlike sleeves which run in parallel.

### Typical automation approach (from community scripts, e.g. jjclark1982/bitburner-scripts `graft.js`)

1. Get the graftable list, drop ones already owned, drop special-cased augs (Red Pill, NFG), filter to ones whose prerequisites you already have.
2. Score each candidate by expected value: estimate the multiplier benefit (per domain — hacking, combat, charisma, faction rep, etc.), discount it by the Entropy penalty compounding from the grafts done so far, and divide by `(graft time + buffer)` to rank value-per-time.
3. Only graft if net value > 1 (i.e., worth it after Entropy discount).
4. Loop: pick best-ranked affordable candidate → travel to New Tokyo if needed → `graftAugmentation()` → `waitForOngoingGrafting()` → re-check money/affordability/prerequisites (now possibly unlocked) → repeat.

### Gotchas

- Must be physically in New Tokyo to start a graft.
- Money is spent immediately on start; insufficient funds just makes `graftAugmentation()` return false (no exception).
- Cancelling a graft (e.g. starting another, or the player getting pulled into other work) loses money and progress — guard your loop against accidentally starting a second graft.
- Sleeves cannot graft — grafting is a main-character-only activity (sleeves can still have augs *purchased and installed* the normal sleeve way).
- Augmentation names must match exactly; pull them from `getGraftableAugmentations()` rather than hardcoding strings.
- Entropy compounds, so late grafts in a big batch return much less than early ones — this is why value/time ranking matters more as your graft count grows.

---

## Part 3: Suggested script shape

Given both mechanics are "poll state, assign next task" loops, a natural implementation:

**Sleeve manager** — single long-running script, loop every ~1–5s (or longer to save GetSleeve RAM calls):
- Read all sleeves' state once per tick.
- Apply the priority chain: sync → shock → train → mirror player's faction/company work → Bladeburner → crime.
- Separately, on a slower cadence (e.g. every 30–60s), check `getSleevePurchasableAugs` for any sleeve at shock==0 and buy in batches.

**Grafting manager** — can be a simpler one-shot or looped script since it's sequential:
- Build the candidate list, score by (value after entropy discount) / time.
- Loop: travel to New Tokyo → pick best affordable candidate → start graft → `await waitForOngoingGrafting()` → re-score → repeat until nothing left is worth grafting or affordable.
- Decide upfront whether you want it to stop once Entropy gets too high, or run until you can afford the Violet Congruity Implant to clear it.

These can be two independent scripts (they don't need to coordinate, except both consume money — worth reserving a cash floor for whichever else you're using money for, e.g. hacknet or normal augs).

---

## Sources

**Official docs / API**
- https://bitburner-fork-oddiz.readthedocs.io/en/stable/advancedgameplay/sleeves.html
- https://bitburner-fork-oddiz.readthedocs.io/en/stable/advancedgameplay/grafting.html
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.sleeve.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.getaugmentationgrafttime.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.getaugmentationgraftprice.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.graftaugmentation.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.getgraftableaugmentations.md
- https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.grafting.waitforongoinggrafting.md
- https://steamcommunity.com/games/1812820/announcements/detail/3126067963252852185 (grafting patch notes)

**Community scripts / discussion**
- https://github.com/alainbryden/bitburner-scripts/blob/main/sleeve.js
- https://deepwiki.com/alainbryden/bitburner-scripts/4.2-sleeve-management
- https://deepwiki.com/alainbryden/bitburner-scripts/4.1-faction-and-augmentation-management
- https://github.com/alainbryden/bitburner-scripts/issues/387 (grafting support discussion)
- https://raw.githubusercontent.com/jjclark1982/bitburner-scripts/main/augmentations/graft.js
- https://github.com/jjclark1982/bitburner-scripts/tree/main/augmentations
- https://steamcommunity.com/app/1812820/discussions/0/3193618786004324867/
