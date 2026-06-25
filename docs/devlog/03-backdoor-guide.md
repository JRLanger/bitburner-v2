# Devlog 03 — `backdoor-guide` utility

**Date:** 2026-06-23

## Why

Needed a quick way to see which faction/win-condition servers (`CSEC`,
`avmnite-02h`, `I.I.I.I`, `run4theh111z`, `fulcrumassets`, `w0r1d_d43m0n`) are
ready to backdoor and get a copy-paste `connect ...; backdoor` command for them,
without hand-tracing the network path each time.

## What changed

Added `src/utils/backdoor-guide.js`, a one-shot terminal utility ported (rewritten
from scratch, per project rules) from an older version in the prior Bitburner
project. The BFS path-finding logic was sound and kept; the rest was simplified:
dropped a tail-window UI that depended on a `/config/ui.js` `TAIL` export that
doesn't exist in this project, collapsed a two-pass status-table-then-commands
loop into one pass per target, and switched to plain-text `ns.tprint` output to
match this project's other one-shot `src/utils/` scripts.

See `docs/scripts/backdoor-guide.md` for the full write-up.
