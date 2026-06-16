# Documentation

This `docs/` tree holds two kinds of material:

- **Suite guide** — how *this* automation project works: its scripts, strategy, and
  architecture. Start here.
- **Game reference** — a local copy of the Bitburner manual (game mechanics), kept for
  lookup while writing scripts.

## Suite guide (this project)

- [Development & tooling](guide/development.md) — Node + ESLint setup, `npm run lint`, the auto-lint hook
- [HWGW batcher](guide/batcher.md) — the hacking batcher system, controllers, and timing internals
- [Augmentation strategy](guide/augmentation-strategy.md) — the buy-few-then-reset prestige loop (`managers/augments.js`)
- [Bladeburner strategy](guide/bladeburner-strategy.md) — Bladeburner automation strategy (`managers/bladeburner.js`)
- [Player-slot scheduler](guide/player-slot-scheduler.md) — phase-weighted player-action-slot priorities (`config/schedule.js`)
- [Weighted-ETA planner](guide/planner.md) — cross-manager money + slot allocation (`managers/planner.js`, `config/objectives.js`)

## Game reference — basic mechanics

- [Stats](basic/stats.md)
- [Terminal](basic/terminal.md)
- [Hacking](basic/hacking.md)
- [Scripts](basic/scripts.md)
- [Servers](basic/servers.md)
- [RAM](basic/ram.md)
- [Hacknet nodes](basic/hacknet_nodes.md)
- [Augmentations](basic/augmentations.md)
- [Companies](basic/companies.md)
- [Factions](basic/factions.md)
- [Crimes](basic/crimes.md)
- [Infiltration](basic/infiltration.md)
- [Programs](basic/programs.md)
- [Reputation](basic/reputation.md)
- [Stock market](basic/stockmarket.md)
- [World](basic/world.md)
- [Coding contracts](basic/codingcontracts.md)
- [Autocomplete](basic/autocomplete.md)

## Game reference — advanced mechanics

- [List of factions and their requirements](advanced/faction_list.md)
- [BitNodes](advanced/bitnodes.md)
- BitNode recommendations: [short guide](advanced/bitnode_recommendation_short_guide.md) · [comprehensive guide](advanced/bitnode_recommendation_comprehensive_guide.md)
- [Source-Files](advanced/sourcefiles.md)
- [Gangs](advanced/gang.md) · [full gang guide](advanced/gang-guide.md)
- [Corporation](advanced/corporations.md) (deep dives under [corporation/](advanced/corporation/))
- [Intelligence](advanced/intelligence.md)
- [Bladeburner](advanced/bladeburners.md)
- [Hacknet servers](advanced/hacknetservers.md)
- [Sleeves](advanced/sleeves.md)
- [Grafting](advanced/grafting.md)
- [Stanek's Gift](advanced/stanek.md)

## Game reference — programming & API

- [NS API reference](programming/netscript-api-reference.md) — hand-written Netscript cheat sheet
  (full type defs in [`NetscriptDefinitions.d.ts`](NetscriptDefinitions.d.ts))
- [Hacking algorithms](programming/hacking_algorithms.md)
- [Offline scripts and bonus time](programming/offline_and_bonus_time.md)
- [IPvGO](programming/go_algorithms.md)
- [Darkweb network](programming/darknet.md)
- [Remote API](programming/remote_api.md)
- [Learn to program](programming/learn.md)
- [TypeScript and React](programming/typescript_react.md)
- [Game frozen or stuck?](programming/game_frozen.md)

## Game reference — API migration guides

Guides for updating scripts when the Netscript API changes between major versions.

- [Netscript 2 migration](migrations/ns2.md) — moving off the removed NS1 (`.script`) interpreter
- [v1.0.0 migration](migrations/v1.md)
- [v2.0.0 migration](migrations/v2.md)

## Help

- [Beginner's guide](help/getting_started.md)
- [Tools & resources](help/tools_and_resources.md)
- [FAQ](help/faq.md)
