# debug-log

**Location:** `src/lib/debug-log.js`

## What it does

A tiny shared helper that appends one timestamped `key=value` line per call to a
plain file on home, keeping only the last N lines so the file can't grow without
bound over a long run. It's the backing store for the per-tick diagnostic logging in
the slow-tick managers: `pilot.js` and `lifecycle.js` each call `debugLog(...)` once
per tick (gated behind their `PILOT_DEBUG` / `LIFECYCLE_DEBUG` constants) to record
every input to their decision that tick — so questions like "grinding X but nothing
happening" or "augs ready but never installs" are answerable from the log alone,
without re-deriving state.

Output looks like:

```
14:22:07.431 row=faction-work busy=1 src=priority tgt=CyberSec@... readyNow=3 money=...
```

Newest lines are at the bottom; view in-game with `cat`/`nano` on the file, or pull
it to disk (the sync tool mirrors `data/pilot-debug.txt` and
`data/lifecycle-debug.txt` into `game-logs/`).

## How it works

One export, `debugLog(ns, file, fields, cap = 400)`:

1. Builds a line: an `HH:MM:SS.mmm` timestamp followed by `key=value` pairs from the
   `fields` object, space-separated. Values are formatted compactly by the local
   `fmt()` — numbers rounded to 2 decimals, `Infinity`/`-Infinity` → `inf`/`-inf`,
   `null`/`undefined` → `-`, objects → `JSON.stringify`, everything else `String()`.
2. Reads the existing file (`ns.read`, empty string if absent), splits into lines,
   pushes the new one.
3. Writes back only the last `cap` lines (`slice(-cap)`) with mode `"w"` — a
   read-truncate-rewrite that self-limits the file to `cap` lines (default 400).

## Why it's built this way

- **0-GB by construction.** `ns.read` and `ns.write` are free (see
  `docs/reference/game-mechanics.md` — RAM is charged per distinct `ns` function
  referenced, and these two cost nothing). So importing this module adds no static
  RAM to `pilot`/`lifecycle`, which is critical: those scripts already carry an
  expensive singularity surface that's RAM-multiplied ×16/×4/×1 by SF4 level. The
  one rule the caller must follow is **only log data it already has in hand** —
  never make an extra singularity call purely to log, since *that* would add the
  logged function's cost to the script.
- **Read-side line cap, not rotation.** Truncating to the last `cap` lines on every
  write keeps the file bounded with no separate rotation/cleanup pass and no state to
  track. The file is on home, so it survives resets — but it's a rolling window, not
  an archive.
- **Gated at the call site.** The managers wrap their `debugLog` calls in
  `if (PILOT_DEBUG)` / `if (LIFECYCLE_DEBUG)`, so logging turns off without deleting
  the call sites — the diagnostic instrumentation stays in the code for the next time
  it's needed.

## Alternatives considered

- **`ns.print`/`ns.tprint` to the script's own tail** — ephemeral (lost on restart,
  capped by the tail buffer) and not pullable to disk for offline inspection. A file
  is greppable and mirrors out via the sync tool.
- **A structured status port** (like `lib/status.js`) — status ports hold one latest
  snapshot for the dashboard to read; debug logging needs a *history* of ticks, which
  a single-slot port can't provide. Different job, so a separate file-backed helper.
- **Append-only with external truncation** — would let the file grow unbounded
  between cleanups; the read-side cap avoids ever needing a janitor.
