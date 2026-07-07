# netpath

**Location:** `src/lib/netpath.js`

## What it does

A tiny **0-GB** pure library that reconstructs the `home → target` hop path through the
server network from topology data (an array of `{hostname, parent}` objects), and builds
the terminal `connect …; backdoor` command string for it. Shared by
`utils/backdoor-guide.js` (the manual paste-a-command tool) and `managers/pilot.js` (which
walks the path to auto-install backdoors).

## How it works

Two exports:
- `findPath(servers, target)` — builds a `hostname → parent` map from the array, then walks
  parent pointers from `target` back to `home`, returning `["home", …, target]` (or `null`
  if the target isn't in the topology or the chain never reaches home). A cycle guard makes
  it safe against malformed/stale input.
- `buildConnectCommand(path)` — turns a path into `home; connect …; …; backdoor`.

The `parent` field comes from the controllers' own discovery BFS: `booster.js` / `orbiter.js`
already scan the network every tick, so they stamp each host's BFS predecessor into
`/data/servers.json` at no extra NS cost. `pilot` reads that file (0 GB) rather than
re-scanning. `backdoor-guide.js`, being a one-shot manual tool, builds an equivalent
`{hostname, parent}` list from a fresh live `ns.scan` BFS — the extra scan is irrelevant for
a script run by hand.

## Why it's built this way

Both call sites need the same "reconstruct a path from topology" logic. Extracting it into a
pure module means a correctness fix (e.g. the cycle guard) benefits both, and keeps the BFS
framework-agnostic — it operates on any `{hostname, parent}` array regardless of whether that
came from a live scan or a JSON file. Being 0-GB (no NS calls), it's free to import anywhere.
