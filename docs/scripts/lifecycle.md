# lifecycle

**Location:** `src/managers/lifecycle.js`

## What it does

Closes the outermost automation loop: decides **when** the run's accumulated
augmentation unlocks are worth resetting for, runs the pre-reset checklist in order
(liquidate/freeze spending → **batch-buy the aug set** → dump NeuroFlux Governor →
optional favor spend-down → record run duration → log → `installAugmentations`), and —
separately — raises a persistent, player-consent-only alert when the BitNode
is completable. It never resets or ends a BitNode on its own initiative unless
the player has explicitly armed it (autonomy guard, below) or run the BitNode
completion util themselves.

It is an independent persistent loop, launched on `home` by booster/orbiter
(`launchManagers`) once the same SF4 gate `pilot.js` uses passes — see
`docs/plans/reset-lifecycle.md` Part B for the full spec this implements.

Explicitly out of scope: pilot owns buying non-NeuroFlux augmentations and all
player-focus decisions (arbitration.md Decision 1); lifecycle only dumps
NeuroFlux Governor levels (pre-reset, deliberately late to avoid wasting the
per-purchase price inflation on levels bought too soon) and decides/executes
the reset itself.

## How it works

### Launch gate

Reuses `pilotGate` from booster.js/orbiter.js verbatim (same SF4-owned-or-BN4
check) — lifecycle's every `ns.singularity.*` call carries the identical
×16/4/1 SF4 RAM multiplier pilot's plan documents, so it needs the same gate.

### Main loop (every `LIFECYCLE_LOOP_SLEEP` = 60s)

```
computeDecision()         // install-decision model
if (decision.shouldInstall && armed) await runChecklist()  // destructive path
checkBnCompletable()      // Part C, alert-only
publishStatus(port 8)
sleep 60s
```

**Install-decision model (`computeDecision`).** Computes each tick:

Because pilot no longer buys augs mid-run (arbitration.md Decision 5 — the batch
buy happens in this checklist *after* the decision), the trigger is ACQUISITION
progress: an aug is "ready" only when its rep is met **and** the money to buy it is
saved. (Rep alone is wrong — forming a gang unlocks nearly every aug's rep at once,
which would fire an install before the money to buy them exists.)

- `readyCount` = pilot's `acquirableNow` (priority augs the reset batch could afford
  right now, simulating the ~1.9× ramp; rep met AND money saved), port 7.
- `runMs` = now − `getResetInfo().lastAugReset`.
- `stagnantMs` = now − pilot's `lastAcquireTs` (when `acquirableNow` last grew — via
  grinding rep OR saving money); falls back to `lastAugReset` if nothing yet.

Fires when EITHER:
- `readyCount >= LIFECYCLE_MIN_AUGS` (8) **and** `stagnantMs >= LIFECYCLE_STAGNANT_MS`
  (30 min) — enough augs are affordable AND no new aug has become acquirable for a
  while, i.e. progress on the binding constraint (money or rep, whichever is greater)
  has plateaued; **or**
- `readyCount >= 1` **and** `runMs >= LIFECYCLE_MAX_RUN_MS` (12 h) — the run has
  gone on long enough that even a single affordable aug is worth banking.

**Autonomy guard.** `armed = LIFECYCLE_AUTO_INSTALL || getFlag(ns, "autoInstall", false)`.
`LIFECYCLE_AUTO_INSTALL` now ships **`true`** — aug installs run automatically once
the decision thresholds are met (the intended fully-autonomous progression loop).
Set the constant `false` (or run `utils/auto-install-off.js`, which clears the
runtime `autoInstall` flag) to fall back to recommend-only, where lifecycle just
publishes `recommendInstall` + `reason` and takes no destructive action. **BitNode
completion stays player-only** regardless — `destroyW0r1dD43m0n` is never automatic
(only `utils/finish-bn.js`, run by hand); only aug installs are automated here.

When the decision fires but `armed` is false, lifecycle does nothing but
publish `recommendInstall: true` + a `reason` string — the dashboard/tail
alert line. **No purchase, no flag write, no reset call** happens on that path.

**Pre-reset checklist (`runChecklist`) — only reachable when armed:**

0. **`liquidateAndFreeze`** — sets flag `moneyFloor: Infinity` (every spending
   manager — pserver, hacknet, pilot — subtracts `moneyFloor(ns)` from its
   spendable-money read via `lib/flags.js`, wired in with this change per
   `docs/plans/arbitration.md` Decision 2; Infinity survives the port because
   `writePort` structured-clones rather than JSON-serializes) and flag `liquidate: true`, then
   polls `STATUS_PORT_STOCKS` (port 9, reserved but currently unpublished — no
   stocks manager exists yet) for `{liquidated: true}` up to
   `LIQUIDATE_ACK_TIMEOUT_MS` (30 s), proceeding regardless once it elapses.
   **No-op today** (always times out, since nothing publishes to port 9 yet) —
   but the flag-setting and timeout code is in place now per the plan, so
   the stocks manager (when built) only needs to honor `liquidate` and publish
   the ack; lifecycle's side of the protocol needs no future changes.
0.5. **`batchBuyAugs`** — the actual aug purchase, done now that money is about to
   become worthless. Gathers every rep-unlocked, not-owned aug across joined
   factions; buys the **priority tier** (`config/aug-priority.js`) first, then the
   rest, each **most-expensive-first** by live price (the ~1.9× ramp compounds
   against later buys, so dear ones go first), re-scanning after each purchase
   (a buy can satisfy another aug's `getAugmentationPrereq`). Returns the count
   bought (logged). NeuroFlux is excluded — it's the next step.
1. **`dumpNeuroflux`** — finds the joined faction with the highest current
   `getFactionRep`, then loops `purchaseAugmentation(faction, 'NeuroFlux Governor')`
   until it returns `false` (rep or money exhausted).
2. **`spendDown`** (gated by `LIFECYCLE_SPEND_DOWN = true`) — finds the joined
   faction with the highest `getFactionFavor`; if that favor is at or above
   `getFavorToDonate()` (hardcoded 150 fallback if unavailable, matching
   pilot's `startFactionWork` pattern), donates all remaining home money to it.
   Below that threshold, does nothing (donating too early wastes money for
   very little rep).
3. **`recordRunDuration`** — computes `now - lastAugReset` for the lifecycle
   log **without touching `/data/bn-durations.json`**: hacknet's
   `computeHorizon()` already appends the finished run's duration itself on its
   next launch (its stored `augReset` vs. the post-install `lastAugReset` diff
   IS this duration). Writing it here too would double-count the run and skew
   hacknet's ROI horizon — hacknet stays the file's single writer.
4. **`logRun`** — appends one human-readable line to `LIFECYCLE_LOG_FILE`
   (`/data/lifecycle-log.txt`, a plain file — survives resets): timestamp, run
   duration, augs owned, NF levels bought, amount donated, money at reset.
5. **`ns.singularity.installAugmentations(BOOT_SCRIPT)`** — the only
   destructive call in the whole script, reachable only after every earlier
   step has completed and only on the `armed` path. `BOOT_SCRIPT` is the plain
   filename constant (`"boot.js"`, not a path) — `installAugmentations`'s
   `cbScript` parameter is documented as looked up on home by bare filename.

No cleanup of other running scripts is needed — the game wipes all running
scripts on install; ports and the flag store auto-clear (existing documented
behavior `lib/flags.js` already relies on for `managersSeen`).

### Part C — BitNode completion (`checkBnCompletable`)

Purely observational: reads `ns.getServer('w0r1d_d43m0n')` and reports
`completable = hasAdminRights && !backdoorInstalled && hackLvl >= requiredHackingSkill`.
**Lifecycle never calls `destroyW0r1dD43m0n` itself** — there is no
`LIFECYCLE_AUTO_DESTROY` constant anywhere in this codebase, by design. When
`completable` is true, the dashboard/tail alert instructs the player to run
`utils/finish-bn.js <nextBN>` themselves.

### Status (port 8 — `STATUS_PORT_LIFECYCLE`)

```js
{
  ts, pending, runHrs, stagnantMin,
  recommendInstall: bool, reason: string|null,
  autoInstallArmed: bool,
  bnCompletable: bool,
  action: "...",
}
```

Dashboard (`src/dashboard.js`) and the tail renderer (`src/lib/tail-ui.js`) each
add a `lifecycle` manager row (augs ready, run age, no-unlock time, auto-install
state), plus two alert lines: "Recommend aug install: `<reason>`" when
`recommendInstall` is set, and "BitNode completable — run utils/finish-bn.js
`<nextBN>`" when `bnCompletable` is set.

## Cross-cutting: pilot's acquisition signals

`managers/pilot.js` publishes `acquirableNow` (count of priority augs the reset
batch could afford now — rep met AND money saved, via a ramp simulation) and
`lastAcquireTs` (when that count last grew) in its status snapshot (port 7).
`computeDecision` reads both as the install trigger. Both derive from pilot's
per-process state (a fresh pilot after a reset correctly starts with "nothing
acquirable yet", and `computeDecision` falls back to `lastAugReset`).

## Companion scripts

- **`utils/auto-install-on.js` / `auto-install-off.js`** — one-shot terminal
  tools (`run /utils/auto-install-on.js`) that set/clear the `autoInstall`
  runtime flag. Exact structural mirror of `share-on.js`/`share-off.js`.
- **`utils/finish-bn.js`** — one-shot, **player-run only**. Takes a single
  `nextBN` argument (validated as an integer 1–14), then calls
  `ns.singularity.destroyW0r1dD43m0n(nextBN, BOOT_SCRIPT)`. This is the only
  code path in the whole project that can end a BitNode — lifecycle only ever
  points at it via the alert, never invokes it.

## Why it's built this way

**Separate, slow-ticking script — never imported into booster/orbiter.**
Identical reasoning to pilot: every `ns.singularity.*` call here is
RAM-multiplied ×16/4/1 by SF4 level, so isolating it to its own process (60s
tick — install-worthiness changes over minutes/hours, not seconds) means only
lifecycle pays that cost, only while it's running, and never taxes the
controllers' own tight early-game RAM.

**Decision model as two independent OR'd triggers, not one formula.** The
stagnant-time trigger answers "pilot is stuck — nothing more is coming soon,
so cash in what we have" while the max-run-length trigger answers "it's been
too long regardless — take partial progress rather than none." Keeping them
as separate named conditions (rather than folding into one score) keeps the
`reason` string genuinely informative on the dashboard, and each threshold is
independently tunable without the other's math shifting.

**Autonomy guard as an OR of a constant and a flag, not just a flag.** The
constant (`LIFECYCLE_AUTO_INSTALL`) provides a documented, code-reviewable
default (always `false`, per the hard rule); the flag
(`autoInstall`) provides the actual per-run arming mechanism a player uses
without editing source. Neither alone was sufficient: a flag-only design has
no code-visible "this must default to false" contract; a constant-only design
would require editing and redeploying source just to arm a single reset.

**`moneyFloor: Infinity` rather than the current money value.** NF dumping and
the spend-down donation both deliberately spend money DURING the checklist —
if the floor were set to money-at-checklist-start, those very steps would
immediately violate it (a manager checking `money - cost < moneyFloor` a
moment later would see cost exceed the (now lower) money, but the floor itself
wouldn't move — actually this is subtly fine either way since floor is a
lower bound, not upper — but `Infinity` unambiguously means "every other
manager's purchases are blocked, full stop" with no need to reason about how
low money might go during this script's own spending).

**`recordRunDuration` deliberately does NOT overwrite `augReset`.** The
temptation is to "finish the job" and write the fresh `lastAugReset` here too
— but `hacknet.js`'s own `computeHorizon()` relies on seeing its OWN stored
`augReset` differ from the live one on its next launch to compute and push
that run's duration. If lifecycle pre-empted that by writing the new
`augReset` value, hacknet's first diff post-install would be ~0 and silently
corrupt the horizon history. Leaving `augReset` at its pre-install value only
adds a new duration entry (which is all this step is responsible for);
hacknet's existing logic untouched.

**Part C kept advisory-only, permanently.** BitNode choice is a strategic,
irreversible decision (which Source-File path to pursue) that depends on
information (build objectives across MANY future runs) the automation has no
way to model. Rather than add any auto-destroy config (however guarded),
the design omits the concept entirely — `finish-bn.js` requires the player to
type the BitNode number themselves, every time.

## Alternatives considered

- **A single weighted score instead of two OR'd triggers**: rejected — a
  single number is harder to explain on the dashboard ("reason: score 0.83")
  and tuning one threshold would silently interact with the other's
  contribution. Two named, independently-tunable conditions read more clearly
  and debug more easily.
- **Storing pilot's unlock signals in the flag port instead of its status
  snapshot**: rejected — the arbitration protocol already establishes "publish
  in your own status snapshot, others read via `readStatus`" as the
  cross-manager convention (no new channel needed), and the flag port is
  reserved for state that specifically needs reset-clearing semantics or
  cross-process mutation, neither of which applies to a read-only timestamp
  pilot itself fully owns.
- **Writing the liquidation-ack wait as a TODO/stub instead of full code**:
  rejected per the task's explicit requirement — the checklist step must be
  present and functionally complete (flag write + poll + timeout) even though
  it is presently a no-op, so the stocks manager (when built) is the only
  thing left to add.
- **A single per-tick money ledger for the checklist's own spending**:
  rejected as unnecessary — NF dump and spend-down each re-read
  `getServerMoneyAvailable`/rely on the game's own affordability check inside
  `purchaseAugmentation`/`donateToFaction`, so no separate tracking is needed
  within the one-shot checklist.

## Unverified / open items

- **`LIFECYCLE_MANAGER_RAM` is an ESTIMATE (27.75 GB at SF4.3), not yet
  measured in-game** — computed from the type defs' documented per-call RAM
  costs (`isBusy` 0.5, `getOwnedAugmentations` 5, `getFactionRep` 1,
  `purchaseAugmentation` 5, `getFactionFavor` 1, `donateToFaction` 5,
  `installAugmentations` 5, all ×16/4/1, plus ~5.25 GB of unmultiplied base
  calls). Re-measure with `mem managers/lifecycle.js` once played and update
  the constant. Like pilot, only viable as a single script at SF4.3 — at lower
  SF4 levels it would need the same per-phase one-shot split documented as
  pilot's RAM fallback.
- **Liquidation ack protocol is untestable until the stocks manager exists** —
  the 30 s timeout path is the only one currently exercisable; the
  ack-received path can't be verified end-to-end yet.
- **`getFavorToDonate()`** carries the same defensive fallback pilot's
  `startFactionWork` uses, for the same reason (top-level NS function,
  confirmed in the type defs, not re-verified against a live session in this
  pass).
