# Implementation Plan: `stanek` + grafting support

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Two small systems sharing port 14; both optional-tier.

## Part 1 — Stanek's Gift (`src/managers/stanek.js`)

Relevant with BN13/SF13. The Gift is a grid of fragments that must be *charged* by
running `chargeFragment` — which consumes **RAM threads**, competing with batching.

### Decisions (recorded)

1. **Layout is manual.** Fragment placement is a spatial puzzle with
   playstyle-dependent choices (hacking-mult fragments for this project). The
   manager does NOT auto-place; it charges whatever the player placed. If
   `activeFragments()` is empty → status alert "place fragments in the Gift", idle.
   (`acceptGift()` is also manual/player-consent: it permanently occupies an aug
   slot — alert, don't act.)
2. **Charging uses the controllers' share seam.** Charging and `share()` are both
   "dump spare RAM" activities. Controller change: the share phase becomes a
   two-way split governed by runtime flag `stanekFrac` (0 → all share, as today).
   The stanek manager sets `stanekFrac = STANEK_CHARGE_FRAC` (0.5) while any
   placed fragment's charge is below `STANEK_CHARGE_TARGET` saturation, else 0.
   A dedicated worker `src/workers/charge.js` (mirrors share.js:
   `await ns.stanek.chargeFragment(x, y)` in a loop over assigned fragment) is
   exec'd by the **controller** exactly like share workers. Charging effectiveness
   scales with threads-per-call, so prefer few large workers over many small
   (charge worker takes threads implicitly via exec threads — same as share).
3. Manager itself is tiny: watches `activeFragments()` charge levels, sets the
   flag, publishes status. Loop `STANEK_LOOP_SLEEP = 30_000`.

### API (verified, `ns.stanek.*`)

`acceptGift()`, `giftWidth()/giftHeight()`, `fragmentDefinitions()`,
`activeFragments()` (includes charge levels), `canPlaceFragment()`,
`placeFragment()`, `removeFragment()`, `chargeFragment(x, y)` (async),
`clearGift()`.

### Constants

```js
export const STATUS_PORT_STANEK = 14;
export const STANEK_LOOP_SLEEP = 30_000;
export const STANEK_CHARGE_FRAC = 0.5;
export const STANEK_CHARGE_TARGET = 100;  // avg charge level; tune in game
```

## Part 2 — Grafting (extends pilot, no new manager)

Relevant with SF10/BN10 (VitaLife). Grafting installs augs with money + player
time, without a reset — useful when faction progress has stalled.

### Decisions (recorded)

1. **No separate manager.** Grafting is a player-focus activity → it lives in
   pilot as ladder row 5 (arbitration doc): applicable when no rep-locked wanted
   aug is reachable within `GRAFT_PATIENCE_MS` and money comfortably covers
   `getAugmentationGraftPrice` under the Progression spend cap.
2. **Target selection:** graftable augs (`getGraftableAugmentations()`)
   intersected with pilot's want-list scoring; prefer hacking-mult augs; skip augs
   with graft time > `GRAFT_MAX_TIME_MS` (4 h) — long grafts block the focus
   ladder too long. (Entropy penalty per graft is acceptable; record in doc.)
3. Pilot runs `graftAugmentation(aug, false)` and treats it like any focus-owned
   work; `waitForOngoingGrafting()` is NOT awaited in the loop (it would block the
   tick) — poll `getCurrentWork()` instead, standard pilot behavior.

### API (verified, `ns.grafting.*`)

`getGraftableAugmentations()`, `getAugmentationGraftPrice(aug)`,
`getAugmentationGraftTime(aug)`, `graftAugmentation(aug, focus?)`,
`waitForOngoingGrafting()`.

### Constants

```js
export const GRAFT_MAX_TIME_MS = 4 * 3600_000;
// GRAFT_PATIENCE_MS already defined in arbitration constants.
```

## Testing

1. Stanek: no fragments → alert only. Place fragments → `stanekFrac` set, charge
   workers appear in controller pool, share shrinks accordingly; charge target
   reached → flag drops to 0, share returns.
2. Controller regression: `stanekFrac = 0` path must be byte-identical to current
   share behavior.
3. Grafting: stall faction progress artificially (blocklist all factions) →
   pilot picks a graft; finish → normal ladder resumes.

## Docs

`docs/scripts/stanek.md`; grafting folded into `docs/scripts/pilot.md`; devlog
stage covers the share/charge RAM-split design.
