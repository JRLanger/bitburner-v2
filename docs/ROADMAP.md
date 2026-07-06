# Project Roadmap

Last updated: 2026-07-05 (post Stage 10, main branch stable).

This is the living plan for Bitburner-v2. It covers what exists today, what needs
fixing or polishing, what to build next, and where the project is ultimately headed.
Priorities: **P1** = do next, **P2** = soon, **P3** = when it becomes relevant.

---

## 1. Current state — what's built and working

The system is a **three-layer architecture**: controllers orchestrate HWGW batching,
managers run independent money/infrastructure loops, and a port-based status bus feeds
read-only UIs. ~6,500 lines of source across [src/](../src/).

### Controllers
- **[booster.js](../src/booster.js)** (~1,770 lines) — early-game controller: discovers
  and roots the network, ranks targets, preps them, runs HWGW batches with admission
  control and self-pacing, launches managers, feeds idle RAM to `ns.share()`, and
  hands off to orbiter when Formulas.exe appears. Stable through Stage 10.
- **[orbiter.js](../src/orbiter.js)** (~1,820 lines) — mid-game fork of booster using
  the Formulas API for exact thread math and drift-free plans. Verified live.

### Workers
- [hack.js](../src/workers/hack.js), [grow.js](../src/workers/grow.js),
  [weaken.js](../src/workers/weaken.js), [share.js](../src/workers/share.js) —
  minimal single-shot workers with landing telemetry (port 6) for drift diagnosis.

### Managers (launched by controller when their gate passes)
- **[pserver.js](../src/managers/pserver.js)** — buys/upgrades purchased servers
  (payback-horizon pacing + bootstrap reinvest arm); exits when fleet is maxed.
- **[contracts.js](../src/managers/contracts.js)** — finds and solves coding
  contracts; 30/30 solver types implemented.
- **[hacknet.js](../src/managers/hacknet.js)** — ROI-gated hacknet spending based on
  historical run-horizon; launches only after the pserver fleet is built.

### Infrastructure
- **Status bus** ([lib/status.js](../src/lib/status.js)) — port-based pub/sub
  (ports 2–5), zero RAM cost.
- **Flags** ([lib/flags.js](../src/lib/flags.js)) — runtime flags on port 1
  (manager suppression, share pause).
- **UI** — [dashboard.js](../src/dashboard.js) HTML overlay +
  [tail-ui.js](../src/lib/tail-ui.js) tail renderer, both pure readers with parity.
- **Config** — all tunables centralized in
  [config/constants.js](../src/config/constants.js) (0 GB import).
- **Utilities** — [backdoor-guide.js](../src/utils/backdoor-guide.js),
  share-on/off, [dev/validate-model.js](../src/dev/validate-model.js) calibration tool.
- **Tooling** — `sync.py` file mirror hardened in Stage 10 (WebSocket reassembly,
  log rotation, backpressure, ping-freeze fix).
- **Docs** — per-script docs in [docs/scripts/](scripts/), chronological devlog in
  [docs/devlog/](devlog/) (Stages 00–10 recorded).

**Bottom line:** the hacking-income core (discover → root → prep → batch → reinvest)
is complete, stable, and self-sustaining from a fresh reset through mid-game.

---

## 2. Short-term — bugs, gaps, and polish

### 2.1 Margin-at-admission optimization ("Stage 11 candidate") — P2
- **What:** at the RAM boundary, an admission slot can go to a bigger earner running
  at a throttled hack-fraction while a more RAM-efficient target sits idle. Known,
  modest, stable — deliberately deferred in Stage 10.
- **Why:** direct income efficiency; the only known suboptimality in the batching core.
- **Dependencies:** none. Uses existing landing telemetry for before/after measurement.

### 2.2 Turn off `CONTROLLER_DEBUG` by default — P1 (trivial)
- **What:** `CONTROLLER_DEBUG=true` is still armed in constants.js from the Stage 10
  hunt; debug logging costs I/O and was implicated in the 45 MB log crash.
- **Why:** Stage 10 is closed; debug should be opt-in again.
- **Dependencies:** none.

### 2.3 Orbiter grow-thread exactness — P3
- **What:** orbiter computes hack threads exactly via Formulas, but grow/weaken still
  carry `ORBITER_THREAD_MARGIN=1.025`; per-batch grow error can compound downward.
- **Why:** shaving the margin frees ~2.5% of batch RAM; low urgency since drift
  telemetry shows the system is stable.
- **Dependencies:** landing telemetry (done); best done alongside 2.1 tuning.

### 2.4 Docs catch-up — P2
- **What:** per-script docs exist for the majors, but `validate-model.js` and the
  workers have no docs/scripts/ entries, and the devlog has no entry summarizing the
  manager trio as a system. Also: this roadmap should be linked from README.
- **Why:** documentation-as-you-go is a stated project goal (CLAUDE.md).
- **Dependencies:** none.

---

## 3. Medium-term — next major systems

Ordered roughly by expected build order.

### 3.1 Singularity automation ("pilot") — P1
- **Plan:** [plans/pilot-singularity.md](plans/pilot-singularity.md)
- **What:** a new manager/controller that automates the manual loop: buying TOR and
  port openers, installing backdoors (replacing the manual backdoor-guide paste-in),
  joining factions, working for rep, buying augmentations, and eventually triggering
  the install-augs reset.
- **Why:** this is the biggest remaining source of manual play. Everything the
  controllers earn currently waits on the player to spend it on progression.
- **Priority:** P1 among new systems — it multiplies the value of all existing income.
- **Dependencies:** requires Source-File 4 (Singularity API) or BN4; API names must be
  verified against [NetscriptDefinitions.d.ts](reference/NetscriptDefinitions.d.ts)
  (v3 moved/renamed many functions — see the ns.cloud.* precedent). High RAM cost of
  Singularity calls will shape the design (likely a low-frequency, single-purpose
  script rather than merged into the controller).

### 3.2 Stock market manager — P2
- **Plan:** [plans/stocks.md](plans/stocks.md)
- **What:** a TIX-based trading manager (4S data when affordable; pre-4S heuristics
  optional). Fits the existing manager pattern: independent loop, gated launch,
  status port.
- **Why:** late-game stock income dwarfs hacking income; also synergizes with hacking
  (hack/grow influence stock movement).
- **Dependencies:** WSE + TIX API access (money gate); a new status port; dashboard
  and tail-ui rows.

### 3.3 "Station" — late-game controller (booster → orbiter → **station**) — P2
- **Plan:** [plans/station-lategame-controller.md](plans/station-lategame-controller.md)
- **What:** the third controller in the lineage, for the phase where RAM is effectively
  unlimited (maxed cloud fleet + large home): saturation batching across all viable
  targets, stock-aware toggling of hack/grow, and preparation of w0r1d_d43m0n.
- **Why:** orbiter's admission-control design is built around RAM scarcity; late game
  has the opposite problem (more RAM than targets can absorb) and share/rep becomes
  the marginal use of RAM.
- **Dependencies:** orbiter handoff pattern (proven), 3.2 if stock-aware batching is
  included, pserver fleet maxed.

### 3.4 Reset/BitNode lifecycle automation — P2
- **Plan:** [plans/reset-lifecycle.md](plans/reset-lifecycle.md)
- **What:** automate the aug-install reset loop end-to-end: decide when to install,
  run the post-reset checklist (currently the manual Stage 01 gym/mug grind —
  automate or eliminate via Singularity crime/study calls), relaunch booster.
  Extends the existing `bn-durations.json` horizon model.
- **Why:** turns the project from "automated session" into "automated progression."
- **Dependencies:** 3.1 (Singularity) is a hard prerequisite.

### 3.5 Arbitration layer + mechanic managers — P3 (fully planned 2026-07-06)
- **What:** an arbitration layer (player focus, money budget classes, home-RAM
  budget) plus one manager per mechanic. All planned in detail, build-ready:
  - [plans/arbitration.md](plans/arbitration.md) — the decision layer; **read first**
  - [plans/gang.md](plans/gang.md), [plans/sleeves.md](plans/sleeves.md),
    [plans/bladeburner.md](plans/bladeburner.md),
    [plans/corporation.md](plans/corporation.md),
    [plans/stanek-grafting.md](plans/stanek-grafting.md)
  - [plans/bitnode-strategy.md](plans/bitnode-strategy.md) — per-BN enable tables,
    playbooks, recommended BN order, and the **build order for all plans**
- **Why:** these dominate income/progression in their respective BitNodes; the
  arbitration layer is what lets them coexist without fighting over focus/money.
- **Dependencies:** pilot (3.1) first — it hosts the arbitration ladder. Managers
  gate dormant until their BitNode/Source-File unlocks.

---

## 4. Long-term — end-state vision

**A save that plays itself, and a codebase that explains itself.**

- **Full-loop autonomy:** from a fresh BitNode entry, the system roots, earns, joins
  factions, buys augs, resets, and eventually backdoors w0r1d_d43m0n to complete the
  BitNode — with the player only choosing which BitNode to enter next.
  (Composition of 3.1 + 3.3 + 3.4; the capstone item.)
- **BitNode-aware strategy:** controllers and managers read BitNode multipliers and
  adapt (e.g., skip hacknet where it's worthless, prioritize gang in BN2). Depends on
  Source-File 5 for `ns.getBitNodeMultipliers`.
- **Unified dashboard for everything:** every new manager gets a status port and a
  dashboard/tail row, preserving the "one glance shows the whole system" property.
- **Documentation completeness:** every script has a docs/scripts/ entry, every major
  decision a devlog stage. The docs remain the primary interface for future changes —
  this is as much a learning project as an automation project.

### Guiding principles (carry into everything above)
1. Verify every NS function against the v3 type defs before use; never trust memory
   of the old API.
2. Never name variables/properties after NS functions (RAM analyzer collision).
3. New long-running scripts follow the manager pattern: gate → independent loop →
   status port → self-exit; controllers never absorb manager logic.
4. 0-GB libraries and pure-constant config keep import costs at zero.
5. Document as you go: per-script doc + devlog stage for each system.
