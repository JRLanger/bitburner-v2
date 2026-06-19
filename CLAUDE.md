# Bitburner v2 — Project Instructions

This is a from-scratch rewrite of Bitburner automation scripts, on a new save game.

## Background

The user has an existing, more advanced Bitburner project at
`/Users/jrlanger/Documents/Claude/Projects/Bitburner` with years of accumulated scripts.
That project grew organically and became hard to follow.

## Rules for this project

- Brand new save game, scripts written from scratch.
- Reference only the in-game docs / Netscript API definitions (see `docs/reference/`) —
  do NOT copy code or architecture from the old project, even if asked to look at it for
  inspiration.
- The user is new to coding and to git/GitHub — explain things in beginner-friendly
  terms, and walk through git commands step by step rather than assuming familiarity.

## Game version: target Netscript v3.0.1+

This save runs Bitburner **v3.0.1**. Several older Netscript functions were removed
or moved namespaces in v2/v3 — always confirm a function still exists in
`docs/reference/NetscriptDefinitions.d.ts` (the live type defs) before using it; do
not rely on memory of the older API. Migration notes: `docs/reference/migrations/`.

Known breaking change already hit:
- The **purchased-server API moved into the `ns.cloud.*` namespace** (the old
  `ns.getPurchasedServer*` / `ns.purchaseServer` / `ns.upgradePurchasedServer` were
  removed in 3.0.0). Current names: `ns.cloud.getServerLimit()`,
  `ns.cloud.getServerNames()`, `ns.cloud.getRamLimit()`, `ns.cloud.getServerCost(ram)`,
  `ns.cloud.getServerUpgradeCost(host, ram)`, `ns.cloud.purchaseServer(host, ram)`,
  `ns.cloud.upgradeServer(host, ram)`, `ns.cloud.deleteServer(host)`.

## Documentation goal

Document the process as we go: the logic behind each script, how it works, and why
design decisions were made.

- For each script, maintain a per-script doc in `docs/scripts/<script-name>.md`
  covering what it does, how it works, why it's built that way, and alternatives
  considered — use the `/devlog` skill to create or update these. This is the primary
  reference when a script needs to change later.
- `docs/devlog/` is a separate, chronological log of overall project decisions — see
  `docs/devlog/00-intro.md` for its format.
