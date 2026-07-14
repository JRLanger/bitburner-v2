# Implementation Plan: Arbitration layer — who gets focus, money, and RAM

Status: **planned, not started**. Written 2026-07-06 against Netscript v3.0.1 defs.
**Read this before implementing any mechanic manager** (gang, sleeves, bladeburner,
stocks, corporation, stanek). This document records the decision-making model for
the fully automated game; the per-mechanic plans assume it.

## The problem

Once every mechanic has a manager, three resources are contended:

| Resource | Contenders | Nature |
|---|---|---|
| **Player focus** (exclusive — one activity at a time) | faction work, company work, crime, Bladeburner actions, grafting | Only ONE script may drive it |
| **Money** (shared pool) | pserver, hacknet, pilot (programs/augs), gang equipment, sleeve augs/memory, stock capital, corp seed, lifecycle NF dump | Everyone spends from the same wallet |
| **RAM** | controller batches/prep/share vs. manager scripts on home | Mostly solved already |

## Decision 1 — Focus: pilot is the single broker

**Only `pilot.js` ever starts or stops player work.** No other script calls
`workForFaction`, `commitCrime`, `startAction`, `graftAugmentation`, etc. on the
player. This is the one hard rule; it eliminates all focus race conditions.

Exception mechanics that need player actions (Bladeburner, grafting) don't act
directly — pilot runs their action on their behalf when the ladder assigns focus
(see below). To keep pilot's RAM bounded, pilot calls at most the 1–2 cheapest
functions per mechanic (`bladeburner.startAction`, `grafting.graftAugmentation`);
the mechanic's own manager does all the thinking and publishes *what* it wants via
its status port field `focusRequest` (see protocol below).

### `choosePlayerActivity()` — the priority ladder

> **Amended 2026-07-13 — grind-class weighted-ETA selection.** Strict top-row-wins
> starves lower grinds (rep grinding would monopolize focus and gang formation
> would stall). Rows are now tagged `class: "gate" | "grind"`. **Gates** (row 1
> bootstrap, manual override, row 3 BN6/7 bladeburner) still preempt absolutely, in
> ladder order. Among applicable **grind** rows (2 karma, 4 company-work, 5
> stat-training, 6 faction-work, 8 crime-fallback), the winner is the lowest
> `effectiveEta = ETA / GRIND_WEIGHTS[row]` — each grind row exposes an ETA to its
> milestone (rep gap ÷ rep rate, karma gap ÷ karma rate, stat gap ÷ gain rate;
> crime-fallback = ∞ baseline). A grind whose RAW ETA exceeds
> `GRIND_ETA_SKIP_MS` (default 8 h) is skipped whenever another grind is
> applicable — a days-long rep grind yields to karma/training. Unknown ETA (no
> rate sample yet) is treated as `GRIND_ETA_SKIP_MS` (eligible, not favored).
> `FOCUS_STABLE_TICKS` hysteresis unchanged (damps ETA noise). See the Decision 4
> amendment: this is time-to-milestone comparison *within the grind class*, with
> hand-tunable ordinal-ish weights — still no cross-domain money-ROI score.
> New constants: `GRIND_WEIGHTS = { "karma-grind": 1.5, "company-work": 1.0,
> "stat-training": 1.0, "faction-work": 1.0, "crime-fallback": 0.5 }`,
> `GRIND_ETA_SKIP_MS = 8 * 3600_000`.

Runs each pilot tick, replacing the plan's original phase 5. Top-most applicable
wins. Manual override still applies: if the player started work themselves, pilot
never touches it (existing rule — pilot only replaces work it started).

| # | Activity | Applicable when | Rationale |
|---|---|---|---|
| 1 | **Bootstrap crime (Mug)** | home < 32 GB and no SF4-boot ran (early-run only) | Nothing else works without base RAM (devlog 01) |
| 2 | **Karma grind (Homicide)** | gang manager requests it (BN2/SF2, no gang, karma > −54000) **and** sleeves can't cover the remaining karma in `KARMA_PLAYER_ASSIST_HORIZON_MS` | Gang is the biggest income unlock in gang-capable BNs; sleeves grind karma in parallel and are preferred (they don't cost player time) |
| 3 | **Bladeburner action** | bladeburner manager's `focusRequest` set **and** current BN is 6/7 (Bladeburner is the win condition there) | In BN6/7 Bladeburner rank IS progression; outside 6/7 it ranks below faction work (row 6) |
| 4 | **Company work** | a needed faction (one holding a wanted aug) requires company rep for its invite, per `getFactionInviteRequirements` | Unblocks otherwise-unreachable augs (megacorp factions) |
| 5 | **Stat training** (added 2026-07-13, see docs/plans/faction-prereqs-training.md) / **Grafting** | a training demand exists (faction skill prereq, homicide-chance support) / grafting manager requests and no rep-locked aug reachable within `GRAFT_PATIENCE_MS` | Training unblocks invites & the gang path; grafting order within 4–6 revisited when its manager lands |
| 6 | **Faction work** | any rep-locked wanted aug exists (pilot's cheapest-gap heuristic, unchanged) | Default progression activity |
| 7 | **Bladeburner action (non-BN6/7)** | bladeburner manager requests and rows 1–6 idle | Passive rank/skill accumulation when nothing better |
| 8 | **Crime (Heist)** | nothing above applies and money < gang/pserver wish-list | Money fallback |
| 9 | **Idle** | — | Focus released |

Ladder position is data, not code: implement as an ordered array of
`{name, applicable(state), start(ns), stop(ns)}` entries so BitNode overrides
(docs/plans/bitnode-strategy.md) can reorder/disable rows via a constants table
`ARBITRATION_LADDER_OVERRIDES[bn]`.

### Focus protocol (flags + status ports)

- Pilot writes runtime flag `focusOwner` = ladder row name each time it (re)assigns.
- Mechanic managers publish `focusRequest: {action, args, urgency}` in their status
  snapshot; pilot reads status ports — no new channel needed.
- Anti-thrash: a new assignment must beat the current one for
  `FOCUS_STABLE_TICKS = 4` consecutive pilot ticks before switching (same
  hysteresis philosophy as REANCHOR/ramp-down in the controllers).
- `setFocus(false)` always (never steal the game window), per the pilot plan.

## Decision 2 — Money: budget classes + liquidation protocol

> **Amended 2026-07-13 — reservations (virtual wallet), see
> docs/plans/wallet-reservations.md.** `moneyFloor(ns)` is generalized to
> **frozen floor + live reservations**: a `reservations` map on the flag port
> (`{key: {amount, owner, reason, ts}}`, single writer per key, read-side TTL
> `RESERVATION_TTL_MS`). Pilot reserves the simulated cost of the acquirable aug
> batch (`augBatch`), so pserver/hacknet/donations/home-RAM can no longer spend
> money that would un-ready an aug — with zero changes to their buy paths, since
> they all already subtract `moneyFloor`. **No spender may raid a reservation**
> (user decision 2026-07-13); lifecycle clears `augBatch` at checklist step 0.
> Also note: home-RAM upgrading (docs/plans/home-ram.md) joins the Progression
> spend class (`HOME_RAM_SPEND_FRAC = 0.5`, gate not score) — it is a money
> spender, not a focus row.

Keep the existing decentralized pattern (each manager caps its own spending) — a
central ledger is over-engineering while money regenerates in seconds. But make the
caps *classed* and record the class table here so all managers agree:

| Class | Managers | Cap (fraction of current money per tick) | Notes |
|---|---|---|---|
| **Infrastructure** | pserver | ROI-driven (existing logic, unchanged) | Highest effective priority early — it compounds |
| **Progression** | pilot (programs, augs), grafting | `PILOT_SPEND_FRAC = 0.5` shared | Existing constant |
| **Mechanic capex** | gang equipment, sleeve augs/memory, bladeburner (none), hacknet | `MECH_SPEND_FRAC = 0.25` each | ROI- or effect-gated inside each manager |
| **Capital** | stocks | up to `STOCK_CAPITAL_FRAC = 0.8` of money **above** `STOCK_MONEY_FLOOR` | Not spending — parking. See liquidation below |
| **One-shot seeds** | corporation ($150b self-fund), stanek (free) | explicit constants, player-armed flags | Never automatic below the seed threshold |

Rules recorded as decisions:
1. Caps are per-tick fractions of *current* money, so priority emerges naturally:
   fast-ticking ROI spenders (pserver) drink first; slow spenders take what's left.
   No manager ever blocks another — worst case everything slows proportionally.
2. **`MONEY_RESERVE_FLOOR` flag** (runtime, via lib/flags): when set (by lifecycle
   pre-reset, or manually), ALL managers must skip purchases that would drop money
   below it. One-line check added to every manager's buy path:
   `if (money - cost < getFlag(ns,'moneyFloor',0)) skip`.
3. **Liquidation protocol** (needed because stock capital isn't in the wallet):
   lifecycle sets flag `liquidate: true` before its NF dump → stock manager sells
   all positions within one tick and publishes `liquidated: true` in status →
   lifecycle waits for that ack (timeout 30 s, then proceed anyway) → NF dump →
   install. Corp dividends need no liquidation (already cash).
4. **Net-worth reporting:** lifecycle and dashboard use
   `money + stockStatus.equity` for decision/display, so parked capital doesn't
   make the run look poor.

## Decision 3 — RAM: home budget for managers

Controllers own the batching pool (unchanged). All mechanic managers run on home.
Recorded budget: **combined mechanic-manager RAM ≤ 25% of home RAM**; the
controller's `launchManagers()` checks each candidate's `ns.getScriptRam` against
remaining budget and defers launch (log once) if it doesn't fit — gates stay true,
so it launches when home grows. Launch order = priority order:
`pserver, contracts, pilot, lifecycle, gang, sleeves, stocks, bladeburner, hacknet, corp, stanek`.

## Decision 4 — Cross-domain priority: ordinal per-BN, never a computed score

(Recorded 2026-07-06 after design discussion; supersedes any reading of this doc
as inviting a global ROI formula.)

The tempting design — one scalar "ROI" ranking augs vs. pservers vs. gang vs.
Bladeburner vs. rep — was tried by the player in earlier projects and failed, and
we believe it fails structurally: cross-domain "benefit" has no common unit, so
any conversion formula is hidden hand-tuned weights that break whenever BitNode
multipliers change. Instead:

1. **Money needs no ranking.** It regenerates in seconds; the spend-fraction
   caps (Decision 2) arbitrate proportionally, and aug purchases move to a
   single pre-reset batch (see below), removing the largest mid-run money
   competitor entirely.
2. **The focus slot is ranked ORDINALLY, per BitNode.** The ladder's order is a
   hardcoded, human-readable statement per BN (bitnode-strategy.md's
   ARBITRATION_LADDER_OVERRIDES) — "in BN7 Bladeburner beats faction work" —
   encoding BN-multiplier knowledge without pretending to compute it.
3. **Time-to-milestone is the scheduler WITHIN a row, never between rows.**
   Where units are comparable it works and is already in use: smallest
   rep-gap picks the faction (pilot row 6), karma-rate math decides whether
   sleeves need player help (gang plan), EV/sec picks the crime. Between rows
   the units aren't comparable — don't try.

   > **Amended 2026-07-13:** one sanctioned extension — among **grind-class**
   > ladder rows the unit IS comparable (time to each row's milestone), so the
   > weighted-ETA selection in Decision 1's amendment is allowed:
   > `effectiveEta = ETA / GRIND_WEIGHTS[row]`, plus the `GRIND_ETA_SKIP_MS`
   > skip rule. The weights are hand-tuned ordinal bias, not a computed
   > cross-domain score; money-ROI comparisons between domains remain forbidden.
4. **`getBitNodeMultipliers` (SF5) refines GATES, not rankings** — e.g. a ~0
   hacknet-money multiplier keeps the hacknet manager from launching. Binary
   decisions survive multiplier changes; weighted ones don't.

## Decision 5 — Augmentations: hardcoded priority, single pre-reset batch buy

> **Amended 2026-07-10:** the reset batch buys on a **cascade** matching pilot's
> grind order: **priority tier first**; the **rest (combat/social) tier is skipped
> while any priority aug is still rep-locked** (leftover → NeuroFlux dump, a NF level
> beating a combat aug while hacking augs are the goal), and **opens only once the
> priority tier is exhausted** (no priority aug rep-locked anywhere). Then
> priority → non-priority → NeuroFlux. **The Red Pill** is bought as soon as it's
> rep-met, and lifecycle installs ASAP to claim it (`redPillReady`).

Purchased augs are INERT until installed (verified in play — they take effect
only after the install/soft-reset). Therefore buying early is strictly worse
than buying at reset time: the ~1.9x per-purchase price ramp compounds against
every later purchase while the queued aug provides nothing. Consequences:

1. **Pilot's phaseAugs becomes report-only** — it publishes unlocked-but-unbought
   augs (and still buys ONLY prereq augs required to make a priority aug
   installable). No other mid-run aug purchases.
2. **Lifecycle gains a checklist step** (before the NeuroFlux dump): select the
   aug SET by walking `AUG_PRIORITY` (hardcoded ordered list in constants.js —
   inclusion priority, player-curated; augs absent from the list get a
   stats-derived tier via getAugmentationStats: hacking-multiplier augs > rep
   augs > rest) while simulating the price ramp against the budget; then
   PURCHASE the chosen set most-expensive-first (purchase order only affects
   total cost; descending is optimal). Then NF-dump the remainder.
3. **Lifecycle's stagnation signal is ACQUISITION progress, not purchases or bare
   rep-unlocks** — with batching, `lastAugPurchaseTs` never moves mid-run, and
   rep-unlock alone is wrong (a gang unlocks nearly every aug's rep at once, before
   the money to buy them is saved). Pilot reports `acquirableNow` (priority augs the
   reset batch could AFFORD now — rep met AND money saved, via a ~1.9× ramp
   simulation) and `lastAcquireTs` (when that count last grew, from rep OR money).
   Install when `acquirableNow >= LIFECYCLE_MIN_AUGS` and no growth for
   `LIFECYCLE_STAGNANT_MS` — the count plateaus only when progress on the binding
   constraint (money or rep, whichever is greater) stalls.

## Exceptions to the manager pattern (record once, apply everywhere)

The established pattern is gate → independent loop → status port → self-exit.
Deviations allowed, and the only ones:

1. **Never-exit managers:** gang, sleeves, bladeburner, stocks, corp run forever
   (their work never completes). Self-exit remains only for pserver/hacknet-style
   finite jobs.
2. **Focus brokerage:** mechanic managers needing player actions do NOT act —
   they publish `focusRequest` (Decision 1). This is the only manager→manager
   coupling besides ports.
3. **Liquidation flag:** stocks (and any future capital-parking manager) must
   honor `liquidate` (Decision 2.3).
4. **`nextUpdate()` ticking:** gang/bladeburner/stock APIs expose
   `await ns.gang.nextUpdate()` etc. Managers for those mechanics tick on
   `nextUpdate()` instead of fixed sleep — they react exactly when the game
   engine updates and consume zero extra cycles. (Cap with `Promise.race` against
   a 30 s sleep so a stalled promise can't freeze the loop.)
5. **BitNode gating:** every mechanic manager's gate consults
   `docs/plans/bitnode-strategy.md`'s enable-table (a constant
   `MECHANIC_ENABLE[bn]` in constants.js) — a mechanic that is pointless in the
   current BN never launches, even if its API is available.

## Port map (final — add to constants.js as each manager lands)

| Port | Owner |
|---|---|
| 1 | flags (existing) |
| 2 | controller: booster/orbiter/station (existing) |
| 3 | contracts (existing) |
| 4 | pserver (existing) |
| 5 | hacknet (existing) |
| 6 | worker telemetry (existing) |
| 7 | pilot |
| 8 | lifecycle |
| 9 | stocks |
| 10 | gang |
| 11 | sleeves |
| 12 | bladeburner |
| 13 | corporation |
| 14 | stanek + grafting |

Dashboard/tail: one row per active port, existing pattern; rows for silent ports
are hidden (staleness check on `ts` already exists — reuse it).

## Constants to add

```js
// --- arbitration ---
export const FOCUS_STABLE_TICKS = 4;
export const KARMA_PLAYER_ASSIST_HORIZON_MS = 2 * 3600_000;
export const GRAFT_PATIENCE_MS = 30 * 60_000;
export const MECH_SPEND_FRAC = 0.25;
export const MANAGER_HOME_RAM_FRAC = 0.25;
// MECHANIC_ENABLE + ARBITRATION_LADDER_OVERRIDES: see bitnode-strategy.md
```

## Build order & testing

Arbitration is not a script — it's (a) the ladder inside pilot, (b) conventions in
every manager. Build it as part of pilot (ladder skeleton with rows 1, 6, 8, 9 only
— the rows that work without any new managers), then each mechanic plan adds its
row + `focusRequest` when it lands. Test each addition by forcing its condition
(e.g. set ladder override to put it on top) and watching `focusOwner` in the
dashboard switch with hysteresis, then hand back when the condition clears.

## Documentation deliverables

When implemented: fold the ladder table and money classes into
`docs/scripts/pilot.md`, and devlog the arbitration design as its own stage entry.
