# pserver

**Location:** `src/managers/pserver.js`

## What it does

Buys and upgrades purchased servers ("pservers") to grow the RAM pool that
`booster`'s HWGW batches run on. It is an independent persistent loop, launched on
`home` by `booster` (first in the manager dependency order — see
`docs/devlog/02-booster.md` "Manager orchestration"). Purchased servers are the
highest-compounding RAM investment, so this manager starts immediately.

It first fills the fleet to the game's purchased-server limit (default 25) at a small
starting RAM, then upgrades servers toward the max. Servers are named
`pserv-0`, `pserv-1`, … using `PSERVER_PREFIX`, so `booster`'s hacknet gate can count
the fleet straight from topology data.

## How it works

Each loop tick (`MANAGER_LOOP_SLEEP`, default 10 s — purchases are infrequent):

1. **Pick the cheapest next RAM step.** If the fleet isn't full, that's buying a new
   `PSERVER_START_RAM` server (`cheapestBuy`). Otherwise it's the existing server
   whose next doubling costs the least (`cheapestUpgrade`, via
   `ns.cloud.getServerUpgradeCost`), skipping any already at the cloud RAM limit
   (`ns.cloud.getRamLimit()`). Filling the fleet takes priority over upgrading,
   because until the fleet is full a fresh small server adds more pooled RAM per
   dollar than upgrading an existing one.
2. **Apply the buy test** (`shouldBuy`): execute the step only if it's affordable
   (`cost ≤ money`) **and** either it pays back within the income horizon
   (`cost ≤ income × PSERVER_PAYBACK_SECONDS`, income from
   `ns.getTotalScriptIncome()[0]`) **or** it costs ≤ a *decaying* reinvestment
   fraction of current cash (`cost ≤ money × effFrac`). `effFrac` falls from
   `PSERVER_REINVEST_FRAC` (0.25) toward `PSERVER_REINVEST_FLOOR` (0.01) as the
   fleet's total RAM grows toward `PSERVER_BOOTSTRAP_RAM_GB` (800 GB) — see below.
3. **Drain every affordable step this tick** — up to `MANAGER_MAX_BUYS_PER_TICK` (100),
   cheapest first, decrementing a local cash figure as it goes so the loop stops once
   the wallet is down to the self-scaling buffer. Buying many per tick (rather than one)
   lets the fleet fill out in seconds instead of one-purchase-per-10s; the per-tick cap
   keeps the UI responsive.
4. **Exit when the fleet is fully maxed.** When there's no step left (every server at the
   cloud RAM limit), the manager returns, freeing its `home` RAM back to the worker pool.
   `booster` won't relaunch it for the rest of that `booster` run (in-memory suppression),
   and rebuilds it next run — an aug install wipes purchased servers, so the fleet is
   rebuilt from scratch each run.

The manager owns *spending*; `booster` owns only *when to launch it*. `booster`
reserves this script's live RAM cost (`ns.getScriptRam`) on `home` before it
starts, so workers never fill `home` and block its `exec`.

## Why it's built this way

**Payback-horizon pacing instead of a flat cash fraction.** "Spend up to X seconds
of income" self-scales: the budget is tiny when income is tiny and grows as income
compounds — and since pservers *increase* income, there's a healthy positive
feedback loop. Crucially it also encodes *worth*, not just affordability: in a
BitNode where pserver costs balloon (the cost multiplier varies per BN), the next
step's price outruns `X × income` and purchases simply halt — the "upgrades stop
being worth it after a point" behavior, emergent rather than a hardcoded RAM cap.

**The reinvestment-fraction arm (and why payback alone fails on a fresh save).** On
a brand-new save income is ~0 *because* RAM is the bottleneck — so the payback arm
can never justify a purchase, a chicken-and-egg that leaves the fleet stuck. The
income-independent reinvest arm breaks it: buy the cheapest step whenever its cost ≤
`effFrac` of current cash. Each tick this spends cash down until `cost > effFrac ×
cash`, so the manager keeps a self-scaling buffer of ~`cost/effFrac` and reinvests
everything above it into RAM.

**`effFrac` decays as infrastructure is built, so it doesn't neuter the payback gate.**
A *permanent* 25% reinvest arm would quietly override payback forever: once you're
cash-rich but income-poor (normal mid-game), `money × 0.25` almost always covers the
cheapest step, so the "is this worth it?" payback check never binds. Since the
reinvest arm only exists for bootstrap, `effFrac` decays linearly from
`PSERVER_REINVEST_FRAC` (0.25, empty fleet) down to `PSERVER_REINVEST_FLOOR` (0.01)
as fleet RAM grows toward `PSERVER_BOOTSTRAP_RAM_GB` (25 × 32 = 800 GB):

```
progress = min(1, fleetRam / PSERVER_BOOTSTRAP_RAM_GB)
effFrac  = FLOOR + (FRAC - FLOOR) × (1 − progress)
```

So during bootstrap the reinvest arm pours cash into RAM; by the time the baseline
fleet (25 servers × 32 GB) is built it has handed control to payback, which then
governs upgrades by worth. The fraction never reaches 0 — the 1% floor is a
slow-trickle relief valve so a fleet stalled by payback still creeps forward on a
large cash pile (and keeps inching toward the hacknet gate). RAM (not an income
dollar-threshold) is the decay signal because it's BitNode-independent. The status
panel shows live `Bootstrap %` and `reinvest %` so the handoff is eyeball-able.

**Cheapest-step selection.** Each doubling adds RAM equal to the server's current
size, so the cheapest next doubling is also (within the fleet) the best $/GB. Buying
the single cheapest step each tick keeps every dollar near the efficient frontier
without explicit ROI math.

**Power-of-two RAM.** Purchased-server RAM must be a power of two, so
`PSERVER_START_RAM` is 8 GB and upgrades double the current size.

## Alternatives considered

- **Flat cash-fraction budget** (spend e.g. 25% of cash per tick): rejected — it
  doesn't encode worth, so it would keep over-paying for upgrades in expensive BNs
  instead of halting, and under-spends when cash is scarce but a step is cheap.
- **Spend-all on the cheapest step whenever affordable:** rejected — fastest pool
  growth, but it starves every other purchase (hacknet, programs) and ignores
  whether the upgrade is actually worth its price.
- **Explicit marginal-ROI math** (estimate income gain per GB and compare to cost):
  rejected for v1 — the payback horizon is a good proxy for the same thing with far
  less code and no Formulas dependency. A possible later refinement.
- **Gating hacknet on "pserver reports no affordable step"** rather than a fixed
  32 TB × 25 target: noted in the devlog as a future option; not built, since the
  reinvest arm already lets a fleet keep growing as cash accumulates.
