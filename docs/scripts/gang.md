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

- **RECRUIT** (< 12 members): respect first, not money — respect unlocks the next
  member slot, and roster size is the biggest early lever, so **every** productive
  member runs Terrorism (highest respect) to reach 12 as fast as possible. Only
  members under the training threshold (avg combat stat 200) run Train Combat —
  they can't overcome Terrorism's difficulty penalty yet, so they train up first.
  Because there's no top-N selection, there is nothing to flap (the earlier
  strongest-2 design churned the respect slots every tick — Terrorism grants little
  combat XP, so the live-strongest set reshuffled constantly). No equipment
  purchases yet. Recruits are named `g0`, `g1`, … into the lowest free index
  (death-safe; never named after an NS function — see the RAM-collision memory).
- **POWER** (full roster, clashes OFF): all ready members go on the *Territory
  Warfare task* with `setTerritoryWarfare(false)`. Gang power — and hence win
  chance — grows **only** from members assigned to that task; this phase is what
  makes the win chance climb at all.
- **CLASH**: entered as soon as the min win chance over **all** rivals (clashes
  hit every rival at once) reaches **0.75** (`GANG_CLASH_MIN_CHANCE`), and reverts
  to POWER if it drops back below (which also clears the armed set — rivals grew, so
  re-verify everyone's arming). **Clashes stay ON throughout.** What the earners *do*
  follows a win-chance hysteresis, because **gang power is a frozen accumulator** —
  it only grows from members on Territory Warfare and never decays:
  - Below `GANG_CLASH_REBUILD_CHANCE` (0.85): earners **build power** on Territory
    Warfare (as before).
  - At/above `GANG_CLASH_EARN_CHANCE` (0.90): earners come **off** Territory Warfare
    onto respect/money (same rep→money gate as DONE). Power stays frozen at its high
    value, so win chance holds (and drifts up as NPC power decays per lost clash)
    while territory keeps climbing — but now the gang actually **earns** instead of
    sitting at ~0 income. The 0.85–0.90 band prevents per-tick flapping.
  This trades a negligible amount of territory-push speed (above ~90% win chance the
  superlinear territory curve is nearly flat, so extra power barely helps) for full
  income during what can be a long climb to 100% territory.
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
- *Wanted penalty — count hysteresis, every phase:* the wanted penalty
  (`respect / (respect + wantedLevel)`) multiplies **both** money and respect, so it
  is managed in every phase, not just the earning ones. An integer vigilante target
  goes **+1** whenever `wantedPenalty < 0.95` and wanted **isn't already falling**
  (`wantedLevelGainRate ≥ 0` — the current count can't even reduce the accumulated
  wanted), ramping up until it drops; it goes **−1 only once the penalty recovers**
  above 0.95. That many of the weakest earners run Vigilante Justice. (Earlier logic
  released a vigilante as soon as wanted merely *stopped rising*, which could strand a
  catastrophic penalty — e.g. −99.99% — indefinitely while members did Territory
  Warfare.)
- *Spending caps:* every purchase respects the shared per-tick `MECH_SPEND_FRAC`
  (0.25) cap, the per-purchase `GANG_EQUIP_BUDGET_FRAC` (0.1) cap, and
  lifecycle's `moneyFloor()` reserve.

**Status (port 10):** `{ts, phase, action, karmaNeeded, members, avgStats,
respect, wantedPenalty, income, territory, warfare, minWinChance, focus,
focusRequest}`. `income` multiplies `moneyGainRate` by 5 — the API reports gain
per 200 ms game cycle, not per second. `action` is a short phase label
(`RECRUIT · 7/12`, `POWER · win 62%`, `CLASH · win 92% · money` / `· build`,
`DONE · money`, or `forming · karma … left`) shown as the dashboard row's header
line.

**Launch gate** (in booster/orbiter's `MANAGERS` registry, after lifecycle):
SF2 owned or currently BN2, plus `pilotGate` (the rep gate needs singularity).
Checked via `getResetInfo()` only, so the controllers pay no gang-API RAM.

## Why it's built this way

- **Phase model over a single task policy:** the naive design (assign Territory
  Warfare only while warfare is enabled, enable at ≥ 55% win chance) deadlocks —
  win chance never rises without members on the TW task. Caught in plan review
  against `docs/reference/advanced/gang-guide.md`, which derives the phase model
  from game source.
- **All recruits on Terrorism, Train Combat for the ramp:** respect unlocks member
  slots, so maximizing it across the whole roster (not reserving it to 1–2 earners)
  fills to 12 fastest. The sub-threshold ramp uses Train Combat, not Train Hacking,
  because Terrorism weights hack/str/def/dex/agi **equally** (~20% each) and respect
  gain uses that same weighted-stat sum — so Train Combat raises 4 of the 5
  respect-relevant stats at once (≈4× faster to productivity) and the combat stats
  double as territory power for POWER/CLASH, whereas hacking XP is largely wasted for
  a combat gang.
- **Fixed 0.75 CLASH threshold:** territory gain is strongly superlinear in win
  chance, so a bare-minimum entry (e.g. 55%) is much slower to 100% territory than
  waiting for a comfortable margin. A single, predictable 0.75 floor captures most
  of that benefit without the complexity (and observed non-engagement) of a dynamic
  growth-flattening + fully-armed gate, which could leave the gang parked in POWER
  at 90%+ win chance. Entering at 0.75 means the occasional lost clash, but arming
  continues during CLASH and lost clashes only cost slow NPC-power decay time.
- **Earn during CLASH once win chance is comfortable:** the guide calls "keep all
  earners on Territory Warfare throughout CLASH" optimal, but that's only optimal for
  *time-to-100%-territory* — it earns ~0 the whole climb. Because gang power is a
  frozen accumulator (never decays) and the territory curve is nearly flat above
  ~90% win chance, pulling earners off TW at ≥ 0.90 costs almost no territory speed
  while restoring full income; a 0.85 rebuild threshold is the safety net if win
  chance ever slips.
- **Wanted managed in every phase:** the penalty multiplies both money and respect,
  so a neglected wanted level silently throttles everything (a live game hit −99.99%).
  Vigilantes ramp up until wanted is actually *falling* and are only released once the
  penalty recovers — not the moment wanted stops rising, which previously stranded the
  penalty whenever members were on Territory Warfare (which adds little wanted).
- **Absolute-gain ascension:** A/B-tested in the previous playthrough's gang
  script against a fixed-ratio threshold; ratio thresholds become unreachable at
  high multipliers (stalling ascension late) and over-fire at low ones.
- **Sequential arming:** resolves the equipment-vs-ascension tension (ascension
  wipes purchased gear) without freezing either: members ascend freely until
  it's their turn to be armed, then stay locked so the investment is kept.
- **Ideas from the old save, no code:** the previous playthrough's `gangSF4.js`
  independently converged on the same phase model — its proven refinements
  (ascension rule, arming locks, vigilante hysteresis, rep→money gate) were
  adopted as design, re-implemented fresh per project rules.
- **Static task names but scored money tasks:** task names are stable game data
  (hardcoding Terrorism/Train Combat/etc. costs nothing), but the best money
  task genuinely varies with member stats, so that one is scored per member
  from `getTaskStats`.

## Alternatives considered

- **Dynamic CLASH entry** (enter when win-chance growth flattens near W_max *and*
  everyone is armed) — rejected: the armed gate left the gang parked in POWER at
  90%+ win chance in a live game, and the extra machinery (win-history window,
  growth measurement) wasn't worth it over a plain 0.75 threshold.
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
