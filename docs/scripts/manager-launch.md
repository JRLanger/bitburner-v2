# manager-launch

**Location:** `src/lib/manager-launch.js`

## What it does

Holds the manager orchestration that `booster.js` and `orbiter.js` both use. The two
controllers are two stages of one lineage. `orbiter` is a fork of `booster` that takes
over once `Formulas.exe` exists. They launch the same managers with the same logic, so
that logic lives here and both controllers import it.

Exports three functions:

- `launchManagers(ns, servers, dbg)` — each tick, start the first manager that is not
  running and not yet accounted for this run, if its gate is open.
- `nextManagerReserve(ns, servers)` — the home RAM to hold free for the next manager
  that will launch.
- `isRunning(ns, file)` — true if a process with that filename runs on home.

The `MANAGERS` list, the gate helpers (`pilotGate`, `gangGate`, `sleeveGate`,
`pserverFleetBuilt`), and the `stripSlash` filename helper stay private to the module.

## How it works

`MANAGERS` is an ordered array of `{ file, gate }`. The order is the priority order:
pserver, contracts, pilot, lifecycle, sleeve, gang, hacknet. Each `gate` is a predicate
that returns true when the manager's feature is available in this save.

`launchManagers` walks the list in order and does one of these per entry:

- **Running** — mark the file as seen, then move on. The seen mark lets a later
  disappearance count as "the user stopped it."
- **Seen earlier but now gone** — skip it for the rest of the run (the suppression, see
  below).
- **Gate closed** — skip it and keep going. A closed gate does not block the managers
  behind it. A save with no SF10 skips the sleeve manager but still reaches gang and
  hacknet.
- **Gate open and not running** — `ns.exec` it, then stop for this tick. Only one launch
  per tick. The file counts as seen only when `exec` returns a real pid. `exec` returns
  0 with no error when home has no free RAM, so a RAM-blocked launch retries next tick
  instead of looking like a manual stop.

The "seen" set lives on the shared flag port under the `managersSeen` key
(`lib/flags.js`). Port reads and writes cost 0 GB, so this state is free to hold and
free to import. `nextManagerReserve` uses the same list and the same gates to find the
first manager that still needs to launch and returns its script RAM, so home keeps
exactly that much free.

The gates read `ns.getResetInfo()`, which is a cheap top-level call. They deliberately
avoid any `ns.gang.*`, `ns.sleeve.*`, or `ns.singularity.*` reference, so the
controllers pay no feature-API RAM to gate-check. A gate answers "could this feature
exist in this save" from the source-file map and the current BitNode, and the manager
itself idles if the feature turns out to be absent.

`dbg` is the caller's per-tick debug logger. `booster` and `orbiter` each buffer log
lines to their own file, so the logger is passed in rather than kept in the module. It
defaults to a no-op, so a caller that does not want the output can omit it.

## Why it's built this way

The controllers held byte-identical copies of all of this. Every launcher fix had to
land in both files, and one did not: the sleeve manager was wired into `booster` only,
so it never launched under `orbiter`. A single shared module removes that whole class of
bug. This module is the fix.

The `managersSeen` suppression is intentional and must not be "fixed." A manager the
user stopped stays down for the rest of the run, across controller restarts. Any reset
(aug install, soft reset, game reload) wipes the ports, so the suppression clears exactly
when a new run starts. A controller process that survives a reset still sees a clean port
and rebuilds the wiped infra. A past change that cleared the flag on controller start was
reverted, because it broke the "a manual stop should stick" behavior the user wants.

The RAM model drove the split too. A script's RAM is the sum of every distinct `ns`
function its source and imports reference, counted once. Every `ns` function this module
uses — `exec`, `ps`, `getScriptRam`, `getResetInfo`, `print` — already appeared in both
controllers, so moving the code into an imported module changes neither controller's
footprint. See `docs/reference/game-mechanics.md` rule 1.

## Alternatives considered

**Keep `dbg` inside the module.** Rejected. The two controllers write to different log
files, so a module-local logger would send `orbiter`'s manager lines to `booster`'s log
or force a shared log. Passing the logger in keeps each controller's output where it
belongs.

**Export the gates and `MANAGERS` too.** Not needed. Only `launchManagers`,
`nextManagerReserve`, and `isRunning` are called from the controllers. `isRunning` is
exported because the controllers also use it outside manager launching (the orbiter
handoff and the dashboard check). The rest stays private.

**Put `stripSlash` in a shared path library.** Left alone. `stripSlash` is a one-line
pure helper that already exists as a local copy in several files. Moving all copies into
one home is a separate cleanup, out of scope here. This module keeps its own private copy
for `isRunning`.
