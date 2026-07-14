# Implementation Plan: Donation sizing — donate exactly what unlocks a purchase

Status: **IMPLEMENTED 2026-07-13** (same day as written; not yet RAM-measured in-game). Written 2026-07-13 against Netscript v3.0.1 defs.
Implementation order: **3rd of the six-change batch** (after wallet-reservations;
the in-run donation bound reads the generalized moneyFloor).

## Goal

Two donation paths currently burn unbounded money on faction reputation:

1. **Pilot in-run** (`startFactionWork`, pilot.js): when the target faction's favor
   clears `getFavorToDonate()`, pilot donates `money × PILOT_SPEND_FRAC` **every
   tick** — half of all money, forever, even long after the target aug's rep is met.
2. **Lifecycle at reset** (`dumpNeuroflux` + `spendDown`): the NF dump stops at the
   rep cap and `spendDown` then donates literally everything to the highest-favor
   faction — even when a sized donation could have unlocked more NF levels first.

Key game fact (game-mechanics.md rule 3): an install wipes money AND rep; only
**favor** persists. Rep beyond what gets *spent* (on an aug/NF unlock) is wasted
except for its favor contribution. So: donations should be **sized** to close a
specific rep gap that enables a specific purchase; the true residual at reset is
then donated for persistent favor (user decision 2026-07-13).

## API facts (verified in docs/reference/NetscriptDefinitions.d.ts — re-verify before coding)

- `ns.singularity.donateToFaction(faction, amount): boolean` (L2474).
- `ns.getFavorToDonate(): number` — donation only possible at/above this favor.
- `ns.formulas.reputation.repFromDonation(amount, player): number` (L6171) —
  requires Formulas.exe.
- Fallback closed form (verify in-game once): `rep = (amount / 1e6) ×
  player.mults.faction_rep`. Favor gates the *ability* to donate; it does not
  scale the conversion.

## Shared helper: `donationForRep(ns, repNeeded)`

New function (lives in pilot.js and lifecycle.js — or a small shared
`lib/donation.js`; decide at implementation time by RAM measurement, remembering
each distinct ns function is charged per script that references it):

```js
// Smallest donation that yields >= repNeeded reputation.
function donationForRep(ns, repNeeded) {
    if (ns.fileExists("Formulas.exe", "home")) {
        // binary search repFromDonation(amount, player) — exact under game changes
        // bounds: lo = 0, hi = repNeeded * 1e6 (generous), ~40 iterations
    }
    return (repNeeded * 1e6) / ns.getPlayer().mults.faction_rep; // closed form
}
```

Constant: `export const DONATE_SLOP = 1.001;` — multiply every sized donation by
this to absorb rounding, so one donation reliably closes the gap.

## Change 1 — lifecycle `dumpNeuroflux`: donate-exact-then-buy loop

Replace the plain buy loop with:

```
faction = highest-rep joined faction (unchanged selection)
canDonate = getFactionFavor(faction) >= getFavorToDonate()
loop (bounded, e.g. 1000):
  price  = getAugmentationPrice(NF)        // live — includes the ×1.9 ramp
  repReq = getAugmentationRepReq(NF)
  gap    = max(0, repReq - getFactionRep(faction))
  money  = getServerMoneyAvailable("home")
  if gap == 0:
      if price > money or !purchaseAugmentation(faction, NF): break
  else if canDonate:
      donation = donationForRep(gap) * DONATE_SLOP
      if price + donation > money: break   // can't afford unlock + buy → stop
      donateToFaction(faction, donation)
      if !purchaseAugmentation(faction, NF): break
  else: break                              // rep-capped, can't donate
```

Net effect: instead of "buy until rep cap, then donate everything", money is
converted into the *maximum number of NF levels*, each unlocked by an
exactly-sized donation.

## Change 2 — lifecycle `spendDown`: keep, clarify, keep last

Runs after the new NF loop. The residual by construction cannot buy another NF
level, so donating it to the highest-favor faction banks **persistent favor** —
that's now its explicit purpose. Rewrite its doc comment ("residual → favor for
future runs", not "money is meaningless post-reset") and keep
`LIFECYCLE_SPEND_DOWN = true`.

## Change 3 — pilot `startFactionWork`: one sized donation, not a drip

Current: `amount = min(snap.money * PILOT_SPEND_FRAC, snap.money)` every tick.
New:

```js
const gap = Math.max(0, sing.getAugmentationRepReq(target.aug) - sing.getFactionRep(target.faction));
if (gap === 0) return sing.workForFaction(...);  // rep met — nothing to donate for
const amount = Math.min(snap.money * PILOT_SPEND_FRAC, donationForRep(ns, gap) * DONATE_SLOP);
if (amount > 0) sing.donateToFaction(target.faction, amount);
```

- Sized to the *current target aug's* remaining rep gap — once the gap closes,
  subsequent ticks donate 0 and pilot proceeds to work/next target.
- Still capped by `PILOT_SPEND_FRAC` per tick (a huge gap is closed over several
  ticks rather than in one wallet-emptying donation).
- `snap.money` is already net of moneyFloor + reservations (wallet-reservations
  plan), so donations can never eat the reserved aug batch.
- NF grind targets stay excluded from donation (existing rule — that cash is the
  NF dump's).

## Testing checklist

1. In-run: set a rep-locked target at a high-favor faction; confirm exactly
   enough is donated (rep lands just past the requirement), then donations stop.
2. Reset: arm auto-install with high favor + surplus money; confirm the NF dump
   alternates donate/buy and ends with more NF levels than the old code, and that
   `spendDown` gets only the true residual.
3. No Formulas.exe: confirm the closed-form fallback sizes within a few % (log
   predicted vs. actual rep gained once, in-game).
4. Low-favor faction: confirm behavior degrades to today's (work only / buy-only
   NF dump, no donations).

## Documentation deliverables

- Amend `docs/plans/reset-lifecycle.md` checklist steps 1–2 (done alongside this
  plan).
- `/devlog` updates for `docs/scripts/lifecycle.md` and `docs/scripts/pilot.md`
  when implemented.
