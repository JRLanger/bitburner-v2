# Devlog 04 — Stage 10: the stalled-pipeline hunt (and the sync tool that was lying to us)

**Date:** 2026-07-04
**Status:** Closed — all fixes verified live; branch `stage-10-pipeline-stall`.

## The symptoms

Three problems that looked unrelated and turned out to be one debugging chain:

1. Some batch targets froze at `fill=0/N` forever ("stalled pipelines").
2. The game started crashing every few minutes — but only when the sync tool ran.
3. The debug logs mirrored to `game-logs/` kept freezing mid-run, so every
   diagnosis was made on stale data without us realizing it.

## The chain, in the order it actually unraveled

**The mirror was broken (and silent).** `sync.py` read one WebSocket frame at a
time and discarded continuation frames. Browsers fragment large messages, so once
a debug log grew past the fragmentation threshold, its `getFile` reply arrived as
fragments, `json.loads` failed, and a bare `except: pass` swallowed it — that
file simply never updated again. Every log on disk was a truncated snapshot from
whenever the file was last small. Fix: proper message reassembly (RFC 6455 §5.4)
and errors are logged, never swallowed.

**The 45 MB log was crashing the game.** With reassembly fixed, the first real
pull brought in a 45 MB orbiter log — `CONTROLLER_DEBUG` appends ~1.4 KB/s and
nothing ever truncated mid-run. Every pull makes the *game* JSON-serialize the
entire file on its main thread; at tens of MB that freezes the UI, and it only
happens with sync connected — matching the crash pattern exactly. Fixes:
`flushDebug` now rotates the log at `DEBUG_LOG_MAX_BYTES` (2 MB), pulls run every
15 s instead of 2 s, and sync won't stack new requests while the game is behind
(backpressure), so a lagging game can't be spiraled into a crash.

**The real 0/N stall: a three-way deadlock.** With live logs finally flowing, the
stall signature was unmistakable: money ~4%, security far over min, empty
pipeline, endless `FIRE-HOT`, `grace=0`. Three rules interlocked: (1) `batchPhase`
never fires at a hot target, and security only falls when a weaken *lands* — an
empty pipeline has none coming; (2) `classify` protected any pipeline under 90%
fill from the re-prep drop, *including an empty one*; (3) `prepPhase` only touches
`needsPrep` targets, which the protected target never became. Any target that
drained while hot (crash/reload purge, drift) locked up permanently, one after
another. Fix: an **empty** pipeline is not protected — the protection exists to
avoid orphaning in-flight workers, and an empty pipeline has none. Empty +
unhealthy now re-preps after the normal drift grace.

**The REANCHOR massacre loop.** Healing the deadlock exposed the next layer: on
two targets the planner's hack-fraction flipped between two values every other
tick, and each downward flip triggered the instant re-anchor — killing the whole
in-flight pipeline (13–23k threads) every ~20 ticks, forever. Fix: a persistence
gate (`REANCHOR_STABLE_TICKS`) — a genuine ramp-down persists; a flap reverses in
a tick or two and never reaches the kill.

**The planner oscillation itself.** Two sources in `selectBatchers`: ranking used
the live `ns.hackAnalyzeChance`, which swings with the grid's security phase
(fixed: plans carry their mint-time, effectively prepped, chance); and the Pass-B
waterfall kept an upstream incumbent's locked plan at full cost on its hot ticks
with no budget clamp, whipsawing the capacity that reached downstream targets
(fixed: downward re-mints are damped by `RAMP_DOWN_STABLE_TICKS`; `ramp-hold` and
`OVERBUDGET` debug lines make convergence visible).

**One more sync bug for the road.** The reassembly loop answered the game's pings
inline and then kept blocking for a data frame that wasn't coming — freezing the
whole loop (this was the "sync freezes after one pull" and, after a 60 s read
timeout was added, the "game disconnects after ~1 minute"). Fix: after a control
frame with no reassembly in progress, return to the main loop.

## Lessons worth keeping

- **Never trust a mirror you haven't verified.** Hours were spent diagnosing
  "current" logs that were frozen snapshots. The failure mode was silent by
  design (`except: pass`). Diagnostic plumbing must be loud when it breaks.
- **Protection rules need an emptiness check.** "Don't drop a ramping pipeline"
  was right for partial pipelines and a deadlock for empty ones — the cost being
  protected (in-flight workers) didn't exist in the case that hurt.
- **Destructive reactions need time hysteresis.** Both the re-anchor kill and the
  ramp-down re-mint reacted instantly to signals that can flap; both now require
  the signal to persist. Value hysteresis (bands) was already there — it was the
  *time* dimension that was missing.
- **Watch the watcher's cost.** The debug log was "free" in-game (0 GB write) but
  its unbounded growth made an external reader lethal to the game's main thread.

## Addendum (2026-07-06, stage 10b): deadlock variant 2 — healthy-but-unfireable

Two days later a live case surfaced the second variant: **deltaone** frozen at
`fill=0/1956` with `sec=+2.34` — *below* the keep-test's loose bound
(`max(min×0.10, 1.0)` = +2.60 for min=26) but *above* batchPhase's fire gate
(`min×(1+SEC_MARGIN)` = +1.30). Healthy → never dropped to re-prep; hot → never
fires; empty → no weaken will ever land. The stage-10 fix only released
empty+*unhealthy* targets; this one was empty+*healthy*-but-unfireable, parked in
the gap between the two thresholds. Fix: when the pipeline is empty, health also
requires **fireable** security (the exact fire-gate bound) — the loose keep-bound
is hysteresis for a running pipeline, and an empty pipeline has nothing to
protect. Lesson: **two gates with different thresholds define a gap; make sure no
state can park inside it** — any "wait for X" gate needs a companion path that
guarantees X eventually happens.

## Deliberate non-fix

At the RAM-abundant/scarce boundary, tail admission slots can go to a bigger-bank
target running throttled (catalyst at f≈5%, ~876m/s) while a more RAM-efficient
one idles (millenium-fitness, ~1.18b/s preview). Known, modest, stable — ranking
by ramped cost or score-ranking the marginal slots is the stage-11 candidate if
it ever matters.
