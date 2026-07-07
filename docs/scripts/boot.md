# boot

**Location:** `src/boot.js` (plus its helper, `src/utils/boot-grind.js`)

## What it does

Post-reset bring-up. `boot.js` is passed as the `cbScript` argument to every
`installAugmentations`/`softReset`/`destroyW0r1dD43m0n` call in this project
(`lifecycle.js` and `utils/finish-bn.js`), so the game auto-runs it,
single-threaded, on `home` immediately after any reset. It automates the
manual bootstrap grind documented in `docs/devlog/01-bn-reset-checklist.md`
(gym training → Mug crime → `upgradeHomeRam` up to 32 GB) and then launches
`booster.js`, which takes over everything else (including relaunching the
other managers via its own gates).

It is also safe to run manually mid-game: if a controller is already up, it
does nothing.

## How it works

### Sequence (`main`)

```
1. alreadyUp()?                 → if booster or orbiter already running, exit.
2. home RAM < BOOT_TARGET_HOME_GB (32)?
     sf4Available()?
       yes → exec utils/boot-grind.js, await its completion (isRunning poll)
       no  → tail message pointing at the manual devlog-01 checklist
3. exec booster.js
```

`alreadyUp` reads `ns.ps("home")` and checks for `booster.js`/`orbiter.js` by
filename — covers both a manual mid-game invocation and a reset landing where
a controller process happened to survive it.

`sf4Available` is the identical SF4-owned-or-BitNode-4 check
`booster.js`/`orbiter.js`'s `pilotGate` and `lifecycle.js`'s launch gate use:
`ns.getResetInfo().ownedSF.get(4) > 0 || ns.getResetInfo().currentNode === 4`.

### Why the grind lives in a separate script (`utils/boot-grind.js`)

**This is the single most important design fact about boot.js.** The spec
requires boot.js to fit in **≤ 8 GB** (the worst-case post-reset home RAM), but
`ns.singularity.*` calls carry the documented ×16/4/1 SF4 RAM multiplier. Doing
the math on the calls the grind needs (`isBusy` 0.5, `commitCrime` 5,
`getCrimeChance` 5, `upgradeHomeRam` 3, `getUpgradeHomeRamCost` 1.5, `gymWorkout`
2 — all ×mult) plus a handful of unmultiplied base calls:

| SF4 level | multiplier | boot.js RAM if grind were inline |
|---|---|---|
| 1 | ×16 | ~242 GB |
| 2 | ×4 | ~62 GB |
| 3 | ×1 (best case) | ~17 GB |

**Even at the best-case SF4.3, inlining the grind blows the 8 GB budget by
more than 2×.** So the grind logic is split into `utils/boot-grind.js`, a
completely separate script `boot.js` launches with `ns.exec` (a flat 1.3 GB
cost regardless of what's being launched — the launched script's own RAM is
charged to ITS OWN process, not the caller's static analysis). `boot.js`
itself never imports or calls a single `ns.singularity.*` function, so its own
footprint is just:

```
1.6 (script overhead)
+ 0.05 (getServerMaxRam)
+ 0.2  (ps)
+ 1.3  (exec)
+ 0.1  (isRunning)
+ 1.0  (getResetInfo)
= 4.25 GB total — no SF4 multiplier anywhere.
```

4.25 GB comfortably clears the 8 GB ceiling with margin, and — critically — the
number doesn't change with SF4 level, since boot.js calls no singularity
function at all. `utils/boot-grind.js` (its RAM is whatever it is, charged only
while it runs, on whatever home RAM is currently available) does all the
`commitCrime`/`gymWorkout`/`upgradeHomeRam` work.

### `utils/boot-grind.js` — the actual grind

1. Gate check (`singularityAvailable`) — mirrors pilot's own pattern (try
   `ns.singularity.isBusy()`, catch → unavailable). boot.js already checked
   the cheap SF4 gate before execing this, so this is a defensive re-check.
2. **Gym pre-step (`trainStats`)** — only runs if
   `getCrimeChance('Mug') < BOOT_MUG_MIN_CHANCE` (0.6). Trains
   STR/DEF/DEX/AGI to level 25 one at a time via `gymWorkout` at
   `Sector12PowerhouseGym`, polling `getPlayer().skills` (the documented
   `Skills` interface fields: `strength`/`defense`/`dexterity`/`agility`) since
   gym workouts run until stopped rather than returning a duration.
3. **Mug-to-target loop (`mugToTarget`)** — while `getServerMaxRam("home") <
   BOOT_TARGET_HOME_GB` (32): if `getUpgradeHomeRamCost()` is affordable right
   now, `upgradeHomeRam()` immediately and re-check; otherwise `commitCrime('Mug',
   false)` and `sleep` for the returned duration (+ small margin) before
   looping. This exactly automates devlog 01's manual routine.

### Idempotence

Running `boot.js` a second time (accidentally, or manually mid-game) is safe:
`alreadyUp()` short-circuits to a no-op the instant any controller is found
running. This also means a reset that happens to leave an old controller
process alive won't cause a duplicate launch storm.

## Why it's built this way

**Hard RAM split, not a "best effort" one.** The spec's ≤8 GB requirement for
boot.js isn't a soft target — it's the worst-case fresh-reset home RAM (8 GB is
the game's minimum), so boot.js must be able to run there *unconditionally*.
Given the multiplier math above shows even SF4.3 blows an inline budget by
2×, there was no tuning path that kept the grind inline; splitting it into its
own exec'd process was the only option that satisfies both "boot.js always
fits" and "the grind still fully automates devlog 01."

**SF4 gate checked via `getResetInfo()`, never via a singularity call, in
boot.js itself.** `ns.singularity.isBusy()` (the cheap gate check pilot and
boot-grind both use) still carries the ×16/4/1 multiplier (0.5 GB base) —
enough on its own to nearly triple boot.js's footprint at SF4.1. `getResetInfo()`
is a flat, unmultiplied 1 GB top-level call, and it's exactly what
`pilotGate`/`lifecycle`'s gate already use — so boot.js reuses the identical
check with zero additional multiplier risk.

**`isRunning` polling instead of `ns.exec`'s return + fire-and-forget.**
boot.js needs to know when the grind finishes (so it doesn't launch booster
onto a home that's still mid-grind, mispricing every manager's RAM headroom
math). `ns.isRunning(pid)` is a cheap 0.1 GB poll, sidestepping the need for
any richer inter-process signaling (a port, a flag) for what is fundamentally
a "wait for this one process to exit" need.

**Booster launched unconditionally at the end, even if the grind was skipped
or failed to fit.** boot.js's docstring calls this out explicitly: it must be
safe to pass as `cbScript` unconditionally, in every SF4/RAM configuration.
Skipping the grind (no SF4, or already at target) never blocks booster from
starting — worst case the player has a smaller-than-ideal home RAM pool and
booster just runs with less headroom, exactly as it always has for a
non-grinding fresh save.

## Alternatives considered

- **Keep the grind inline in boot.js, and simply accept a boot.js larger than
  8 GB**: rejected outright by the spec's hard ≤8 GB requirement (verified
  above to be mathematically impossible at every SF4 level given the actual
  documented RAM costs of the needed calls).
- **A cheaper single grind call (e.g. skip `getCrimeChance` and always run the
  gym step)**: rejected — `getCrimeChance` is what lets the grind skip an
  unnecessary ~4 minutes of gym time when Mug's starting chance is already
  good (per devlog 01's own accounting of ROI), and moving it into
  boot-grind.js (a separately-priced process) means there's no RAM reason to
  cut it.
- **Splitting boot-grind.js further into per-phase one-shots (gym-only,
  mug-only)**: not needed — boot-grind.js isn't subject to the 8 GB ceiling at
  all (it's not the reset callback, `boot.js` is), so there's no RAM pressure
  motivating a further split; a single sequential script is simpler to read
  and debug.
- **A fixed sleep instead of polling `isRunning`**: rejected — the grind's
  duration is unbounded (depends on Mug's success rate and money-earning
  speed), so a fixed wait would either finish too early (racing booster's
  launch against a still-tiny home) or waste time waiting past completion.

## Known limitation: the true 8 GB fresh-BitNode home

boot.js itself fits 8 GB, but neither boot-grind.js (~17 GB at SF4.3) nor
booster.js (8.85 GB) does — on a genuinely fresh BitNode entry (home reset to
8 GB) the automated grind cannot launch. boot.js detects both exec failures and
prints a pointer to the manual devlog-01 routine instead of failing silently.
Aug installs do NOT reset home RAM, so this only bites on BitNode entry; a full
sub-8 GB grind chain (split mug/upgrade one-shots + ns.spawn) is recorded as
future work in docs/plans/reset-lifecycle.md territory, to build only if the
manual 20-minute routine ever becomes a real pain point.

## Unverified / open items

- **`mem boot.js` not yet run in-game** — the 4.25 GB figure is computed from
  the type defs' documented `@remarks RAM cost` annotations for every NS
  function boot.js calls (`getServerMaxRam` 0.05, `ps` 0.2, `exec` 1.3,
  `isRunning` 0.1, `getResetInfo` 1.0, plus 1.6 GB script overhead), not a
  live in-game measurement. Re-verify with `mem boot.js` once played and
  update this doc + the RAM table above if it disagrees.
- **`GYM_LOCATION` hardcoded to `Sector12PowerhouseGym`** — devlog 01 doesn't
  specify which gym; this assumes the player starts in (or can reach)
  Sector-12. If a save starts elsewhere, `gymWorkout` will simply fail
  (returns `false`) and `trainStats` moves on without training that stat,
  degrading gracefully into "skip gym, just Mug for longer" rather than
  erroring.
