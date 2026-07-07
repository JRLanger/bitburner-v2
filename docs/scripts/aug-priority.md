# aug-priority

**Location:** `src/config/aug-priority.js`

## What it does

A **generated, 0-GB data module** that defines which augmentations are "priority tier" and
their base prices. Consumed by `managers/pilot.js` (grind ordering + acquirable-count) and
`managers/lifecycle.js` (batch-buy ordering at reset).

Two exports:
- `PRIORITY_AUGS` — a `Set` of the ~66 augs in the priority tier: category **Hacking** or
  **Special**, or any aug granting a **faction-reputation** bonus (`faction_rep`). NeuroFlux
  Governor is excluded (repeatable; owned by lifecycle's pre-reset dump).
- `AUG_BASE_PRICE` — a `name → base price` map for all 137 augs. Pilot uses it as a cheap
  proxy for the money-side of its ETA/acquirable math, avoiding a live `getAugmentationPrice`
  call (2.5 GB) in its hot path. `BigD's Big ... Brain` is priced `Infinity` (never
  affordable) — emitted as the JS literal, not a bare `inf`.

## How it works

Generated from `docs/reference/augmentations.json` (the complete v3.0.1 aug dataset,
verified 1:1 against the game's `AugmentationName` enum). The category classification is the
same one used to build `docs/reference/augmentations.xlsx`. Regenerate with the Python
snippet recorded in the session that created it (reads the JSON, tiers by category/`faction_rep`,
emits the two exports).

## Why it's built this way

Deriving the tier offline from shipped data means pilot/lifecycle never pay the RAM of
`getAugmentationStats` at runtime. It's a single **global** priority order for all BitNodes —
`aug-priority.js` is **hand-editable** (promote/demote a specific aug, or fork per-BitNode
later), which is the documented hook for tuning. See `docs/plans/arbitration.md` Decision 5.
