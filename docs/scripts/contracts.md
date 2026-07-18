# contracts

**Location:** `src/managers/contracts.js`

## What it does

Finds and solves coding contracts (`.cct` files) across the whole network. It is an
independent persistent loop, launched on `home` by `booster` **first** in the manager
dependency order (see `docs/devlog/02-booster.md` "Manager orchestration"). Coding
contracts spawn at random on servers and pay free money / faction reputation when
solved, with no prerequisites, so this manager leads the launch order and its gate is
always true.

Each tick it reads the host list from the topology JSON `booster` writes
(`SERVERS_JSON` = `/data/servers.json`), `ns.ls(host, ".cct")`s every host, and for
each contract looks up a solver by contract **type**. It is **solve-all,
skip-unknown**: it attempts only types it has a solver for and logs + skips the rest.

## How it works

Each loop tick (`MANAGER_LOOP_SLEEP`, default 10 s):

1. **Enumerate hosts.** `JSON.parse(ns.read(SERVERS_JSON))` (free) gives the
   `{ hostname, … }` array `booster` already maintains; map to hostnames. `home` is
   appended in case a contract spawns there. A missing/half-written JSON is caught and
   the tick simply retries next time.
2. **Find contracts.** `ns.ls(host, ".cct")` on each host. `ls` needs no root, so every
   host is scanned regardless of root status.
3. **Resolve each contract** with a single `ns.codingcontract.getContract(file, host)`
   (15 GB) call, which returns `{ type, data, submit, numTriesRemaining }` — type, the
   input data, the submit function, and the tries-remaining accessor all at once.
4. **Solve and submit.** Look up `SOLVERS[type]`. If there's no solver, tally a skip
   and move on. If `numTriesRemaining() <= 0`, skip (don't burn the last try on a
   guess). Otherwise call the pure solver on `contract.data`, `contract.submit(answer)`,
   and record success (non-empty reward string) or failure.
5. **Don't retry a rejection.** A rejected contract is recorded in an in-memory
   `failedOnce` set keyed by `host:file` and never re-attempted. Solvers are
   deterministic, so a wrong answer would be identical every tick — retrying would only
   burn the contract's limited tries until it self-destructs. (The set is in-memory
   only; a manager restart clears it, costing at most one extra attempt.)
6. **Status box.** A framed tail-window panel (same style as `pserver.js`) shows
   lifetime solved / failed / skipped tallies plus a small ring of recent activity
   lines.

Every per-contract step is wrapped in `try/catch`, so a single malformed contract or a
buggy solver logs an error and the loop continues rather than dying.

### Solver registry

`SOLVERS` is a plain object keyed by the exact contract-type string (the values of
`CodingContractName` in `docs/reference/NetscriptDefinitions.d.ts`). Each value is a
**pure function** that takes the contract's `data` and returns the answer in the shape
the engine expects (per `CodingContractSignatures`). No solver touches `ns`. Adding a
new contract type later is just: write one pure function, add one registry line.

Implemented types (essentially the full v3.0.1 set): Find Largest Prime Factor,
Subarray with Maximum Sum, Total Ways to Sum (I/II), Spiralize Matrix, Array Jumping
Game (I/II), Merge Overlapping Intervals, Generate IP Addresses, Algorithmic Stock
Trader (I–IV), Minimum Path Sum in a Triangle, Unique Paths in a Grid (I/II), Shortest
Path in a Grid, Sanitize Parentheses in Expression, Find All Valid Math Expressions,
HammingCodes (both directions), Proper 2-Coloring of a Graph, Compression
(I RLE / II LZ-decompress / III LZ-compress), Encryption (I Caesar / II Vigenère),
Square Root (BigInt), Total Number of Primes, Largest Rectangle in a Matrix.

The two genuinely tricky ones:

- **Compression III (LZ compress)** is a minimal-length encoder via memoized recursion
  over `(position, next-field-type, may-flip)`. The format alternates literal /
  backreference fields (a length-0 field flips type without consuming input, so two
  literals or two backrefs can be adjacent); choosing where to cut for the shortest
  output is the DP. Verified by round-tripping through the LZ-decompress solver.
- **HammingCodes** uses extended Hamming (parity bits at power-of-two indices plus an
  overall parity bit at index 0). Decode XORs the set-bit indices to get the syndrome
  and corrects a single flipped bit before reading the data bits. Verified by
  encode→flip-a-bit→decode round-trips.
- **Largest Rectangle in a Matrix** finds the largest all-**0s** rectangle (the one
  that "does not contain any 1s" — *not* the largest block of 1s, a subtlety that bit
  the first version), via a per-row histogram of consecutive-0 runs and a monotonic
  stack, returning the `[[r1,c1],[r2,c2]]` top-left/bottom-right corners.

All solvers were unit-tested in Node against known input/output pairs, then validated
in-game with a temporary harness that spawned one dummy contract of every type and ran
the manager against the full set — **30/30 types solved, 0 failures**.

## Why it's built this way

**Discovery lives in the manager, not `booster`'s scan loop.** `booster` already BFS-
scans the network periodically, so it *could* `ls` for `.cct` files and write their
paths into `servers.json`. We deliberately didn't:

- *No RAM win.* The manager needs `getContract` (15 GB) to **solve** regardless;
  discovery is only `ls` (0.2 GB). Folding it into `booster` would tax `booster`
  0.2 GB without shrinking the manager. The efficient split is the one used:
  `booster` supplies the host list (free, already written), the manager does the
  contract-specific work.
- *Separation of concerns.* Each manager is an independent script with its own logic;
  contracts are unrelated to `booster`'s hacking topology, so its data format
  shouldn't carry a downstream feature's fields.
- *Freshness.* Contracts appear at arbitrary times; `booster` rescans only
  periodically. The manager re-`ls`-ing on its own cadence finds them promptly and
  independently of `booster`'s scan timing.

**One `getContract` call instead of four functions.** `getContract` (15 GB) returns
type + data + `submit` + `numTriesRemaining` together, so we avoid separate
`getContractType` (5) + `getData` (5) + `getNumTriesRemaining` (2) + `attempt` (10)
calls — both cheaper RAM and a single source of truth per contract.

**Solve-all, skip-unknown.** Attempting a type we can't solve would waste a limited
try and risk destroying the contract. Skipping unknown types (and contracts already
out of tries) is safe and lets the registry grow incrementally without ever
regressing.

**Pure solvers + registry.** Keeping solvers free of `ns` makes them unit-testable in
plain Node (which is how they were validated) and keeps the dispatch trivial — the
type string from the engine is the registry key directly.

**Orchestration wiring.** `CONTRACTS_MANAGER` lives in `config/constants.js`;
`booster`'s `MANAGERS` array lists it at order 1 with an always-true gate.
`booster`'s generic `launchManagers` / `nextManagerReserve` logic reserves its
`home` RAM — read live via `ns.getScriptRam`, so it's always current — and
launches it (once — it checks `ns.ps` to avoid double-launch on a `booster`
restart) exactly like the other managers.

## Alternatives considered

- **Fold `.cct` discovery into `booster`'s scan** (write contract paths into
  `servers.json`): rejected — see "Why it's built this way"; no RAM saving and it
  couples `booster`'s data format to this feature.
- **Separate `getContractType` / `getData` / `attempt` calls** instead of one
  `getContract`: rejected — more RAM and more calls for the same information.
- **Attempt unknown types with a best-effort guess:** rejected — wastes the limited
  tries and can destroy a contract; skipping is strictly safer.
- **Import a shared solver/util library:** rejected for the same reason as the rest of
  the project — Bitburner's import RAM tax charges the importer for every function in
  an imported module. The manager only imports the pure-constant `config/constants.js`.
- **A worker script that solves contracts off `home`:** unnecessary — solving is
  CPU/logic only (no per-host execution needed), and `getContract`/`submit` work
  remotely via the `host` argument, so one loop on `home` covers the whole network.
