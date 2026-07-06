# Implementation Plan: `stocks` — stock market manager (Roadmap 3.2)

Status: **planned, not started**. Written 2026-07-06 against v3.0.1 defs.
Prereq reading: `docs/plans/arbitration.md` (money classes, liquidation protocol).

## Goal

`src/managers/stocks.js`: park surplus money in the stock market for compound
returns, with 4S forecast data when owned and a pre-4S abstention policy (do
nothing rather than trade blind). Never-exit manager, status port 9.

## API (verified in NetscriptDefinitions.d.ts, namespace `ns.stock.*`)

`hasWseAccount()`, `hasTixApiAccess()`, `purchaseWseAccount()`, `purchaseTixApi()`,
`getSymbols()`, `getPrice/getAskPrice/getBidPrice(sym)`, `getPosition(sym)` →
`[sharesLong, avgLongPrice, sharesShort, avgShortPrice]`, `getMaxShares(sym)`,
`buyStock/sellStock/buyShort/sellShort(sym, shares)`, `getForecast(sym)` (4S),
`getVolatility(sym)` (4S), `getConstants()`, `await nextUpdate()`.
4S data/API access: check via a `ns.stock.has4SDataTIXAPI()`-style call — **verify
exact name in defs when coding** (search "4S" in NetscriptDefinitions.d.ts); buying
4S market data + 4S TIX API is part of phase 0 below.
Shorts require BN8 or SF8.2 — feature-detect by try/catch on first `buyShort`,
remember result in a local var.

## Design decisions (recorded)

1. **No pre-4S trading.** Price-history inference is noisy and loses money at small
   scale; the manager's pre-4S job is only to *save up and buy access*. Simpler and
   safer for a first implementation; a pre-4S momentum strategy can be a later
   devlog stage if wanted.
2. **Forecast-threshold strategy (standard, effective):** long when
   `forecast > 0.55 + spreadComp`, short (if available) when `< 0.45 - spreadComp`,
   close when forecast crosses back over 0.5. `spreadComp` compensates the ~1%
   bid/ask spread + $100k commission: only enter when expected edge over
   `STOCK_MIN_HOLD_TICKS` exceeds round-trip cost.
3. **Position sizing:** allocate up to `STOCK_CAPITAL_FRAC = 0.8` of money above
   `STOCK_MONEY_FLOOR` (constant, e.g. $1b — keeps pserver/pilot liquid), spread
   across qualifying symbols by `|forecast − 0.5| × volatility` weight, capped at
   `getMaxShares(sym)` and `STOCK_MAX_POS_FRAC = 0.25` of portfolio per symbol.
4. **Tick on `await ns.stock.nextUpdate()`** (arbitration exception #4) with 30 s
   `Promise.race` guard — trades exactly on market updates (~6 s, or ~4 s with
   bonus time).
5. **Liquidation flag is mandatory:** every loop iteration first checks
   `getFlag(ns,'liquidate')`; if set → sell everything (longs and shorts), publish
   `{liquidated: true}`, then idle until flag clears (post-reset it auto-clears).
6. **Equity reporting:** status includes `equity` (mark-to-market via
   `getSaleGain`), `profitSinceStart`, positions summary. Lifecycle/dashboard use
   `money + equity` as net worth (arbitration Decision 2.4).

## Gate & lifecycle

- Gate (controller `launchManagers()`): `hasWseAccount() && hasTixApiAccess()`, OR
  money > `STOCK_BOOTSTRAP_MONEY` (enough to buy both: ~$26b total including 4S;
  buy-in sequence is phase 0 of the loop, so gate = money threshold alone is fine —
  keep it simple: gate on money > STOCK_BOOTSTRAP_MONEY or access already owned).
- Phase 0 inside the loop: buy WSE account → TIX API → 4S data → 4S TIX API in
  order as affordable under `MECH_SPEND_FRAC`-style capping (these are one-time
  purchases from the Progression class; use `PILOT_SPEND_FRAC` cap).
- Never exits. `MECHANIC_ENABLE` gating per bitnode-strategy.md (BN8: stocks are
  the whole game; elsewhere: on).

## Loop pseudocode

```
loop:
  await race(ns.stock.nextUpdate(), sleep(30_000))
  if flag('liquidate'): sellAll(); publish({liquidated:true}); continue
  if !fullAccess: phase0BuyAccess(); publish(); continue
  for sym of getSymbols():
    f = getForecast(sym); pos = getPosition(sym)
    if pos.long  && f < 0.5 + STOCK_EXIT_BAND: sellStock(all)
    if pos.short && f > 0.5 - STOCK_EXIT_BAND: sellShort(all)
  budget = capital available (per sizing rule 3)
  candidates = symbols ranked by |f-0.5|*volatility where edge > cost hurdle
  enter positions until budget exhausted
  publish status
```

## Constants (port 9)

```js
export const STATUS_PORT_STOCKS = 9;
export const STOCK_BOOTSTRAP_MONEY = 30e9;
export const STOCK_MONEY_FLOOR = 1e9;
export const STOCK_CAPITAL_FRAC = 0.8;
export const STOCK_MAX_POS_FRAC = 0.25;
export const STOCK_ENTRY_FORECAST = 0.55;
export const STOCK_EXIT_BAND = 0.02;
export const STOCK_MIN_HOLD_TICKS = 20;
```

## Station synergy (later)

When station's `STATION_STOCK_AWARE` lands (station plan §4), stocks publishes held
symbols + direction; station passes `stock:true` on hack/grow against servers whose
`getOrganization(sym)` matches. No changes needed here beyond the status field.

## Testing

1. Gate: below threshold → not launched; force-run → phase-0 only, no trades.
2. With 4S: paper-check three ticks of decisions in the log before enabling real
   sizing (add `STOCK_DRY_RUN = true` constant for first deploy — log intended
   trades without executing; flip off after review).
3. Liquidation: set flag manually → all positions closed within one tick, ack seen.
4. Profit tracking survives manager restart (recompute from positions, don't trust
   in-memory state).

## Docs

`docs/scripts/stocks.md` + devlog stage on strategy choice (record decision #1).
