# dashboard

**Location:** `src/dashboard.js`

## What it does

A single **HTML/CSS overlay** that shows the whole booster/orbiter system at a glance,
replacing the need to juggle 4–5 separate tail windows. It is a pure reader — it touches
none of the batching logic. It peeks the status-bus ports (see `lib/status.js`) once a
second and renders one floating, draggable panel via the game's DOM.

The header carries a live **controller badge** (`ORBITER` / `BOOSTER`, or `OFFLINE` when
nothing is publishing) — the title itself is the generic "DASHBOARD" since the same
script serves every stage. The production scripts no longer auto-open their own tail
windows; booster and orbiter `ns.exec` the dashboard at startup if it isn't already
running (a future `station.js` should do the same). The per-script `renderStatus` tail
output still runs, so a tail can be opened manually for deep debugging.

The panel shows, top to bottom:

- **KPI strip** — total income ($/s), hacking level, hack-% ramp, share
  state; plus pool utilization and pipeline-fill bars (with rooted count).
- **Targets table** — every batching target sorted by income: money %, security-over-min,
  hack %, a pipeline-fill mini-bar (`committed/depth`), and $/s. Each row is colour-coded
  by health (green healthy / amber draining-or-not-full / red starved).
- **Prep queue** — targets being prepped, each with a money-% progress mini-bar.
- **Scripts row** — one chip per script (controller, contracts, pserver, hacknet, share)
  with a live/stale/done dot and its headline stat (fleet size, hacknet production, etc.).
- **Alerts line** — engine lag, pool nearly full, share paused, or a manager that stopped
  reporting; otherwise "all systems nominal."

## How it works

1. **DOM access.** It grabs the real document/window through `eval("document")` /
   `eval("window")`. This is the standard Bitburner idiom: it keeps the static RAM
   analyzer from charging for the global and sidesteps bundler issues. This works on the
   **Steam build** too — Steam Bitburner is an Electron app (bundled Chromium), so the
   DOM is the same as in the browser build.
2. **Panel scaffolding (`createPanel`).** Builds a fixed-position container with a
   draggable header and a `.bb-body` div. The header and body are created once; only the
   body's `innerHTML` is rewritten each tick, so dragging and the close button stay live.
   A `<style>` block is injected once (`injectStyle`). Position is restored from / saved to
   `localStorage` so the panel reopens where you left it.
3. **Cleanup.** `ns.atExit(() => root.remove())` removes the overlay when the script is
   killed; the × button sets a `stopped` flag so the loop exits (and atExit fires).
4. **Render loop.** Every second it `readStatus`-es all four ports into a `snaps` object,
   then rebuilds the body from `render(snaps)`, which composes the five sections as HTML
   strings. Liveness uses each snapshot's `ts`: the controller is "stale" after 3 s (it
   ticks ~every 200 ms), the managers after 25 s (they loop every 10 s). A stale manager
   whose last `action` says *done/maxed/exit/exhausted* is shown grey ("done"), not red —
   pserver and hacknet deliberately self-exit when their work is finished.

The controller-side data is produced by a new `buildSnapshot(...)` in both `booster.js`
and `orbiter.js`, called right after `renderStatus` each tick. It reuses the exact values
the tail table already computes (via `displayHealth`, `expectedIncome`, `poolFree`, the
`pipelines` map, `topRampF`/`rampSaturated`, `shareThreads`) plus `tickGap`/`lastWorkMs` for the
engine-lag indicator — no new NS calls. The three managers publish a small object
(timestamp, headline stats, last-action string) at the end of their own loops.

## Why it's built this way

- **HTML overlay over a consolidated tail window.** The user asked for "as beautiful and
  easy to read as possible." A tail window is monospace text only; the DOM gives real
  colour-coding, progress bars, layout, and a persistent floating panel. Confirmed viable
  on Steam (Electron/Chromium).
- **Read-only via the status bus.** The dashboard never imports or perturbs the
  controllers; it only reads ports. This keeps the batching logic untouched and means the
  dashboard can be started, stopped, or crash with zero effect on income. Each publisher's
  RAM is also unaffected (port writes are free).
- **Rebuild only `.bb-body` each tick.** Re-rendering the inner HTML is simple and the
  panel is small, so flicker is negligible; keeping the header/container static preserves
  drag state and event handlers without manual diffing.
- **Two-tier staleness + "done" detection.** The controller and the slow managers tick at
  very different rates, so a single stale threshold would either nag about healthy
  managers or miss a dead controller. Treating a self-exited manager as "done" rather than
  "error" avoids false alarms for pserver/hacknet finishing their build-out.
- **`localStorage` for position** so the panel is where you expect it after a reload,
  without a config file.

## Alternatives considered

- **Consolidated tail-window dashboard (`ns.print` ASCII).** Simpler and more robust to
  game updates, and it matches the existing `renderStatus` style — but limited to
  monospace text with no real colour/bars. Rejected in favour of the HTML overlay for
  readability and looks; the per-script tail renders are kept as a fallback.
- **The dashboard scraping each controller's tail text.** Brittle (couples to display
  formatting) and can't reach the managers cleanly. The structured snapshot bus is far
  more robust.
- **Using the game's bundled React directly.** Possible, but plain DOM string-building is
  enough for a panel this size and avoids depending on React internals that can shift
  between game versions.
- **Updating each DOM node in place instead of `innerHTML`.** More code for negligible
  benefit at this panel size; revisit only if flicker or perf becomes an issue.
