# Progression Cycles & Reset Terminology

This doc defines the vocabulary we use to talk about progression and resets across
the project. Use these terms consistently in planning, code comments, and chat so
"which cycle/reset do you mean" never needs clarifying again.

See also: [Augmentations](../basic/augmentations.md) ·
[Source-Files](../advanced/sourcefiles.md) ·
[Augmentation Reset-Loop Strategy](augmentation-strategy.md).

## The two resets

| Reset | Trigger | Effect |
|---|---|---|
| **Soft reset** | Installing Augmentations | Wipes stats/skills, money, non-home scripts, purchased servers, hacknet nodes, faction/company rep (converted to favor), jobs, faction memberships, programs, TOR router, stocks, gang, bladeburner. **Keeps**: all previously-installed augments, home scripts, home RAM/cores, stock account + TIX API access. BitNode and Source-Files untouched. |
| **Hard reset** | Destroying (beating) a BitNode | Everything a soft reset does, **plus** wipes all installed augments and resets home RAM/cores to default. **Grants/upgrades a Source-File** for that BitNode — the one thing that persists forward into every future BitNode (permanent multipliers/unlocks, e.g. SF4 = Singularity API, SF5 = formulas.exe). |

A hard reset is a strict superset of a soft reset: same wipe, plus augments + home,
in exchange for a permanent Source-File upgrade.

## The three nested cycles

1. **Save game cycle** — the entire save, spanning every BitNode ever played.
   Progresses only via **Source-File levels**: permanent, game-wide multipliers and
   unlocks (extra hacking/crime speed, formulas.exe access, Singularity API, etc.)
   that never reset. This is the slowest layer — it only advances on a hard reset.

2. **BN cycle** — the gameplay between two hard resets (i.e. one playthrough of a
   single BitNode). Starts from zero augmentations and default home RAM/cores;
   everything (gang, bladeburner, augs, infrastructure) has to be rebuilt from
   scratch. Composed of a sequence of aug cycles. Early BN-cycle play is slow and
   grindy; late BN-cycle play is fast because augments, gang, and bladeburner are
   all highly developed.

3. **Aug cycle** — the gameplay between two soft resets, within a single BN cycle.
   Can last minutes to days. Progress within an aug cycle comes from scripts
   running (pservers/hacknet bought & upgraded, gang formed/running, etc.) *and*
   from the player's skills leveling up — e.g. an HGWG batch that takes minutes
   early in an aug cycle (low hack level) may take only seconds by the end of the
   same aug cycle (high hack level).

```
Save game cycle
└─ BN cycle (ends on hard reset, grants/upgrades a Source-File)
   └─ Aug cycle (ends on soft reset)
      └─ Aug cycle
      └─ ...
└─ BN cycle
   └─ Aug cycle
   └─ ...
```

## Why this matters for automation

- Code/managers that should persist knowledge **across hard resets** (e.g. Source-File
  driven feature gating) belong at the **save game cycle** level.
- Code/managers that should restart from scratch each BitNode but otherwise run for
  the whole BN belong at the **BN cycle** level.
- Code/managers concerned with the soft-reset loop itself (deciding when to install,
  what to buy first after a reset, etc.) belong at the **aug cycle** level.

When describing a bug, feature, or automation gap, specify which cycle/reset it
relates to (e.g. "the planner's aug-cycle exit condition" vs. "BN-cycle gang
bootstrap" vs. "save-cycle SF4 gating").
