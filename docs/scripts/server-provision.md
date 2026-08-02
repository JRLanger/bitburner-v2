# server-provision

**Location:** `src/lib/server-provision.js`

## What it does

Holds the network discovery, rooting, and worker provisioning that `booster.js` and
`orbiter.js` both use. It exports one function:

- `discoverAndRoot(ns)` — scan the whole network from home, root every server it can,
  copy the worker scripts onto newly rooted hosts, and return an array of static server
  info objects.

The helpers `tryRoot`, `provisionWorkers`, and `gatherInfo`, plus the `PLACED_WORKERS`
list and the `provisionedThisRun` set, stay private to the module.

## How it works

`discoverAndRoot` runs a breadth-first scan from home. For each host it reaches:

- It records the host's BFS parent. `gatherInfo` stamps that parent into each server
  object, and the controllers write it to `/data/servers.json`. `pilot.js` reads the
  parent chain from there to rebuild backdoor paths without a scan of its own (see
  `netpath.md`). The controllers already scan every tick, so the parent costs nothing.
- home is added as a normal pool host. It is always rooted and already holds the worker
  scripts, so it needs no rooting or copy. `gatherInfo` reports maxMoney 0 for home, so
  the controllers never target it for hacking.
- Any other host is rooted through `tryRoot`, which opens each port for which home owns
  the cracker, then calls `ns.nuke`. `nuke` throws when the host still has closed ports,
  so `tryRoot` catches that and reports "not rooted."
- A rooted host gets the workers copied to it when it is missing them, or once per
  controller run. The `provisionedThisRun` set forces one overwrite copy per host per
  run. File presence alone cannot tell a current worker from a stale one, so a worker
  code change would never reach an already-provisioned host without the once-per-run
  copy. A reset wipes copied scripts, and file presence then re-provisions with no cache
  to clear.

`PLACED_WORKERS` is the HWGW workers plus the share worker, copied together in one
`ns.scp` per host.

## Why it's built this way

The controllers held byte-identical copies of this discovery and rooting code. Rooting is
exactly the kind of code that must not drift apart between the two stages. A new port
cracker, or a BitNode rule change, has to reach both controllers. A fix applied to one
copy and not the other is a silent bug, the same failure mode that left the sleeve
manager out of `orbiter`. One shared source removes that risk.

`provisionedThisRun` is module-scoped, so it is one set per process. `booster` hands off
to `orbiter` with a fresh `ns.exec`, so each controller runs its own process and gets its
own empty set. The behavior matches the old per-file copies exactly.

The RAM model makes the move free. A script's RAM is the sum of every distinct `ns`
function its source and imports reference. Every function here — `scan`, `hasRootAccess`,
`fileExists`, the five crackers, `nuke`, `scp`, and the `getServer*` static getters —
already appeared in both controllers, so importing this module changes neither
controller's footprint. See `docs/reference/game-mechanics.md` rule 1.

## Alternatives considered

**Leave discovery duplicated and extract only the manager launcher.** The manager
launcher was the stated target and the proven bug source. Discovery was extracted as well
because it is byte-identical, self-contained, and the rooting logic is a prime candidate
for a future silent drift bug. Single-sourcing it now prevents that.

**Extract the RAM pool and batcher plumbing too** (`buildPool`, `placeThreads`,
`sharePhase`). Left duplicated. That code is the hot loop most likely to diverge as
`orbiter`'s Formulas targeting evolves, and `orbiter` already carries pieces the two do
not share (for example `ramAttribution`). Extracting it would trade a real divergence
risk for a small line count win.
