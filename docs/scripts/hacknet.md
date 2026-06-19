# hacknet

**Location:** `src/managers/hacknet.js`

## What it does

Buys hacknet nodes and upgrades (level / RAM / cores) as a passive income source. It
is an independent persistent loop, launched on `home` by `booster` — but only after
the pserver fleet is fully built (`booster`'s `HACKNET_GATE`: 25 servers each ≥ 32 TB).
Hacknet has weak ROI compared to purchased-server RAM, so it is deliberately the last
income/RAM investment `booster` starts.

## How it works

Each loop tick (`MANAGER_LOOP_SLEEP`, default 10 s):

1. **Find the single cheapest action** (`cheapestAction`) across: buying a new node
   (`getPurchaseNodeCost`, only while `numNodes() < maxNumNodes()`) and upgrading any
   existing node's level, RAM, or cores by one step
   (`getLevelUpgradeCost` / `getRamUpgradeCost` / `getCoreUpgradeCost`). Maxed-out
   options report `Infinity` cost and are never chosen; if everything is maxed,
   `cheapestAction` returns `null` and the tick is a no-op.
2. **Apply the buy test** (`shouldBuy`) — identical to the pserver manager:
   affordable **and** (pays back within `HACKNET_PAYBACK_SECONDS × income` **or**
   costs ≤ a *decaying* reinvestment fraction `effFrac` of current cash). `effFrac`
   falls from `HACKNET_REINVEST_FRAC` (0.25) toward `HACKNET_REINVEST_FLOOR` (0.01)
   as node count grows toward `HACKNET_BOOTSTRAP_NODES` (8) — the same
   bootstrap-then-defer-to-payback shape as pserver, keyed to nodes instead of RAM.
3. **Execute at most one purchase per tick** via the chosen action's `execute`
   closure (`purchaseNode` / `upgradeLevel` / `upgradeRam` / `upgradeCore`).

## Why it's built this way

**Same two-arm rule as pserver, for consistency.** "Buy the cheapest step if it
pays back within X seconds of income, or costs ≤ a reinvestment fraction of cash"
gives one predictable spending policy across both managers and one set of tunables
to reason about.

**Cheapest-action-first is sufficient here.** Because hacknet is gated until the
pserver fleet is fully built, by the time it runs the player has substantial cash and
income, so a simple "buy the cheapest available improvement" loop steadily builds the
network without needing precise per-upgrade production ROI. Computing exact
production gains (level/RAM/cores affect output differently) is a possible later
refinement, noted but not built in v1.

**One purchase per tick.** Keeps pacing legible and re-reads income/cash between
purchases, mirroring the pserver manager.

## Alternatives considered

- **Production-ROI ranking** (estimate each upgrade's $/s gain and buy the best
  payback): rejected for v1 — more code for little benefit given hacknet runs only
  once cash is plentiful. The cheapest-step rule approximates it well enough.
- **Spend-all whenever affordable:** rejected for the same reason as in the pserver
  manager — it ignores worth and starves other spending.
- **Launching hacknet early (idle until affordable):** rejected by the orchestration
  design — a gated launch keeps that RAM in `booster`'s hacking pool earning money
  until hacknet is genuinely wanted (see `docs/devlog/02-booster.md` "RAM
  interaction").
