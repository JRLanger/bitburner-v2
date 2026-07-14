# Game mechanics that scripts MUST get right

**Read this before writing or reviewing any script in this project.** These are
verified Bitburner (v3.0.1) engine behaviors that are easy to assume wrong and that
have already caused (or nearly caused) bugs. Unlike the rest of `docs/reference/`,
this file is project-maintained — add an entry whenever a session learns a mechanic
the hard way.

## 1. Script RAM is STATIC — tick rate and call frequency are irrelevant

A script's RAM cost is computed **once, from its source text**: the sum of the costs
of every *distinct* `ns.*` function referenced anywhere in the file (and its
imports). Consequences:

- Calling a function 1× or 1000× per second costs the same RAM. **Slow tick loops
  do NOT save RAM** — they only save CPU and make behavior easier to follow.
- A function that is referenced but **never called** (dead branch, unused helper)
  is still charged.
- A **variable or property named after an NS function** can be charged too — never
  name a local `hack`, `scan`, `getServer`, etc. (this bit us once already).
- Adding ONE new `ns` function to an existing script adds its full cost to that
  script. For `ns.singularity.*` that cost is multiplied ×16/×4/×1 by SF4 level —
  so the real RAM question is always "which *script* should own this function?",
  never "how often do we call it?".
- Port functions (`peek`, `writePort`, `clearPort`, `readPort`) and a few others
  cost **0 GB** — which is why `lib/flags.js` and `lib/status.js` are free to
  import from anywhere.
- Measure with `mem <script>` in-game after adding/removing NS functions, and keep
  the `*_MANAGER_RAM` constants in `config/constants.js` in sync.

## 2. Ports are wiped on every reset

Any reset (aug install, soft reset, game restart) clears all Netscript ports.
Therefore everything on the flag port (port 1) and the status ports is
**automatically per-run** — no reset detection or cleanup is ever needed for
port-held state. State that must survive resets goes in files (e.g.
`/data/lifecycle-log.txt`, `/data/bn-durations.json`).

## 3. What an aug install wipes vs. what persists

`installAugmentations` resets: money, faction **reputation**, hacking/combat
levels, all running scripts, purchased servers... but **faction FAVOR persists**
(and grows from the rep earned during the run), as do installed augs, home
RAM/cores, and files on home.

Practical rule: at reset time, leftover money converted into *rep* evaporates;
converted into *favor* (via donations that push next-run favor) or *NF levels /
augs* it persists. Donations should therefore be **sized** to unlock a specific
purchase, never open-ended — excess rep beyond what gets spent is pure waste
except for its favor contribution.

## 4. Purchased augs are inert until installed; prices ramp per purchase

- A purchased-but-not-installed aug does nothing. Buying early gives zero benefit.
- Every aug purchase multiplies the price of **all** subsequent aug purchases by
  ~×1.9 (`AUG_PRICE_RAMP` in constants.js). Buy most-expensive-first, in one batch,
  right before the install (arbitration.md Decision 5).
- NeuroFlux Governor: each level multiplies BOTH its own price and its rep
  requirement by ~×1.14 (`NF_LEVEL_MULT` in pilot.js), *in addition to* the ×1.9
  purchase ramp applying to it like any aug.

## 5. Singularity RAM multiplier

Every `ns.singularity.*` function's RAM cost is multiplied by SF4 level:
×16 (SF4.1), ×4 (SF4.2), ×1 (SF4.3). This is why the singularity surface is
concentrated in pilot.js/lifecycle.js and never imported into the controllers —
see rule 1: the multiplier applies per *referenced function per script*.

## 6. Netscript v3 API drift

Functions get removed/renamed across major versions (e.g. purchased servers moved
to `ns.cloud.*` in 3.0.0). Always confirm a function exists in
`NetscriptDefinitions.d.ts` in this folder before using it — never trust memory of
the older API. Migration notes: `migrations/`.
