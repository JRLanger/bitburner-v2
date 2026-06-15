# Devlog 01 — BN-Reset Manual Checklist

**Date:** 2026-06-15

## Why

Home RAM upgrades persist across augmentation installs within a BitNode, but
are lost on a BitNode reset (new BN, or "soft reset" via Stanek's destroy,
or starting a fresh BN). Since the bootstrap controller's available headroom
for worker threads scales directly with home RAM, and scripted RAM grinding
is slow early on, a short manual routine at the very start of each BN cycle
pays for itself almost immediately.

## The routine (~20 minutes, do this before launching any scripts)

1. **Gym training** (~4 minutes): train Strength, Defense, Dexterity, and
   Agility until each stat reaches level 25. This unlocks a ~50% success
   chance on the `Mug` crime.
2. **Mug grinding** (~6 minutes): run `Mug` until you have ~1.01m. This:
   - repays the ~600k debt incurred from gym training, and
   - covers the home RAM upgrade 8GB → 16GB.
3. **Upgrade home RAM to 16GB.**
4. **Keep Mugging** (~10 more minutes) until you reach **3.191m**, then
   **upgrade home RAM to 32GB.**

Total manual time: roughly 20 minutes, repeated once per BN reset. The 16GB
step alone is already a strong ROI and could be where this stops, but given
how good the ROI remains for the next 10 minutes, doing the full grind up to
32GB will likely be the default every time.

## Effect on the controller plan

The bootstrap hacking controller (see `docs/scripts/` once written) is sized
against whatever `ns.getServerMaxRam("home")` reports — it doesn't hardcode
RAM assumptions. Doing this grind first means the controller starts with
~32GB of home RAM instead of 8GB.

Note: 32GB is **not** enough to run a full rolling HWGW batch — that
typically needs RAM in the TB range once targets scale up. What 32GB buys is
simply much more comfortable headroom for the controller itself plus a
handful of worker threads while other servers are still being discovered and
rooted, compared to the very cramped 8GB starting point.

## Alternatives considered

- **Skip the grind, let scripts earn the upgrade**: much slower — early
  hacking income against `n00dles`-tier targets with only 1-2 threads of
  headroom takes far longer than 20 minutes to reach 3.191m.
- **Stop at 16GB**: still a solid improvement over 8GB, but the next 10
  minutes of Mugging to reach 32GB is good enough ROI to be worth doing by
  default.
