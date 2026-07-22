# gang

**Location:** `src/managers/gang.js`

## What it does

Fully autonomous combat-gang manager: forms the gang (waiting out the karma
requirement if needed), recruits and trains members, ascends them, buys
equipment, runs the territory-warfare campaign to 100% territory, then settles
into income mode. Never-exit manager launched by booster/orbiter after
lifecycle; publishes a status snapshot on port 10 (`STATUS_PORT_GANG`).

## How it works

**Formation.** Until `inGang()`, it attempts `ns.gang.createGang("Slum Snakes")`
every 5 s — the call simply returns false until the player is in the faction
with enough karma, so no separate eligibility check is needed. Outside BN2 it
publishes `focusRequest: {action:'karma-homicide', etaMs}` (ETA from a measured
karma-rate EMA) so pilot's arbitration ladder row 2 can lend player time to the
karma grind; sleeves are the primary grinders and their karma lands on the
player total, so the measured rate already includes them.

**Running: RECRUIT → POWER → CLASH → DONE**, recomputed from live API state
every tick (`await ns.gang.nextUpdate()`, which resolves each gang update cycle,
~2 s at normal speed). Nothing load-bearing is in-memory-only, so restarts and
aug resets resume cleanly.

- **RECRUIT** (< 12 members): respect first, not money — power scales linearly
  with roster size, so unlocking all 12 slots is the biggest early lever. The
  oldest 1–2 earners (lowest `g<N>` index) run Terrorism (highest respect);
  everyone under the training threshold (avg combat stat 200) runs Train Combat.
  The respect slots use a **stable identity** (oldest members), not the
  live-strongest: Terrorism grants far less combat XP than training, so a
  rank-based pick would reshuffle the top set every tick and flap tasks between
  Terrorism and Train Combat — oldest ≈ strongest anyway. No equipment purchases
  yet. Recruits are named `g0`, `g1`, … into the lowest free index (death-safe;
  never named after an NS function — see the RAM-collision memory).
- **POWER** (full roster, clashes OFF): all ready members go on the *Territory
  Warfare task* with `setTerritoryWarfare(false)`. Gang power — and hence win
  chance — grows **only** from members assigned to that task; this phase is what
  makes the win chance climb at all.
- **CLASH**: entered when ALL of — min win chance over **all** rivals ≥ 0.55
  (safety floor; clashes hit every rival at once), win-chance growth over a
  3-minute rolling window < 0.5% (near the W_max ceiling — entering at bare 55%
  is ~6× slower to 100% territory), and every member is armed. Clashes ON,
  earners **stay** on Territory Warfare so power keeps growing while NPC power
  decays per lost clash. Income is ~0 here by design (the status snapshot
  carries the phase so pilot doesn't read the income collapse as a fault).
  CLASH is sticky: only the floor reverts it to POWER, and that revert clears
  the win-history window (stale CLASH samples read as falsely-flat growth) and
  the armed set.
- **DONE** (territory ≥ 0.99): warfare off. Rep→money gate: earners work
  Terrorism until the faction's reputation covers its highest augmentation
  requirement (faction rep accrues in proportion to respect; target computed
  once at startup from `getAugmentationsFromFaction`/`getAugmentationRepReq`,
  excluding NeuroFlux and owned augs), then switch to each member's best money
  task — scored per member as `baseMoney × (Σ taskWeight/100 × stat − 3.2 ×
  difficulty)`, the engine's income-formula shape with the task-independent
  multipliers dropped.

**Cross-phase mechanisms:**

- *Ascension — absolute-gain rule:* ascend when `(ratio − 1) × currentMult ≥
  0.70`, where ratio is `getAscensionResult()`'s new/old multiplier ratio
  averaged over the four combat stats. Ascension wipes non-aug gear and lowers
  respect, so it's coordinated with arming (below).
- *Sequential arming + ascension locks:* Augmentation-type equipment survives
  ascension → bought for anyone, any phase after RECRUIT, when money ≥ 5× cost.
  Wipeable gear (Weapon/Armor/Vehicle; Rootkits skipped — hack-only) is bought
  for ONE member at a time, strongest unequipped first, tracked in an `equipped`
  set. In POWER, armed members + the current target are ascension-locked;
  unarmed members ascend freely (nothing to lose). In CLASH only the target is
  locked; anyone else who ascends is dropped from the set and re-armed later.
- *Wanted penalty — count hysteresis:* an integer vigilante target goes +1 when
  `wantedPenalty < 0.95` and wanted is still rising, −1 when
  `wantedLevelGainRate ≤ 0`; that many of the weakest earners run Vigilante
  Justice.
- *Spending caps:* every purchase respects the shared per-tick `MECH_SPEND_FRAC`
  (0.25) cap, the per-purchase `GANG_EQUIP_BUDGET_FRAC` (0.1) cap, and
  lifecycle's `moneyFloor()` reserve.

**Status (port 10):** `{ts, phase, action, karmaNeeded, members, avgStats,
respect, wantedPenalty, income, territory, warfare, minWinChance, focus,
focusRequest}`. `income` multiplies `moneyGainRate` by 5 — the API reports gain
per 200 ms game cycle, not per second. `action` is a short phase label
(`RECRUIT · 7/12`, `POWER · win 62%`, `CLASH · win 78%`, `DONE · money`, or
`forming · karma … left`) shown as the dashboard row's header line.

**Launch gate** (in booster/orbiter's `MANAGERS` registry, after lifecycle):
SF2 owned or currently BN2, plus `pilotGate` (the rep gate needs singularity).
Checked via `getResetInfo()` only, so the controllers pay no gang-API RAM.

## Why it's built this way

- **Phase model over a single task policy:** the naive design (assign Territory
  Warfare only while warfare is enabled, enable at ≥ 55% win chance) deadlocks —
  win chance never rises without members on the TW task. Caught in plan review
  against `docs/reference/advanced/gang-guide.md`, which derives the phase model
  from game source.
- **Dynamic CLASH entry:** the guide's math shows territory gain is strongly
  superlinear in win chance; a fixed 55% entry is ~6× slower than entering when
  growth flattens near W_max. The floor stays as a safety bound only.
- **Absolute-gain ascension:** A/B-tested in the previous playthrough's gang
  script against a fixed-ratio threshold; ratio thresholds become unreachable at
  high multipliers (stalling ascension late) and over-fire at low ones.
- **Sequential arming:** resolves the equipment-vs-ascension tension (ascension
  wipes purchased gear) without freezing either: members ascend freely until
  it's their turn to be armed, then stay locked so the investment is kept.
- **Ideas from the old save, no code:** the previous playthrough's `gangSF4.js`
  independently converged on the same phase model and clash entry — its proven
  refinements (ascension rule, arming locks, vigilante hysteresis, rep→money
  gate, win-history reset on revert) were adopted as design, re-implemented
  fresh per project rules.
- **Static task names but scored money tasks:** task names are stable game data
  (hardcoding Terrorism/Train Combat/etc. costs nothing), but the best money
  task genuinely varies with member stats, so that one is scored per member
  from `getTaskStats`.

## Alternatives considered

- **Fixed 55% clash threshold** — rejected; see dynamic entry above.
- **Ratio-based ascension threshold (1.5×)** — rejected on the old save's A/B
  result.
- **Hacker gang** — rejected: combat gangs earn more, dominate territory (4 of
  6 power-formula stats trained), and don't compete with the controllers'
  hacking-skill focus. Recorded as a constant (`GANG_FACTION`) to override.
- **Skipping the rep→money gate to save ~8.5 GB of singularity RAM** — user
  chose to keep it; the gate makes every faction aug rep-affordable before
  switching to pure income.
- **Buying augs late** (the original plan draft) — inverted after review: augs
  are the only gear that *survives* ascension, so they're the safe early buy.
