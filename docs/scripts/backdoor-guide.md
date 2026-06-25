# backdoor-guide

**Location:** `src/utils/backdoor-guide.js`

## What it does

A one-shot terminal utility that prints ready-to-paste commands for backdooring the
servers tied to faction invites and the end-game win condition: `CSEC`, `avmnite-02h`,
`I.I.I.I`, `run4theh111z`, `fulcrumassets`, and `w0r1d_d43m0n`. For each target it
checks whether the server is reachable, rooted, and within hacking level, and either
prints the reason it's not ready yet or a command like:

```
home; connect n00dles; connect CSEC; backdoor
```

Run manually from the terminal with `run /utils/backdoor-guide.js`.

## How it works

For each target, `ns.getServer(host)` is wrapped in a try/catch — calling it on a
host the player hasn't discovered yet throws, so that's treated as "not visible."
If the server is visible:

1. Skip with a status line if it's already backdoored, not rooted, or hacking level
   is too low.
2. Otherwise, BFS from `home` over `ns.scan()` to find the shortest path to the
   target, then build the command by prefixing `home; ` and chaining `connect <hop>`
   for every hop after `home`, ending in `backdoor` — the leading `home;` means each
   line is self-contained and pastable regardless of where the terminal currently is.

Output goes through `ns.tprint` so it lands in the terminal log, not a tail window —
there's nothing to watch over time, so a persistent UI isn't useful here.

## Why it's built this way

**One-shot + `ns.tprint`, not a persistent loop with a tail window.** This is a
checklist the player glances at occasionally while leveling hacking skill, not
something that needs live state. A tail window with `ns.ui.openTail`/`resizeTail`
adds setup complexity for no benefit when the script runs once and exits.

**BFS over `ns.scan()` instead of hardcoded paths.** Network topology can change
as new servers are discovered, and path-finding generically also means the same
logic works for any future target added to the list — no need to hand-walk and
hardcode a route per server.

**Plain text status/commands, no emoji glyphs.** Earlier draft used emoji status
icons (✅🔒⚡) for a tabular layout; dropped in favor of plain text since `ns.tprint`
output doesn't need to align as a table and plain text is more reliably readable in
the terminal log.

## Alternatives considered

An earlier version of this script (from the prior Bitburner project, rewritten here
from scratch per this project's no-copy-old-code rule) opened a persistent tail
window with a two-pass design: first printing a status table for all targets, then
printing commands for the ready ones — effectively checking each target's status
twice. That version also imported a `TAIL` position config (`/config/ui.js`) that
doesn't exist in this project. Collapsed to a single pass per target and dropped the
tail window/table formatting in favor of `ns.tprint`, matching the style of the
other one-shot scripts in `src/utils/` (e.g. `share-on.js`).
