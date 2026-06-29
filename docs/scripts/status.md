# status

**Location:** `src/lib/status.js`

## What it does

A two-function library implementing a **status bus** over Netscript ports. Long-running
scripts call `publishStatus(ns, port, obj)` once per tick to broadcast a small JSON
snapshot of their live state; a reader (currently `dashboard.js`) calls
`readStatus(ns, port)` to pick it up. It is the decoupling layer that lets a separate
dashboard show what every script is doing without any of them knowing the dashboard
exists.

- `publishStatus(ns, port, obj)` — `clearPort` then `writePort` a `JSON.stringify(obj)`.
- `readStatus(ns, port)` — `peek` the port, `JSON.parse`, return `null` on empty/garbage.

The port assignments live in `config/constants.js`:

| Port | Publisher |
|------|-----------|
| 1 | (flags — `lib/flags.js`, not status) |
| 2 | `STATUS_PORT_CONTROLLER` — booster **or** orbiter (only one runs at a time) |
| 3 | `STATUS_PORT_CONTRACTS` |
| 4 | `STATUS_PORT_PSERVER` |
| 5 | `STATUS_PORT_HACKNET` |

## How it works

Each publisher builds a plain object every tick and writes it to its own port. A
Netscript port holds a queue, so `publishStatus` **clears the port first** and writes a
single fresh value — the slot always holds exactly the latest snapshot, and a plain
`writePort` to an already-occupied port (which fails) is avoided.

`readStatus` uses **`peek`, not `read`** — peek does not consume the value, so the
snapshot survives for the next dashboard tick and for any second reader. Empty ports
return the sentinel string `"NULL PORT DATA"`, which `readStatus` maps to `null`; a
`try/catch` around `JSON.parse` makes a half-written or corrupt value also return `null`
instead of throwing.

Every snapshot carries a `ts: Date.now()` field. The reader compares it against the
current time to decide whether a publisher is **live or stale** — a script that has been
killed or has self-exited simply stops updating its port, and its snapshot ages out.

## Why it's built this way

- **Ports, not files or DOM-scraping.** A script cannot read another script's memory, so
  some shared medium is required. Ports are **free RAM** (so importing this lib costs
  nothing and publishing adds nothing to a publisher's budget), they persist across
  ticks, and they are wiped on game restart / aug reset — exactly like `lib/flags.js`,
  whose pattern this mirrors. Files (`/data/*.json`) would also work but add disk churn
  and are slower to read; scraping the controllers' tail-window text would be brittle and
  couple the dashboard to display formatting.
- **`peek` over `read`** so the bus is a non-destructive broadcast: any number of readers
  can observe the latest snapshot, and a reader crash never eats a publisher's data.
- **`clearPort` before `writePort`** so the port is a single-value mailbox, not a growing
  queue — the reader always sees the newest state and the port can't back up.
- **`ts` for liveness** so the dashboard needs no separate heartbeat channel: staleness is
  just "snapshot too old," and a self-exiting manager (pserver/hacknet stop when their
  work is done) is detected for free.

## Alternatives considered

- **One shared port / one big object for all scripts.** Rejected: every publisher would
  have to read-modify-write the combined object each tick, racing each other and coupling
  their cadences. One port per publisher keeps writers independent.
- **Writing snapshots to `/data/*.json` files.** Workable and persistent across restarts,
  but slower and noisier than free port ops, and unnecessary — the dashboard only ever
  needs the *current* state, which ports hold perfectly.
- **Having the dashboard import the controllers and read their state directly.** Impossible
  across separate Netscript processes (no shared memory), and it would also drag the
  controllers' full RAM cost into the dashboard.
