# Implementation Plan: `lifecycle` — reset & BitNode automation (Roadmap 3.4)

Status: **planned, not started**. Written 2026-07-05 against Netscript v3.0.1.
**Hard dependency: `pilot` (docs/plans/pilot-singularity.md) must exist first** —
lifecycle reads pilot's status and uses the same SF4-gated `ns.singularity.*` API.
Read `docs/devlog/01-bn-reset-checklist.md` (the manual loop being automated).

## Goal

Close the outermost loop: **decide when to install augmentations, execute the
pre-reset checklist, reset, and bring the system back up automatically** — turning
"automated session" into "automated progression". Also automate the post-reset
manual grind from devlog 01 (gym/mug to fund home 8→32 GB).

Three parts, buildable independently in this order:
- **Part A** — `boot.js`: post-reset bring-up (callback script for the reset).
- **Part B** — `lifecycle.js`: install decision + pre-reset checklist + reset call.
- **Part C** — BitNode completion (`w0r1d_d43m0n`) — small, mostly a player-consent gate.

## API facts (verified in docs/reference/NetscriptDefinitions.d.ts — re-verify before coding)

- `ns.singularity.installAugmentations(cbScript?)` — installs & resets; `cbScript`
  (a script on home) is auto-run after reset. Same param on `softReset(cbScript?)`.
- `ns.singularity.destroyW0r1dD43m0n(nextBN, callbackScript?, bitNodeOptions?)` and
  `b1tflum3(...)` — end the BitNode (requires backdooring capability / hack level).
- `ns.getResetInfo()` → `ResetInfo` (contains `lastAugReset`, `lastNodeReset`,
  `currentNode`, `ownedSF` — **verify exact field names in the defs when coding**).
- `ns.singularity.getOwnedAugmentations(true)` minus `(false)` = purchased-but-not-
  installed augs (the "pending install" count).
- Crime/gym for Part A: `ns.singularity.commitCrime(crime, focus?)` returns crime
  duration ms; `gymWorkout(gym, stat, focus?)`; `upgradeHomeRam()` /
  `getUpgradeHomeRamCost()`.
- SF4 RAM multiplier (×16/4/1) applies — same design constraint as pilot: separate
  slow scripts, minimal distinct singularity calls.

## Part A — `src/boot.js` (post-reset bring-up)

A small standalone script on home, passed as `cbScript` to every reset call. It must
run in **8 GB** (worst-case home) — keep it tiny, budget < 8 GB total; check with
`mem boot.js`. No imports except constants/flags (0 GB).

Sequence:
1. If home RAM ≥ 32 GB (aug multipliers often make the grind unnecessary later in
   the run): exec `booster.js`, exit.
2. Else replicate devlog-01 manually-done bootstrap, automated:
   a. Loop: `commitCrime('Mug', false)` (await duration via sleep of returned ms)
      until money ≥ `getUpgradeHomeRamCost()`.
   b. `upgradeHomeRam()`; repeat until home ≥ `BOOT_TARGET_HOME_GB` (32).
   c. Optional pre-step if mug success is poor: a few `gymWorkout` reps — decide at
      implementation time by checking `getCrimeChance('Mug')`; if ≥
      `BOOT_MUG_MIN_CHANCE` (0.6) skip the gym entirely.
3. Exec `booster.js`, exit. (Booster handles everything else, including launching
   managers and, via gates, pilot/lifecycle.)

Edge cases:
- No SF4 → singularity calls unavailable → boot.js can't grind. Detect by gate
  (same check as pilot's) and fall back to just exec'ing booster + a tail message
  telling the player to do the devlog-01 checklist manually. This keeps boot.js
  safe to pass as cbScript unconditionally.
- boot.js must tolerate being run mid-game manually (idempotent: if booster or
  orbiter already running, just exit).

## Part B — `src/managers/lifecycle.js` (install decision + reset)

Manager-pattern script (see pserver.md), launched by the controller with gate =
same SF4 gate as pilot. Slow tick: `LIFECYCLE_LOOP_SLEEP = 60_000`.
Status → **`STATUS_PORT_LIFECYCLE = 8`** (add dashboard/tail row).

### Install-decision model ("when is a reset worth it?")

Compute each tick, publish in status, and act only when threshold met:

- `pending` = purchased-not-installed aug count (see API facts).
- `runMs` = now − `getResetInfo().lastAugReset`.
- `stagnantMs` = now − (timestamp of last aug purchase; read from pilot's status
  snapshot — add `lastAugPurchaseTs` to pilot's published status, one-line change).
- **Install when** `pending >= LIFECYCLE_MIN_AUGS` (default 8) **and**
  `stagnantMs >= LIFECYCLE_STAGNANT_MS` (default 30 min — pilot can't reach the next
  aug soon) — **or** `pending >= 1 && runMs >= LIFECYCLE_MAX_RUN_MS` (default 12 h,
  aligns with the hacknet horizon model in `/data/bn-durations.json`).
- **Autonomy guard:** `LIFECYCLE_AUTO_INSTALL = false` by default in constants.
  When false, lifecycle publishes `recommendInstall: true` + reason string (dashboard
  alert) and takes no action. The player flips the constant (or a runtime flag
  `autoInstall` via `src/lib/flags.js` + a `utils/auto-install-on.js` one-shot,
  mirroring share-on/off) to arm it. **Never ship with auto-install armed.**

### Pre-reset checklist (executed once decision fires, in order)

> **IMPLEMENTED 2026-07-06 (arbitration.md Decision 5).** Step 0.5 `batchBuyAugs`
> sits between freeze and NF dump: buys the priority tier (`config/aug-priority.js`
> — category-based, not getAugmentationStats) then the rest, each most-expensive-first
> by live price, re-scanning for prereqs. The install decision now keys off pilot's
> `acquirableNow` / `lastAcquireTs` (affordable-AND-unlocked staleness), not `lastAugPurchaseTs`.
> See `docs/scripts/lifecycle.md` for the shipped behavior.

0. **Liquidate & freeze spending:** set runtime flags `liquidate: true` (stock
   manager sells all positions and acks with `liquidated: true` in its status —
   wait for ack, 30 s timeout) and `moneyFloor` high enough to stop all manager
   purchases. See `docs/plans/arbitration.md` Decision 2. (No-op until the stocks
   manager exists.)
1. **NeuroFlux dump:** loop `purchaseAugmentation(f, 'NeuroFlux Governor')` on the
   joined faction with the highest rep until it returns false (rep or money runs
   out). This is deliberately lifecycle's job, not pilot's (price inflation —
   see pilot plan).
2. **Spend-down:** money is lost meaning at reset; optionally donate remainder to
   the highest-favor faction if favor ≥ donate threshold (`getFavorToDonate()`),
   banking rep for next run. Behind `LIFECYCLE_SPEND_DOWN = true`.
3. **Record run duration:** append `{end: now, durationMs: runMs}` to
   `/data/bn-durations.json` (same file/format the hacknet manager reads — check
   its parser in `src/managers/hacknet.js` and match exactly).
4. **Log:** write a summary line to a persistent file `/data/lifecycle-log.txt`
   (survives resets): date, run length, augs installed, money at reset.
5. `installAugmentations('boot.js')`.

No need to kill other scripts — install wipes all running scripts; ports/flags
auto-clear (documented behavior of the flag store).

## Part C — BitNode completion

Small extension to lifecycle, **always player-consented** (`LIFECYCLE_AUTO_DESTROY`
does not exist — this is never automatic):

- Condition monitor: station's status reports `wd.rooted` and hack-level vs
  requirement (see station plan). When `w0r1d_d43m0n` is backdoorable, lifecycle
  raises a persistent dashboard alert: "BitNode completable — run
  utils/finish-bn.js <nextBN>".
- `src/utils/finish-bn.js` (one-shot, player-run): takes `nextBN` arg, validates,
  calls `ns.singularity.destroyW0r1dD43m0n(nextBN, 'boot.js')`. boot.js then
  bootstraps the new BitNode. (Alternative manual path: physically backdooring
  w0r1d_d43m0n also works; the util is the scripted path.)
- Reason for consent gate: BitNode choice is the single most important strategic
  decision in the game and depends on which Source-Files the player wants.

## Constants to add (`src/config/constants.js`)

```js
// --- lifecycle (reset automation) ---
export const STATUS_PORT_LIFECYCLE = 8;
export const LIFECYCLE_LOOP_SLEEP = 60_000;
export const LIFECYCLE_AUTO_INSTALL = false;   // recommend-only until player arms it
export const LIFECYCLE_MIN_AUGS = 8;
export const LIFECYCLE_STAGNANT_MS = 30 * 60_000;
export const LIFECYCLE_MAX_RUN_MS = 12 * 3600_000;
export const LIFECYCLE_SPEND_DOWN = true;
export const BOOT_TARGET_HOME_GB = 32;
export const BOOT_MUG_MIN_CHANCE = 0.6;
export const LIFECYCLE_LOG_FILE = '/data/lifecycle-log.txt';
```

## Cross-cutting changes

- `pilot.js`: add `lastAugPurchaseTs` to its status snapshot.
- Controllers: add lifecycle to `launchManagers()` with the SF4 gate (after pilot).
- Dashboard/tail: lifecycle row + `recommendInstall` alert + BN-completable alert.
- Flags: `autoInstall` runtime flag + `utils/auto-install-{on,off}.js` one-shots.

## Testing checklist

1. `mem boot.js` ≤ 8 GB. Run boot.js manually mid-game → exits immediately
   (idempotence).
2. Decision model dry-run: set `LIFECYCLE_MIN_AUGS = 1` on a save with pending augs;
   confirm `recommendInstall` alert fires and **nothing else happens** with
   auto-install off.
3. NF dump: on a throwaway moment before a real manual install, run the checklist
   path and verify NF levels purchased until false.
4. Full armed reset (the scary one — do it when a reset is wanted anyway): arm
   autoInstall, watch: NF dump → duration recorded → install → boot.js runs →
   grind (or skip) → booster up → managers relaunch. Verify `managersSeen` and all
   flags cleared by the reset as designed.
5. bn-durations.json: confirm hacknet manager still parses the file after lifecycle
   appends.

## Documentation deliverables

- `docs/scripts/lifecycle.md` + `docs/scripts/boot.md` via `/devlog`; devlog stage
  entry; update devlog 01 (checklist now automated) and `docs/ROADMAP.md` 3.4.
