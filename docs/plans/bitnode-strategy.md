# Plan: BitNode strategy — which mechanics run where, and in what order

Status: **planned, not started**. Written 2026-07-06. This is the top of the
decision stack: it configures the arbitration layer (`docs/plans/arbitration.md`)
per BitNode. Implemented as data in `src/config/constants.js`, consumed by
controller gates and pilot's ladder.

## Mechanism

```js
// constants.js — the ONLY BitNode-conditional logic in the codebase.
// Everything else reads these tables. bn = ns.getResetInfo().currentNode.
export const MECHANIC_ENABLE = {
  default: { gang: true, sleeves: true, stocks: true, bladeburner: false,
             corp: false, stanek: false, hacknet: true },
  // per-BN overrides merged over default, e.g.:
  2:  { gang: true, bladeburner: false },
  3:  { corp: true },
  6:  { bladeburner: true },
  7:  { bladeburner: true },
  8:  { stocks: true, hacknet: false, gang: false },
  13: { stanek: true },
};
export const ARBITRATION_LADDER_OVERRIDES = {
  // e.g. 6: ['bladeburner-first'] — named presets interpreted by pilot.
};
```

Availability still gates independently (SF ownership, API presence): the table
says "worth running", the manager's own gate says "possible". Both must pass.
`ns.getBitNodeMultipliers()` (needs SF5) refines decisions where available —
e.g. skip hacknet when `HacknetNodeMoney` mult is tiny; managers may consult it
opportunistically but must work without it.

## Per-BitNode playbooks (recorded decisions)

Win condition is always: augs → Daedalus → Red Pill → w0r1d_d43m0n (except BN6/7
alt path via final BlackOp, and BN8's stock focus). "Core stack" = controllers +
pserver + contracts + pilot + lifecycle + sleeves(if owned) + stocks(when rich).

| BN | Theme | Strategy emphasis | Notes |
|----|-------|-------------------|-------|
| 1 | Base | Core stack only. | Source of SF1 (start here — likely already done on this save). |
| 2 | Gang | Gang is ~all income; form ASAP (no karma req). Hacking still runs but multipliers are weak. Gang faction sells most augs — pilot's want-list naturally shifts there. | SF2 → gangs everywhere (karma path). |
| 3 | Corp | Corp is the economy; arm `corpStart` immediately (BN3 seed). Ladder deprioritizes faction grinding until dividends flow. | SF3 → corps everywhere. |
| 4 | Singularity | Nothing special: core stack, weak hacking mults. Get SF4.3 before leaving (×1 RAM on singularity is transformative for pilot/lifecycle). | **Highest priority SF for this project.** |
| 5 | Intelligence | Core stack; grind intelligence passively (crimes, infiltration is manual — skip). SF5 → getBitNodeMultipliers + intelligence stat. | |
| 6/7 | Bladeburner | Bladeburner ladder-first; hacking income funds augs. Win via final BlackOp (consent-gated `finish-bb.js`). SF7.3 notably strong. | Sleeves support via contracts. |
| 8 | Stocks | Money comes ONLY from stocks (hacking money mult ≈ 0, but hack/grow still move stock prices — station's stock-aware mode is the income engine). Gang/hacknet off. | Hardest economy; expect long run. |
| 9 | Hacknet | Hacknet servers (not nodes — they gain hash mechanics; **hacknet manager needs a hash-spend extension, plan when entering**: `ns.hacknet.spendHashes` etc. — verify API then). | |
| 10 | Sleeves | Buy all 6 sleeves + memory (persist!). Grafting available. | |
| 11 | Economy pain | Core stack, grind through. | |
| 12 | Recursion | Infinite levels; treat as quick SF farm with core stack. | |
| 13 | Stanek | Accept Gift early (consent), charge via RAM split. | |
| 14 (Go) | IPvGO | `ns.go.*` exists; **out of scope for full automation** — manual play or a later plan. | |

## Recommended BitNode order after BN1 (recorded, adjustable)

1. **BN4** until SF4.3 (three runs) — everything in this project's plans assumes
   cheap singularity; buy it first.
2. **BN5** (SF5.1) — getBitNodeMultipliers + intelligence unlocks smarter gates.
3. **BN2** (SF2.1+) — gang income floor everywhere.
4. **BN9** (SF9.1) — hacknet-server hashes are strong passive support.
5. **BN10** (SF10) — sleeves persist; then sleeves boost every later run.
6. **BN3** (SF3) — corp money end-game.
7. **BN6/7, 8, 11–13** — capability/completionist order per taste.

`utils/finish-bn.js` (lifecycle plan Part C) takes `nextBN` from the player; this
table is advice surfaced in its prompt text, not automation — BitNode choice stays
a human decision.

## Consequences for build order of the whole project

Plans should be BUILT in this order (each is independently useful):

1. pilot (docs/plans/pilot-singularity.md) — with arbitration ladder skeleton
2. lifecycle (reset-lifecycle.md) — closes the reset loop
3. arbitration completion + MECHANIC_ENABLE tables (arbitration.md, this file)
4. stocks (stocks.md) — pure money, no BN dependency
5. station (station-lategame-controller.md) — late-game throughput
6. sleeves (sleeves.md) — when SF10/BN10 reached (build earlier if desired; gate
   keeps it dormant)
7. gang (gang.md) — before entering BN2
8. bladeburner (bladeburner.md) — before entering BN6/7
9. corp (corporation.md) — before entering BN3
10. stanek (stanek-grafting.md) — before entering BN13
11. hacknet hash extension — before entering BN9 (plan to be written then)

## Docs

When each BN is entered, add a devlog entry recording deviations from this
playbook — this file is the plan, devlog records what actually worked.
