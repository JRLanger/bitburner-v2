# boot

**Location:** `src/boot.js` (plus its helper, `src/utils/boot-grind.js`)

## What it does

`boot.js` does the post-reset bring-up. This project passes `boot.js` as the
`cbScript` argument to every `installAugmentations`/`softReset`/`destroyW0r1dD43m0n`
call (`lifecycle.js` and `utils/finish-bn.js`). The game runs it automatically,
single-threaded, on `home` right after any reset. It automates the manual
bootstrap grind from `docs/devlog/01-bn-reset-checklist.md` (gym training → Mug
crime → `upgradeHomeRam` up to 32 GB). Then it starts `booster.js`, which takes
over everything else. `booster.js` also restarts the other managers through its
own gates.

You can also run `boot.js` by hand mid-game. If a controller already runs, it
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

`alreadyUp` reads `ns.ps("home")` and looks for `booster.js`/`orbiter.js` by
filename. This covers a manual mid-game call and a reset landing where a
controller process stayed alive.

`sf4Available` is the same SF4-owned-or-BitNode-4 check that
`booster.js`/`orbiter.js`'s `pilotGate` and `lifecycle.js`'s launch gate use:
`ns.getResetInfo().ownedSF.get(4) > 0 || ns.getResetInfo().currentNode === 4`.

### Why the grind lives in a separate script (`utils/boot-grind.js`)

**This is the most important design fact about boot.js.** The spec requires
boot.js to fit in **≤ 8 GB** (the worst-case post-reset home RAM). But
`ns.singularity.*` calls carry the documented ×16/4/1 SF4 RAM multiplier. Here is
the math on the calls the grind needs (`isBusy` 0.5, `commitCrime` 5,
`getCrimeChance` 5, `upgradeHomeRam` 3, `getUpgradeHomeRamCost` 1.5, `gymWorkout`
2 — all ×mult), plus a few unmultiplied base calls:

| SF4 level | multiplier | boot.js RAM if grind were inline |
|---|---|---|
| 1 | ×16 | ~242 GB |
| 2 | ×4 | ~62 GB |
| 3 | ×1 (best case) | ~17 GB |

**Even at the best-case SF4.3, an inline grind goes over the 8 GB budget by more
than 2×.** So the grind logic lives in `utils/boot-grind.js`, a separate script
that `boot.js` starts with `ns.exec`. `ns.exec` costs a flat 1.3 GB no matter
what it starts. The started script pays its own RAM in its own process, not in
the caller's static analysis. `boot.js` never imports or calls a single
`ns.singularity.*` function. Its own footprint is only:

```
1.6 (script overhead)
+ 0.05 (getServerMaxRam)
+ 0.2  (ps)
+ 1.3  (exec)
+ 0.1  (isRunning)
+ 1.0  (getResetInfo)
= 4.25 GB total — no SF4 multiplier anywhere.
```

4.25 GB clears the 8 GB ceiling with margin. The number does not change with SF4
level, because boot.js calls no singularity function. `utils/boot-grind.js` does
all the `commitCrime`/`gymWorkout`/`upgradeHomeRam` work. Its RAM is whatever it
is, charged only while it runs, on whatever home RAM is free at the time.

### `utils/boot-grind.js` — the actual grind

1. Gate check (`singularityAvailable`) — this mirrors pilot's own pattern (try
   `ns.singularity.isBusy()`, catch → unavailable). boot.js already checked the
   cheap SF4 gate before it exec'd this, so this is a defensive re-check.
2. **Gym pre-step (`trainStats`)** — this runs only if
   `getCrimeChance('Mug') < BOOT_MUG_MIN_CHANCE` (0.6). It trains
   STR/DEF/DEX/AGI to level 25 one at a time with `gymWorkout` at
   `Sector12PowerhouseGym`. It polls `getPlayer().skills` (the documented
   `Skills` interface fields: `strength`/`defense`/`dexterity`/`agility`),
   because gym workouts run until stopped rather than return a duration.
3. **Mug-to-target loop (`mugToTarget`)** — while `getServerMaxRam("home") <
   BOOT_TARGET_HOME_GB` (32): if `getUpgradeHomeRamCost()` is affordable now, call
   `upgradeHomeRam()` at once and re-check. Otherwise call `commitCrime('Mug',
   false)` and `sleep` for the returned duration (plus a small margin) before the
   next loop. This automates devlog 01's manual routine exactly.

### Idempotence

A second run of `boot.js` (by accident, or by hand mid-game) is safe.
`alreadyUp()` returns a no-op the instant it finds any controller running. This
also means a reset that leaves an old controller process alive does not cause a
duplicate launch storm.

## Why it's built this way

**Hard RAM split, not a "best effort" one.** The spec's ≤8 GB requirement for
boot.js is not a soft target. It is the worst-case fresh-reset home RAM (8 GB is
the game's minimum), so boot.js must run there *unconditionally*. The multiplier
math above shows that even SF4.3 goes over an inline budget by 2×. No tuning path
kept the grind inline. A separate exec'd process was the only option that meets
both "boot.js always fits" and "the grind still fully automates devlog 01."

**boot.js checks the SF4 gate with `getResetInfo()`, never with a singularity
call.** `ns.singularity.isBusy()` (the cheap gate check that pilot and boot-grind
both use) still carries the ×16/4/1 multiplier (0.5 GB base). That is enough on
its own to nearly triple boot.js's footprint at SF4.1. `getResetInfo()` is a
flat, unmultiplied 1 GB top-level call, and it is exactly what
`pilotGate`/`lifecycle`'s gate already use. So boot.js reuses the same check with
zero added multiplier risk.

**`isRunning` polling instead of `ns.exec`'s return plus fire-and-forget.**
boot.js needs to know when the grind finishes, so it does not launch booster onto
a home that is still mid-grind and misprice every manager's RAM headroom math.
`ns.isRunning(pid)` is a cheap 0.1 GB poll. It removes the need for richer
inter-process signaling (a port, a flag) for what is really a "wait for this one
process to exit" need.

**booster launches unconditionally at the end, even if the grind was skipped or
failed to fit.** boot.js's docstring states this: it must be safe to pass as
`cbScript` unconditionally, in every SF4/RAM configuration. A skipped grind (no
SF4, or already at target) never blocks booster from starting. Worst case, the
player has a smaller-than-ideal home RAM pool, and booster runs with less
headroom, exactly as it always has for a non-grinding fresh save.

## Alternatives considered

- **Keep the grind inline in boot.js, and accept a boot.js larger than 8 GB**:
  the spec's hard ≤8 GB requirement rejects this outright. The math above proves
  it impossible at every SF4 level, given the actual documented RAM costs of the
  needed calls.
- **A cheaper single grind call (for example, skip `getCrimeChance` and always
  run the gym step)**: rejected. `getCrimeChance` lets the grind skip an
  unnecessary ~4 minutes of gym time when Mug's starting chance is already good
  (per devlog 01's own accounting of ROI). Moving it into boot-grind.js (a
  separately-priced process) means there is no RAM reason to cut it.
- **Split boot-grind.js further into per-phase one-shots (gym-only, mug-only)**:
  not needed. boot-grind.js is not subject to the 8 GB ceiling at all (boot.js is
  the reset callback, not boot-grind.js). No RAM pressure motivates a further
  split, and a single sequential script is simpler to read and debug.
- **A fixed sleep instead of polling `isRunning`**: rejected. The grind's
  duration is unbounded (it depends on Mug's success rate and money-earning
  speed). A fixed wait would either finish too early (and race booster's launch
  against a still-tiny home) or waste time past completion.

## Known limitation: the true 8 GB fresh-BitNode home

boot.js itself fits 8 GB. But neither boot-grind.js (~17 GB at SF4.3) nor
booster.js (8.85 GB) fits. On a genuinely fresh BitNode entry (home reset to 8 GB)
the automated grind cannot launch. boot.js detects both exec failures and prints
a pointer to the manual devlog-01 routine instead of failing silently. Aug
installs do NOT reset home RAM, so this only bites on BitNode entry. A full
sub-8 GB grind chain (split mug/upgrade one-shots plus ns.spawn) is recorded as
future work in docs/plans/reset-lifecycle.md territory. Build it only if the
manual 20-minute routine ever becomes a real pain point.

## Unverified / open items

- **`mem boot.js` not yet run in-game** — the 4.25 GB figure comes from the type
  defs' documented `@remarks RAM cost` annotations for every NS function boot.js
  calls (`getServerMaxRam` 0.05, `ps` 0.2, `exec` 1.3, `isRunning` 0.1,
  `getResetInfo` 1.0, plus 1.6 GB script overhead). It is not a live in-game
  measurement. Re-verify with `mem boot.js` once played, and update this doc plus
  the RAM table above if it disagrees.
- **`GYM_LOCATION` hardcoded to `Sector12PowerhouseGym`** — devlog 01 does not
  say which gym. This assumes the player starts in (or can reach) Sector-12. If a
  save starts elsewhere, `gymWorkout` simply fails (returns `false`), and
  `trainStats` moves on without training that stat. It degrades gracefully into
  "skip gym, just Mug for longer" rather than error.
</content>
</invoke>
