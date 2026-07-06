# Implementation Plan: `station` — late-game controller (Roadmap 3.3)

Status: **planned, not started**. Written 2026-07-05 against Netscript v3.0.1.
Third controller in the lineage **booster → orbiter → station**. Read
`docs/scripts/orbiter.md` and `docs/devlog/02-booster.md` before implementing —
station is a fork of orbiter the same way orbiter was a fork of booster.

## Why a third controller

Booster/orbiter are designed for **RAM scarcity**: admission control decides which
few targets get slots, hack-fraction ramps up cautiously, capacity whipsaw is damped.
Late game inverts the problem: the cloud fleet is maxed (25 servers at max RAM) and
home is huge, so **targets, not RAM, are the bottleneck**. Orbiter in that regime
leaves most RAM idle in `share()` and still runs conservative admission logic that
no longer pays for its complexity.

Station's regime: batch **every viable target simultaneously at its own saturation
point**, then spend genuinely-surplus RAM on `share()` — plus optional stock
awareness.

## Trigger / handoff (mirrors the booster→orbiter handoff — reuse that code path)

Orbiter gains a `stationHandoffCheck()` (same shape as booster's Formulas check):

- Condition, evaluated once per tick, must hold for `STATION_HANDOFF_STABLE_TICKS`
  (e.g. 30) consecutive ticks to avoid flapping:
  1. pserver manager has exited with fleet maxed (read its status port 4 —
     pserver already publishes a done/maxed state; verify field name in
     `src/managers/pserver.js` before relying on it), **and**
  2. total pool RAM ≥ `STATION_MIN_POOL_GB` (suggest 500_000 GB ≈ half-maxed fleet;
     tune later), **and**
  3. aggregate batch RAM demand at max sustainable hack-fraction across all currently
     admitted targets < `STATION_DEMAND_FRAC` (0.5) of pool for the whole window —
     i.e. RAM is provably no longer the constraint.
- On handoff: orbiter execs `station.js` on home and exits, same as booster does for
  orbiter (copy that block; it already handles tail/dashboard transfer and flags).
- Fallback: if station detects the condition was wrong (demand > pool), it may exec
  orbiter back and exit. Guard with a flag + minimum dwell time
  (`STATION_MIN_DWELL_MS`, e.g. 10 min) to prevent ping-ponging.

## What station keeps from orbiter (fork, then modify)

Start from a copy of `orbiter.js`. Keep unchanged:

- Network discovery/rooting, `/data/servers.json` dump, startup zombie purge.
- Formulas-based planner core (prepped snapshot model, exact hack threads,
  `ORBITER_THREAD_MARGIN` on grow/weaken).
- Worker exec plumbing, landing telemetry (port 6), drift handling.
- Manager orchestration + `managersSeen` suppression (managers may already all have
  exited by this stage; the logic is harmless).
- Status publishing (port 2 — station replaces orbiter as "the controller", so it
  reuses `STATUS_PORT_CONTROLLER`; dashboard needs zero changes except the
  controller-name string in the snapshot).
- Share phase and share-on/off flag handling.

## What changes

### 1. Admission control → saturation allocation
Remove/bypass: slot-count admission (`MAX_BATCH_TARGETS`), fire-rate throttle
(`MAX_FIRES_PER_TICK` — raise to a station constant, e.g. 6), keep-bias, ramp
waterfall.

Replace with per-target saturation:
- For every prepped target, compute `fSat`: the highest hack fraction in the existing
  HACK_PCT table that keeps the target stable per the existing planner math
  (cap at `HACK_PCT_RAMP_MAX = 0.75`; the existing constant — do not exceed, the
  ramp-max exists for recovery-margin reasons documented in devlog 02).
- Depth: pipeline depth per target = `floor(weakenTime / BATCH_PERIOD)` as today;
  station admits **all** targets whose full-depth saturated pipeline fits in
  remaining pool, allocated in score order (same score function as orbiter).
- If pool runs out mid-list (early station phase), remaining targets get prep only.
  This degrades gracefully back to orbiter-like behavior without orbiter's machinery.

### 2. Prep everything
Orbiter preps lazily (only near-admission targets). Station preps **every rooted
server with money** opportunistically with leftover RAM, since more prepped targets
= more places to soak RAM. Priority: score order. Reuse the existing prep planner.

### 3. Share becomes the explicit remainder
After all saturated pipelines + preps are funded, 100% of remaining pool goes to
share (existing code path). Expect share to shrink over time as hack level raises
depths — that's correct behavior.

### 4. Optional stock awareness (build LAST, behind a constant)
`STATION_STOCK_AWARE = false` initially.
- If the stock manager (roadmap 3.2) exists and publishes held positions on its
  status port, station passes `stock: true` in hack/grow worker opts for symbols
  the player holds (grow while long, hack while short/none). Workers already take
  an opts object via args? — **verify**: current workers are minimal; adding
  `stock` requires threading one more arg through `hack.js`/`grow.js`
  (`ns.hack(target, { additionalMsec, stock })` — the opts object is already used
  for `additionalMsec`, so this is a small, RAM-free change).
- Do not implement until 3.2 exists. Keep the seam: a single function
  `stockFlagFor(target) -> bool` that returns false today.

### 5. w0r1d_d43m0n preparation
Station is the phase where `w0r1d_d43m0n` becomes relevant. Station does NOT
backdoor it (that ends the BitNode — lifecycle/player decision). It only:
- roots it when possible (existing rooting code covers this),
- reports in status: `wd: { rooted, hackLevelNeeded, hackLevelHave }`,
- **excludes it from batching/prep target lists** (add to an exclusion set with
  the existing no-money-server filter).

## Constants to add (`src/config/constants.js`)

```js
// --- station (late-game controller) ---
export const STATION_HANDOFF_STABLE_TICKS = 30;
export const STATION_MIN_POOL_GB = 500_000;
export const STATION_DEMAND_FRAC = 0.5;
export const STATION_MIN_DWELL_MS = 10 * 60_000;
export const STATION_MAX_FIRES_PER_TICK = 6;
export const STATION_STOCK_AWARE = false;
```

## Risks / things the implementer must not break

- **Do not remove the stabilization machinery blindly.** REANCHOR persistence,
  oscillation damping, and the empty-pipeline exemption (Stage 10 fixes) protect
  against dynamics that still exist at saturation. Bypass admission *selection*,
  keep plan locking and landing-order safety.
- The Stage-11 margin-at-admission issue disappears naturally under saturation
  allocation (everyone gets slots) — note this in the devlog when closing.
- RAM: station is a fork of orbiter (~8.35 GB); avoid adding NS calls. Stock opts
  add zero RAM (option bag on existing calls).
- Home-RAM check for dashboard auto-open is inherited; nothing to change.

## Implementation order (each step runnable/testable)

1. Copy orbiter.js → station.js; rename internals (snapshot `name: 'station'`);
   verify it runs identically to orbiter.
2. Add station constants; implement `stationHandoffCheck()` + exec/exit in orbiter
   behind `STATION_HANDOFF_ENABLED = true` constant (so it can be disabled if bad).
3. Replace admission with saturation allocation. Test on live save: expect target
   count to jump to "all preppable" and share RAM to drop.
4. Aggressive prep of all rooted money servers with leftover RAM.
5. w0r1d_d43m0n exclusion + status reporting.
6. Reverse-handoff guard (station→orbiter) with dwell time.
7. (Later, after roadmap 3.2) stock awareness behind `STATION_STOCK_AWARE`.

## Testing checklist

1. Step-1 parity run: station behaves byte-for-byte like orbiter for several minutes
   (compare status snapshots).
2. Handoff: with fleet maxed, orbiter hands off exactly once; kill station,
   restart orbiter, confirm handoff re-fires after stable-ticks (no flap).
3. Saturation: all viable targets show ATK in dashboard; OVERBUDGET debug line
   (existing) stays quiet; landing telemetry shows no new OFF-SLOT/W-CLAMP spikes.
4. Income comparison: measure $/sec over 30 min orbiter vs station at same state —
   station must not be worse.
5. Crash-reload: restart mid-run; startup purge + REANCHOR behave as in orbiter.

## Documentation deliverables

- `docs/scripts/station.md` via `/devlog` skill; devlog stage entry; update
  `docs/scripts/orbiter.md` (handoff section) and `docs/ROADMAP.md` 3.3.
