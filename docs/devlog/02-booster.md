# Devlog 02 — `booster`: The Early-Game Bootstrap Controller

**Date:** 2026-06-15
**Status:** Design (no code written yet)

## What it is

`booster` is the first controller that runs at the start of every BitNode
cycle (see `progression-cycles.md` and `01-bn-reset-checklist.md`), **before
Formulas.exe is available**. It is the cheap "first stage" of the controller
lineage — it gets hacking income off the ground, then is jettisoned and
replaced by a more capable, Formulas-based controller once Formulas.exe is
detected.

Naming theme (rocket staging): **booster** (early) → orbiter (mid) →
station (late), reflecting the "powerful first stage, discarded once you're
moving" lifecycle.

## Responsibilities

1. **Discover, root, and provision the network** — BFS from `home` via
   `scan`, open ports with whatever crack programs are owned, `nuke`, and
   `scp` the three worker scripts to each newly-rooted server. This logic is
   **integrated into the controller** (not a separate script) to save the
   1.6 GB base cost of a second script.
2. **Maintain a topology JSON** (`/data/servers.json`, free `ns.write`) of
   static/topology data for other managers to consume without re-scanning.
3. **Rank targets** by profitability using a per-target hack-percentage
   table (see "Targeting model" below).
4. **Run a rolling HWGW batch** against the best targets, with thread counts
   computed from plain NS getters and hardcoded security constants — no
   Formulas.exe.
5. **Prep weak/poor targets** (security → minimum, money → maximum) before
   they become batch-eligible, since pre-Formulas thread math is only
   accurate at baseline.
6. **Auto-launch managers** (pserver buyer/upgrader, hacknet buyer/upgrader,
   contracts solver, later gang/bladeburner) on `home` in a fixed dependency
   order, once each is affordable and its prerequisites are met.
7. **Display a live status table** (tail window, free `ns.ui`/`ns.print`).
8. **Detect Formulas.exe** (`fileExists`) and hand off to the advanced
   controller.

## Prerequisites (checked at startup)

Three worker scripts must already exist on `home`: a hack worker, a grow
worker, and a weaken worker. If any is missing, `booster` prints an error to
the terminal and exits immediately — it does **not** create them. (Workers
planned separately.)

Also assumes the manual BN-reset grind (see `01-bn-reset-checklist.md`) has
been done to bring home RAM to ~32GB.

## RAM budget — 8.20 GB

Deliberately kept low so `booster` runs usefully on a small early home
server. Total is dominated by the three 1 GB analysis functions; everything
else is cheap getters.

| Function | RAM | Purpose |
|----------|-----|---------|
| Base | 1.60 | every script |
| `exec` | 1.30 | launch workers, managers |
| `ps` | 0.20 | thread accounting per host |
| `getServerMoneyAvailable` | 0.10 | real-time money |
| `getServerSecurityLevel` | 0.10 | real-time security |
| `getServerUsedRam` | 0.05 | free RAM per host |
| `getServerMaxRam` | 0.05 | capacity (home grows when upgraded) |
| `getWeakenTime` | 0.05 | batch timing |
| `getGrowTime` | 0.05 | batch timing |
| `getHackTime` | 0.05 | batch timing |
| `hackAnalyze` | 1.00 | money fraction per hack thread |
| `growthAnalyze` | 1.00 | grow threads for a target multiplier |
| `hackAnalyzeChance` | 1.00 | success chance (ranking + filtering) |
| `fileExists` | 0.10 | detect Formulas.exe |
| `scan` | 0.20 | topology BFS |
| `hasRootAccess` | 0.05 | root status |
| `getServerNumPortsRequired` | 0.10 | nuke requirement |
| `getServerRequiredHackingLevel` | 0.10 | viability |
| `getServerMaxMoney` | 0.10 | target value |
| `getServerMinSecurityLevel` | 0.10 | weaken floor |
| `brutessh`/`ftpcrack`/`relaysmtp`/`httpworm`/`sqlinject` | 0.25 | port openers |
| `nuke` | 0.05 | root |
| `scp` | 0.60 | provision workers to rooted servers |
| **Total** | **8.20 GB** | |

Free (0 GB): `ns.read`/`ns.write` (topology JSON), `ns.ui.*`/`ns.print`
(status table).

### Hardcoded constants (avoid 3 GB of analysis functions)

Security deltas are fixed single-core constants, so we hardcode them instead
of calling `weakenAnalyze` / `growthAnalyzeSecurity` / `hackAnalyzeSecurity`
(1 GB each = 3 GB saved):

- weaken: **−0.05** security per thread
- grow: **+0.004** security per thread
- hack: **+0.002** security per thread

## Targeting model

### Optimal hack % varies per server

Diminishing returns come from the **grow** side: restoring fraction `f` needs
a grow multiplier of `1/(1-f)`, whose thread cost scales like
`ln(1/(1-f))` — superlinear — while money gained is linear in `f`. So a peak
RAM-efficiency `f` exists. Its location depends on two server-specific
quantities: `hackAnalyze` (fraction stolen per hack thread) and the server's
growth rate (what `growthAnalyze` encodes). High-growth servers peak at a
higher `f`; low-growth/high-money servers peak lower. **It is not a universal
constant** — but we never have to guess it, because the formula below finds
each server's peak from free arithmetic.

### Per-target thread table (1%–99%)

For each prepped target, precompute a table over `f = 0.01 … 0.99` (1% steps):

```
h(f)  = ceil(f / hackAnalyze(target))                 // hack threads
g(f)  = ceil(growthAnalyze(target, 1 / (1 - f)))      // grow threads
w1(f) = ceil(h(f) * 0.002 / 0.05)                     // weaken for hack sec
w2(f) = ceil(g(f) * 0.004 / 0.05)                     // weaken for grow sec
ramPerBatch(f) = h*hackRAM + g*growRAM + (w1+w2)*weakenRAM
moneyPerCycle(f) = maxMoney * f * hackAnalyzeChance(target)
score(f) = moneyPerCycle(f) / (weakenTime(target) * ramPerBatch(f))
```

The table is built from free calls (`hackAnalyze`/`growthAnalyze`/
`hackAnalyzeChance` are already in the RAM budget). Rebuild only when the
player's **hacking level** changes (the only thing that shifts the curve for
an already-prepped target), not every tick.

Metric is **$ per GB per second**, because RAM — not time — is the scarce
resource (many batches pipeline within one `weakenTime`).

### Allocation (per controller tick)

1. Filter candidates: `hasRoot`, `maxMoney > 0`,
   `hackAnalyzeChance ≥ CHANCE_FILTER`.
2. Split into **prepped** (security ≤ minSecurity × (1 + `SEC_MARGIN`) and
   money ≥ maxMoney × (1 − `MONEY_EPSILON`)) and **needs-prep**.
3. Rank prepped targets by their table's best `score` (the optimal %).
4. Greedily allocate RAM down the ranked list, each target at its **optimal
   %** (pipelined — see caveat), spending leftover RAM on the next-best
   target rather than under-running the best one.
5. Only the marginal target at the bottom of the pool uses the **step-down
   fallback**: if its optimal-% pipeline doesn't fit, walk the table down to
   the highest % that fits (floor 1%); skip if even 1% doesn't fit.
6. Any still-leftover RAM → prep the next-best needs-prep target (weaken to
   min, then grow to max).

So "lower the hack %" is a last-resort squeeze for one marginal target, not
the primary mechanism — most targets run at their true optimum.

### Critical caveat: pipeline RAM, not single-batch RAM

A rolling HWGW runs `weakenTime / batchSpacing` batches concurrently. The RAM
a target consumes at steady state is `ramPerBatch × concurrentBatches`. The
"fits the pool" checks above must compare the **pipeline** cost, not one
batch, or we'll badly over-commit. This is the central constraint for the
(still to be designed) batch scheduler.

## Tunable constants (to calibrate empirically)

| Constant | Suggested start | Meaning |
|----------|-----------------|---------|
| `CHANCE_FILTER` | 0.5 | min `hackAnalyzeChance` to consider a target |
| `CHANCE_BATCH` | 0.8 | min chance before a prepped target is batch-eligible |
| `SEC_MARGIN` | 0.05 | "prepped" if security ≤ minSecurity × (1 + this), i.e. within 5% above minimum |
| `MONEY_EPSILON` | 0.01 | "prepped" if money within 1% of max |
| grid step | 0.01 | hack-% table resolution |
| `D_GAP` | 200 ms | gap between consecutive HWGW landings (to tune in-game later) |
| `BATCH_PERIOD` | `4 × D_GAP` (800 ms) | interval between batch launches into the pipeline |
| `HOME_RESERVE` | (TBD) | RAM kept free on `home` for `booster` (8.2 GB) + managers |

## Validation plan

Before trusting the model, the standalone tool `src/validate-model.js`
measures **predicted vs. actual** money and security per operation and logs to
`/data/validation-log.txt`. Each op auto-establishes its precondition (prep /
drain / raise-security) so no manual setup is needed.

### Validation results (2026-06-15, target `phantasy`, T=100, game v3.0.0)

| Model claim | Measured ratio | Verdict |
|-------------|----------------|---------|
| hack stolen = `money × hackAnalyze × T` | 1.0000 | ✅ exact |
| hack security = `0.002 × T` | 1.0000 | ✅ exact |
| grow security = `0.004 × T` | 1.0000 | ✅ exact |
| weaken security = `0.05 × T` | 1.0000 | ✅ exact |
| `growthAnalyze` thread count | 1.0400 | ⚠️ overestimates ~4% |

**Two engine behaviors confirmed — both matter for `booster`:**

1. **`growthAnalyze` overestimates grow threads by ~4%.** It errs in the
   *safe* direction: `booster` will provision slightly too many grow threads,
   so money always fully recovers (minor RAM waste, never an under-grow). No
   correction applied in v1 — we accept the ~4% over-provision as a safety
   margin. Revisit only if RAM pressure makes the waste matter.

2. **Grow's security increase is proportional to money actually grown** (game
   v2.3.0+ behavior). Growing a server already at max money adds ~0 security.
   This does **not** affect normal HWGW batching (grow there always runs on a
   hacked-down server and does real growth → full `0.004 × T`), but it means
   any code that assumes "grow always adds `0.004 × T`" is wrong when the
   server is at/near max money. (This is why the validation tool raises
   security via hack, not grow.)

## Worker scripts

Three single-shot workers live in `src/workers/` (in-game `/workers/hack.js`,
`/workers/grow.js`, `/workers/weaken.js`). `booster`'s startup prerequisite
check looks for these three paths and exits with a terminal error if any is
missing.

**Arg contract (all three identical):**

| Arg | Meaning |
|-----|---------|
| `[0] target` | hostname to act on |
| `[1] delay` | additional ms the **engine** waits before the op lands, passed as `{ additionalMsec: delay }`. Aligns batch landing order. |
| `[2] batchId` | throwaway disambiguator so otherwise-identical concurrent workers are distinguishable to `ps`/`kill`. Not read by the worker. |

**RAM (load-bearing — every batch's cost is built from these):**

| Worker | RAM | = base + op |
|--------|-----|-------------|
| `hack.js` | 1.70 GB | 1.60 + 0.10 |
| `grow.js` | 1.75 GB | 1.60 + 0.15 |
| `weaken.js` | 1.75 GB | 1.60 + 0.15 |

Workers are kept deliberately minimal — **no logging, no port writes** — because
any extra NS call raises the per-thread cost and bloats every batch. The
`additionalMsec` delay and arg parsing are free.

**Why `additionalMsec` instead of `ns.sleep`:** the engine handles the wait
internally, landing the op far more precisely than a JS `sleep` (which is
subject to event-loop jitter — exactly what desyncs batches). Side effect: a
worker's total runtime is `opTime + delay`, which the scheduler accounts for
when reasoning about when a worker frees its RAM.

**Why single-shot:** a worker does exactly one op and exits, so RAM is freed
the moment its operation lands. This is what makes precise pipelined batch
timing possible (vs. a persistent looping worker that holds RAM indefinitely).

## HWGW scheduler

### Timing model

Times come from `getHackTime` / `getGrowTime` / `getWeakenTime` per target
(in budget, 0.05 GB each; recomputed each tick so they track hacking-level
changes). The four ops of a batch are launched **simultaneously** but given
different `additionalMsec` delays so they **land** in staggered order, `D_GAP`
apart, with W1 landing at the natural `weakenTime`:

```
op   lands at            additionalMsec (= landTime − opTime)
H    weakenTime − D      (weakenTime − D)   − hackTime
W1   weakenTime          0
G    weakenTime + D      (weakenTime + D)   − growTime
W2   weakenTime + 2D     2D
```

All delays are non-negative because `weakenTime ≫ hackTime` and
`weakenTime > growTime`. Landing order H→W1→G→W2 means: hack steals, W1 repairs
hack's security, grow restores money, W2 repairs grow's security — leaving the
target back at baseline (min security, max money) after each batch.

### Pipelining

A new batch is launched every `BATCH_PERIOD = 4 × D_GAP`, so at steady state
landings form a continuous stream spaced `D_GAP` apart
(…H W1 G W2 H W1 G W2…). The number of batches in flight for a target is:

```
concurrentBatches = ceil(weakenTime / BATCH_PERIOD)
pipelineRAM(target) = concurrentBatches × ramPerBatch(chosen f)
```

**This `pipelineRAM` — not a single batch — is what allocation checks against
the RAM pool.** (The earlier "pipeline RAM, not single-batch RAM" caveat.)

`booster`'s main loop wakes roughly every `BATCH_PERIOD`; on each wake it
launches the next batch for each active target whose pipeline has a free slot
and whose `pipelineRAM` still fits. Launch-time jitter only shifts which
`BATCH_PERIOD` window a batch starts in — landing precision is handled by
`additionalMsec`, so coarse loop timing is fine.

### Thread splitting across servers

Early servers are too small to hold a whole batch, so each op's threads are
spread across the RAM pool (`home` + rooted servers, minus `HOME_RESERVE`):

- **Weaken and grow** split freely — their effect is additive across threads
  and across separate `exec` calls.
- **Hack also splits** — total stolen = `threads × per-thread fraction`,
  additive across `exec` calls **provided every hack split shares the same
  `additionalMsec`** so they all act on the same money snapshot. They must land
  together.
- Each split `exec` is a distinct worker instance, so `batchId` must be unique
  per instance (e.g. `${batchSeq}-${op}-${hostIndex}`) for clean `ps`/`kill`
  accounting.

### Desync self-heal

Pre-Formulas timing isn't perfect, so batches will occasionally land out of
order and leave a target off-baseline. Each tick, for every batching target:

1. If money < `maxMoney × (1 − MONEY_EPSILON)` or security >
   `minSecurity × (1 + SEC_MARGIN)`, the target has **drifted**.
2. Stop launching new batches for it; let in-flight batches drain.
3. Fire prep (weaken to min, then grow to max) until it's back at baseline.
4. Resume batching.

Simpler and more robust than trying to make timing perfect.

### Leftover RAM → prep the pipeline

Any RAM not consumed by active batch pipelines goes to prepping the next-best
unprepped target (weaken/grow), so a queue of future good targets is always
being readied. "Lower the hack %" step-down (see Allocation) applies only to
the single marginal target at the bottom of the RAM pool.

## Alternatives considered

- **Separate scanner script** (own file, exec'd on a timer): rejected for the
  integrated approach to save the 1.6 GB base cost of a second script. The
  topology JSON it would have produced is still written, just by `booster`.
- **`getServer` per host** (2 GB) instead of individual getters (~1.1 GB for
  the same fields): rejected — individual getters are cheaper and we only
  need a subset of fields.
- **Calling the security-analysis functions** (`weakenAnalyze` etc.,
  3 GB total): rejected in favor of hardcoded constants.
- **Single optimal `f` via ternary search** instead of a full 1–99% table:
  rejected — a table gives the same optimum *plus* the RAM-constrained
  step-down fallback in one structure, for negligible extra (free) compute.
- **Persistent looping workers** instead of single-shot: rejected — they hold
  RAM indefinitely and can't free it precisely as each op lands, which breaks
  pipelined batch timing.
- **`ns.sleep(delay)` for batch timing** instead of `additionalMsec`:
  rejected — JS event-loop jitter desyncs landings; the engine-side
  `additionalMsec` lands ops precisely for the same RAM cost.
- **Shared `utils.js` helper library** imported by every script: rejected —
  Bitburner's import RAM tax charges the importer the full function cost of
  *everything* in the imported file. Only pure-constant config modules (0 NS
  calls) are safe to share; `booster` is otherwise self-contained.
