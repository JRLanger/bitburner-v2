# Implementation Plan: Faction-prereq pursuit + stat training (pilot)

Status: **IMPLEMENTED 2026-07-13** (same day as written; not yet RAM-measured in-game). Written 2026-07-13 against Netscript v3.0.1 defs.
Implementation order: **5th of the six-change batch** (before the grind-arbitration
change — this plan adds the grind rows that arbitration will weigh).

## Goal

Two gaps:
1. Pilot only joins factions whose invites *arrive on their own* (plus city-faction
   travel). Factions gated on stats, company rep, backdoors, money, or karma are
   never pursued — locking out their augs.
2. Nothing trains combat/charisma stats, which are needed for faction invites, for
   homicide success (gang/karma path, see docs/plans/gang.md), and for other
   mechanics later.

## API facts (verified in docs/reference/NetscriptDefinitions.d.ts — re-verify before coding)

- `ns.singularity.getFactionInviteRequirements(faction): PlayerRequirement[]`
  (L2333). `PlayerRequirement` is a discriminated union on `type` — enumerate the
  variants in the defs at implementation time; expected ones include `money`,
  `city`, `skills`, `backdoorInstalled`, `companyReputation`, `karma`,
  `numAugmentations`, `employedBy`, and compound `someCondition`/`everyCondition`.
- `ns.singularity.gymWorkout(gymName, stat, focus?)` (L1987) — already used by
  pilot's crime-training path.
- `ns.singularity.universityCourse(universityName, courseName, focus?)` (L1965) —
  charisma (leadership) and hacking (algorithms) training.
- `ns.getPlayer().skills` — current stat levels (already used).

## Part A — Prereq planner (no focus slot): extend `phaseFactions`

New helper `computeFactionPlans(ns, snap, owned)`:

1. **Target factions** = unjoined factions that offer ≥1 unowned PRIORITY aug
   (reuse the same `getAugmentationsFromFaction` + `PRIORITY_AUGS` scan phaseAugs
   does), skipping `PILOT_JOIN_BLOCKLIST` and rival-conflicting city factions
   (existing logic). Plus the chosen gang faction while the gang path is active.
2. For each target, classify each unmet entry of `getFactionInviteRequirements`:

| Requirement type | Handling |
|---|---|
| `money` | report-only (money accrues by itself) |
| `city` | feeds existing travel logic (`pursueCityFaction` generalizes to any city requirement) |
| `backdoorInstalled` | promote that host in `phaseBackdoors`' scan order |
| `skills` | emit a **training demand**: `{stat, target}` per lacking stat |
| `companyReputation` / `employedBy` | emit a **company-work demand** → ladder row 4 (stub today; this makes it real) |
| `karma`, `numAugmentations`, other | report-only (satisfied by gang path / resets) |
| `someCondition` / `everyCondition` | recurse; for `some`, pick the cheapest satisfiable branch (prefer non-focus ones) |

3. Publish `factionPlans` on port 7: `[{faction, unmet: [...], demands: [...]}]`
   for the dashboard, and keep the aggregated training/company demands in the
   snapshot for the ladder.

RAM note: `getFactionInviteRequirements` is one new singularity function on pilot.

## Part B — Training row: fill ladder row 5

New grind-class ladder row `stat-training`, positioned between `company-work` (4)
and `faction-work` (6) — the row-5 slot arbitration.md left as a grafting stub
moves grafting sharing the slot later; for now training takes row 5 (grafting has
no manager yet; when it lands, order within 4–6 is revisited in its plan).

- **Applicable when**: any training demand exists — from Part A (faction skill
  prereqs) or, later, from the gang plan (raise homicide chance; that demand is
  emitted by the karma row's own logic per gang.md, not duplicated here).
- **start()/maintain()**: pick the largest-deficit demanded stat:
  - str/def/dex/agi → `gymWorkout(GYM_LOCATION, stat, false)` (existing constant,
    Powerhouse Gym; reuse the crime path's city/travel handling),
  - charisma → `universityCourse` (leadership at the local university),
  - hacking (rare as an invite prereq) → `universityCourse` (algorithms).
  Re-evaluate each tick (mirrors `maintainCrime`'s pattern); classes never end on
  their own, so maintain() must hand off when the demand is met.
- **Exit**: demand met with buffer — train to `target × TRAIN_STAT_BUFFER` so a
  stat drained by an install-less mechanic doesn't flap the row.

Constants:

```js
export const TRAIN_STAT_BUFFER = 1.05;        // train 5% past the requirement
export const KARMA_HOMICIDE_MIN_CHANCE = 0.5; // gang path: train until Homicide clears this (used by gang plan's row 2)
```

- ETA for the arbitration change (next plan): `statGap / measured gain rate`
  (empirical Δstat/Δt while training, same pattern as pilot's rep-rate estimate).

## Testing checklist

1. Pick a stat-gated faction (e.g. a combat faction offering a priority aug);
   confirm `factionPlans` lists the unmet skills, the training row activates,
   trains the largest-deficit stat, and stops at target × buffer.
2. Confirm the invite arrives and phaseFactions joins (or pends) it once
   requirements are met.
3. Company-rep-gated faction: confirm a company-work demand is published (row 4
   servicing is its own follow-up — demand visibility is this plan's deliverable).
4. Backdoor-gated faction: confirm the host jumps the backdoor queue.
5. `mem` re-measure; update `PILOT_MANAGER_RAM`.

## Documentation deliverables

- Amend `docs/plans/pilot-singularity.md` (new planner + row) and
  `docs/plans/gang.md` (training-demand contract) — done alongside this plan.
- `/devlog` update for `docs/scripts/pilot.md` when implemented.
