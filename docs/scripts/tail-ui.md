# tail-ui

**Location:** `src/lib/tail-ui.js`

## What it does

Shared text renderer for the controllers' tail windows. `renderTail(ns, snap)` draws
one full status frame — the same information the HTML dashboard shows — from the
snapshot object `buildSnapshot` produces in booster/orbiter: pool usage (total / %
used / free), pipeline fill, the ranked target table tagged by state (`ATK` attacking,
`PRE` prepping, `IDL` prepped-but-idle) with hack-%, op time and the active ranking
metric ($/s or $/GB·s), share state, one status line per manager, and alerts (engine
lag, pool nearly full, share paused).

## How it works

- The controller builds ONE snapshot per tick and hands it to both consumers:
  `renderTail` for the tail, `publishStatus` for the dashboard's status-bus port.
  tail-ui therefore computes nothing of its own from game state — it formats what the
  controller already measured, so the two views can never disagree.
- Manager lines are read from the managers' own status ports
  (`STATUS_PORT_CONTRACTS/PSERVER/HACKNET`) via `lib/status.js` `readStatus` — the same
  ports `dashboard.js` reads — with the same 25 s staleness rule for the
  "not reporting" marker.
- Alert rules mirror `dashboard.js` `renderAlerts`: tick gap over `2 × LOOP_SLEEP`,
  free pool under 3% of total, share manually paused.

## Why it's built this way

The controllers each carried a private `renderStatus` with a reduced subset of the
dashboard's data, and the two copies had already drifted apart (the orbiter fork still
printed "BOOSTER" in its header). Rendering from the shared snapshot in one shared
module gives the tail full information parity with the dashboard and removes the
duplicated code. It matters because the dashboard overlay is only auto-opened once
home has ≥ `DASHBOARD_MIN_HOME_RAM_GB` (256 GB); before that the tail is the ONLY
live view, so it must not be a second-class one.

Everything used here is 0 GB (`ns.print`/`clearLog`, `ns.format.*`, port peeks), so
importing the module adds no RAM to booster/orbiter — the same "safe to import
anywhere" rule as `lib/flags.js` and `lib/status.js`.

## Alternatives considered

- **Keep per-controller renderStatus and just sync them by hand** — rejected; they had
  already diverged once, and every dashboard change would need three edits.
- **Have the tail read the status-bus port instead of taking the snapshot as an
  argument** — works, but adds a tick of lag and a JSON round-trip for data the
  controller already holds in memory; the port stays the seam for *external* readers
  (dashboard) only.
