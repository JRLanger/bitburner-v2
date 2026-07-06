# Implementation Plan: `corp` — corporation manager

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md`. Relevant in BN3 (win condition) and
with SF3 elsewhere as the biggest late-game money printer.

**Scope warning (recorded decision):** the corporation API
(`ns.corporation.*`, interface `Corporation extends WarehouseAPI, OfficeAPI` —
hundreds of functions) is by far the largest subsystem in the game. Do NOT attempt
full optimization in v1. This plan is a deliberately simple two-phase corp that
reaches self-sustaining dividends; advanced play (product cycling, investment-round
timing tricks, TA.II pricing) is explicitly deferred to a later devlog stage.

## v1 goal

`src/managers/corp.js`, port 13, never-exit. Phases:

**Phase A — found & bootstrap (Agriculture):**
1. Found: `createCorporation('<name>', selfFund)` — in BN3 self-fund can be false
   (government seed); elsewhere requires $150b self-fund. Gate: runtime flag
   `corpStart` armed by player via `utils/corp-start.js` one-shot (One-shot seeds
   class, arbitration Decision 2 — $150b is never spent automatically).
2. Expand into **Agriculture** division, all 6 cities; buy warehouses.
3. Hire 3 employees/office (Operations/Engineer/Business 1/1/1), buy
   `Smart Supply` unlock and enable it.
4. Buy production-boost materials per warehouse (Real Estate primarily —
   exact amounts: use the well-known ratios, tune in game; record in script doc).
5. Sell Plants + Food at `MAX`/`MP`.
6. Grow offices/warehouses under a per-tick spend cap while profitable.

**Phase B — dividends:**
Once profit is stable and positive for `CORP_STABLE_TICKS`: `issueDividends(rate)`
with `CORP_DIVIDEND_RATE = 0.1` (10% — keeps 90% compounding internally).
Corp money is otherwise unreachable; dividends are how the corp feeds pserver/
pilot/stocks. Raise rate late-run via constant if the wallet is the bottleneck.

**Not in v1 (recorded):** investment rounds beyond what bootstrap requires (take
round 1 only if funds run dry in Phase A), Tobacco/product divisions, research
beyond Market-TA when trivially affordable, going public beyond what dividends
require (verify: dividends require going public — `goPublic(shares)`; if so, go
public with 0 shares issued... **verify exact mechanism in defs at implementation**;
the API has `issueDividends`, `goPublic`, `bribeFaction`).

## Tick & structure

Corp state changes on its own cycle: `await ns.corporation.nextUpdate()`
(race-guarded). Keep per-tick work tiny: one growth step per tick (one office
upgrade OR one warehouse level OR one material top-up), cheapest-need-first. All
state read fresh from `getCorporation()` / `getDivision()` / `getOffice()` /
`getWarehouse()` — nothing in memory.

## Status (port 13)

`{ ts, phase: 'idle'|'bootstrap'|'dividends', funds, profit, dividendsPerSec,
divisions, alert }` — `alert` carries "corpStart not armed; run corp-start.js when
you want a corp ($150b)" outside BN3.

## Gate & constants

Gate: `MECHANIC_ENABLE[bn].corp` && (`inCorporation()`-style check — verify name;
or flag `corpStart` armed && money > $150b in non-BN3).

```js
export const STATUS_PORT_CORP = 13;
export const CORP_DIVIDEND_RATE = 0.1;
export const CORP_STABLE_TICKS = 30;
export const CORP_SPEND_STEP_FRAC = 0.2;   // of corp funds per growth step
```

## BN3 note

In BN3, corp IS the win condition path (money for the augs/daedalus route is corp
money) — `MECHANIC_ENABLE[3]` puts corp first and pilot's ladder deprioritizes
faction grinding until dividends flow. Details in bitnode-strategy.md.

## Testing

1. Non-BN3 without flag: manager idles with alert, founds nothing.
2. BN3/armed: Phase A reaches positive profit on Agriculture alone.
3. Dividends: rate applied once stable; wallet receives income (visible in
   dashboard net worth).
4. Restart: manager resumes mid-phase from live corp state.
5. RAM: corp API calls are pricey (~1 GB each) — keep distinct calls minimal,
   `mem` check against home budget.

## Docs

`docs/scripts/corp.md` + devlog stage; explicitly log what v1 skips and why.
