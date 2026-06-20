# hacknet

**Location:** `src/managers/hacknet.js`

## What it does

Buys hacknet nodes and upgrades (level / RAM / cores) as a passive income source. It
is an independent persistent loop, launched on `home` by `booster` — but only after
the pserver fleet is fully built (`booster`'s `HACKNET_GATE`: 25 servers each ≥ 32 TB).
Hacknet has weak ROI compared to purchased-server RAM, so it is deliberately the last
income/RAM investment `booster` starts.

It buys on **return-on-investment over the expected run length** (the span between
augmentation installs), drains every worthwhile step each tick (not one), and **exits as
soon as nothing left is worth buying within that horizon**, returning its `home` RAM to
the worker pool.

## How it works

Each loop tick (`MANAGER_LOOP_SLEEP`, default 10 s):

The run horizon is computed **once at launch** (`computeHorizon`) and held fixed — it
doesn't change mid-run. Then each tick (`MANAGER_LOOP_SLEEP`, default 10 s):

1. **Enumerate every available action** (`enumerateActions`): buy a new node
   (`getPurchaseNodeCost`, while `numNodes() < maxNumNodes()`) and +1 level / RAM / core
   on each existing node (`getLevelUpgradeCost` / `getRamUpgradeCost` /
   `getCoreUpgradeCost`). Maxed options report `Infinity` cost and are dropped. Each
   action carries its **$ cost** and its **marginal production gain** ($/s).
2. **Drain the affordable, ROI-passing actions, best ROI first**, up to
   `MANAGER_MAX_BUYS_PER_TICK` (100). An action is bought if `cost ≤ cash` and its
   payback `cost / gain ≤ horizonSeconds`. Cash is decremented locally as it buys, so
   the loop stops when the wallet is drained or nothing affordable pays back in time.
3. **Exit when there's nothing more worth buying.** Two exit conditions, both freeing the
   RAM: `done` — every node/upgrade is maxed; `exhausted` — the *best-possible* action
   (lowest payback, even ignoring affordability) still can't pay back within the horizon,
   so more cash can never help. The horizon is fixed for the run, so there's no point
   looping. The only non-exit "waiting" state is when a worthwhile action exists but
   isn't affordable yet — there it keeps looping until cash arrives. `booster` relaunches
   the manager next run (after the next aug install) to rebuild from scratch.

### Marginal production gain (no Formulas.exe)

A node's production is `mult × factor(level, ram, cores)` where
`factor = level · HACKNET_RAM_MULT_BASE^(ram−1) · (cores+5)/6` and `mult` bundles the
constant per-player / per-BN multipliers. Because `mult` is constant, the gain of an
upgrade is `production × (factor(new)/factor(old) − 1)` — `mult` cancels, so no
Formulas.exe is needed, just `getNodeStats`. A new node's gain is `baseUnit`
(= an existing node's `production / factor`, since a fresh node has `factor(1,1,1)=1`);
the very first node, with no node to derive `baseUnit` from, is bought unconditionally.
Level gain is exact and formula-independent (production is linear in level); the one
empirical constant is `HACKNET_RAM_MULT_BASE` (≈ 1.035), which only affects RAM-upgrade
valuation and is validated in-game.

### Run (aug-reset) horizon

The "run" is the span between augmentation installs — an aug install is a soft reset that
keeps the same BitNode but **wipes hacknet nodes**, so each run is a fresh build-out. The
boundary timestamp is `getResetInfo().lastAugReset` (**not** `lastNodeReset`, which only
changes when you destroy/enter a BitNode — using it was a bug that left the horizon stuck
on "fresh" across aug installs).

`BN_DURATIONS_JSON` stores `{ augReset, durations[] }`. A run's full length is the gap
between two consecutive `lastAugReset` timestamps, so storing this run's `augReset` at
launch lets the *next* launch compute this run's full duration — exact **even though the
manager self-kills early**, because it's derived from the reset timestamps, not from how
long the manager stayed alive. The horizon is `HACKNET_FRESH_BN_HORIZON_SECONDS` (8 h)
until a duration is recorded, then the **most recent** run's duration (runs shorten as
the BitNode cycle progresses), floored at `HACKNET_MIN_HORIZON_SECONDS` so a freak short
run doesn't stall all spending. It is **fixed for the run** (computed once at launch).

## Why it's built this way

**ROI over the run horizon, not a fixed payback number.** A hacknet upgrade is only worth
buying if it earns back its price before the next aug install wipes the nodes. Tying the
payback window to the *actual* run length — long on a fresh run, automatically shorter on
the quick late-cycle runs — makes "is this worth it?" a real economic test instead of an
arbitrary constant, and it self-tunes from recorded run history. This replaces the
payback-seconds + reinvest-fraction arms the pserver manager uses; hacknet doesn't need
the reinvest bootstrap arm because a node's marginal production is nonzero from the first
node, so there's no income-is-zero chicken-and-egg.

**Best-ROI-first, drain per tick.** Hacknet has hundreds of tiny upgrades; buying one
per 10 s tick took hours. Buying every worthwhile step each tick (best payback first)
builds the network out in seconds. Cash is decremented locally so the loop self-limits;
the per-tick cap keeps the UI responsive.

**Exit as soon as nothing's worth buying.** The horizon is fixed for the run, so once the
best-possible upgrade can't pay back within it (or everything is maxed), waiting changes
nothing — the manager exits and frees its `home` RAM back to the worker pool rather than
looping forever. It only keeps waiting while a worthwhile upgrade exists but is
momentarily unaffordable. Suppression is in-memory in `booster` (it won't relaunch a
manager it saw exit, for the rest of that `booster` run); a fresh `booster` start — which
is what happens after an aug install — relaunches it to rebuild the wiped nodes.

## Alternatives considered

- **Fixed payback-seconds / reinvest-fraction (the pserver model):** the previous
  approach — rejected here because the right horizon for a passive, run-lifetime
  investment is the run's own length, which a fixed number can't track.
- **Subtracting elapsed time (a shrinking "remaining" horizon):** considered, rejected —
  the run horizon is held fixed so "worth it?" doesn't drift mid-run, and because the
  manager self-kills after its build-out, a shrinking horizon would have no one left to
  act on it anyway.
- **Continuously writing the live run elapsed every few seconds:** rejected — it can't
  capture the *full* run length once the manager self-kills, whereas the consecutive
  `lastAugReset` gap does so exactly and for free.
- **Formulas.exe `hacknetNodes.moneyGainRate` for exact gains:** unnecessary and
  unavailable pre-Formulas — the production-ratio method cancels the unknown multiplier
  and is exact for level/core gains.
- **One purchase per tick:** rejected — far too slow for hacknet's many small upgrades.
- **Average / median of BN history instead of the last duration:** rejected for now —
  the most recent run best reflects the player's current strength as runs shorten; a
  smoothed predictor is a possible later refinement.
- **Launching hacknet early (idle until affordable):** rejected by the orchestration
  design — a gated launch keeps that RAM in `booster`'s hacking pool earning money until
  hacknet is genuinely wanted (see `docs/devlog/02-booster.md` "RAM interaction").
