# force-install

**Location:** `src/utils/force-install.js`

## What it does

Triggers the full pre-reset augmentation-install sequence on demand, instead of
waiting for lifecycle to decide an install is worth it.

The script sets one runtime flag and exits. It never installs anything itself.
`lifecycle.js` reads the flag at the top of its next tick and runs its complete
pre-reset checklist: freeze spending, batch-buy every rep-met augmentation
(priority tier first, most expensive first), dump NeuroFlux levels, donate to close
each level's rep gap where favor allows, spend leftover money to favor, write the
run log, then call `installAugmentations("boot.js")`.

**This is destructive. It ends the current run.** There is no confirmation prompt
and no undo. Run it only when a reset is wanted right now.

Run from the terminal:

```
run /utils/force-install.js
```

## How it works

**Set the flag.** `setFlag(ns, "forceInstall", true)` writes into the shared flag
port through `lib/flags.js`. The whole port is one object, and `setFlag` preserves
every other key.

**Tell the player what will happen.** The script reads `ns.ps("home")` and looks for
`LIFECYCLE_MANAGER` to decide which of two messages to print.

- lifecycle is running: the checklist starts within one tick, at most
  `LIFECYCLE_LOOP_SLEEP` (60 s) away. The message says plainly that the run will
  reset and that no further confirmation follows.
- lifecycle is not running: the message is a warning. The flag stays armed and
  fires whenever lifecycle next launches, which needs the SF4 gate to pass. The
  warning names the two ways out — reset, or start lifecycle and let it consume
  the flag.

**Path normalization.** `ns.ps()` reports filenames without a leading slash
(`managers/lifecycle.js`), but `LIFECYCLE_MANAGER` is `/managers/lifecycle.js`. The
script strips the leading slash from both sides before it compares them. This is
the same normalization booster and orbiter do through their `stripSlash` helper.

**What lifecycle does with the flag** (`lifecycle.js` lines 78-91): it clears the
flag *before* it runs the checklist, not after. Order matters here. A forced
install with nothing queued to buy is a no-op, and if the flag were cleared
afterward the no-op would re-arm itself and re-fire on every tick forever. Clearing
first also means a successful reset never lands with the flag still set.

The forced path bypasses both gates a normal install must pass:

| Gate | Normal install | Forced install |
|---|---|---|
| Decision thresholds (`computeDecision`) | must fire | skipped |
| Autonomy guard (`LIFECYCLE_AUTO_INSTALL` or the `autoInstall` flag) | must be armed | skipped |

**RAM.** 1.8 GB — 1.6 GB base plus 0.2 GB for `ns.ps`. Every port operation
(`peek`, `writePort`, `clearPort`) that `lib/flags.js` uses costs 0 GB, so the
import adds nothing.

## Why it's built this way

**The work lives in lifecycle, not here.** This is the central decision, and it is
about RAM. The checklist runs on `ns.singularity.*` calls, and those carry the
×16/×4/×1 SF4 multiplier described in `docs/reference/game-mechanics.md` section 5.
`lifecycle.js` already pays that bill in its own running process. A standalone
script that duplicated the checklist would pay the entire multiplied cost a second
time, for a job that runs for a few seconds and then destroys the process anyway.
Routing through a flag keeps this script at 1.8 GB.

**A flag, not a port message or a file.** Flags in `lib/flags.js` are wiped on every
reset, because the game wipes ports on both restart and aug reset. That is the right
lifetime for this signal. A forced install is meaningful only within the run that
asked for it, so a flag that cannot survive the reset it causes removes a whole class
of bug — no stale trigger fires on the next run, and nothing has to detect the reset
to clean up.

**One tick of latency is acceptable.** Lifecycle ticks every 60 s, so a forced
install waits up to a minute. Killing lifecycle and restarting it would fire sooner,
but the wait costs nothing against a run measured in hours, and it keeps the trigger
path down to a single flag write.

**The checklist is reused, not reimplemented.** The forced path calls the same
`runChecklist` a normal auto-install calls, with a different `reason` string. The
buy ordering, the NeuroFlux dump, the rep donations and the favor spend-down are
subtle and already tested. A second copy would drift from the first.

**It reports state instead of guarding it.** The script could refuse to run when
lifecycle is down. It warns instead, because the flag genuinely does still work —
it waits. Refusing would be wrong, and silence would be worse, because the player
would see nothing happen for an unknown length of time and could not tell an armed
flag from a failed command.

## Alternatives considered

**Do the install here.** Rejected on RAM, as above. This is the reason the script
exists in its current shape rather than as a real implementation.

**Kill and relaunch lifecycle to skip the 60 s wait.** Rejected. It trades a
guaranteed-correct one-minute wait for a restart that has to reload state, and the
wait does not matter at this timescale.

**Add a confirmation prompt.** Rejected. `ns.prompt` costs RAM and blocks, and the
script is already an explicit deliberate command typed by the player. The
destructive warning lives in the printed message and in the file header instead.

**A dedicated port or a marker file.** Rejected. `lib/flags.js` already exists, costs
0 GB, is shared by every manager, and has exactly the per-run lifetime this needs.

## Known drift

The file header calls this "a tiny 0-GB flag-setter". That was true before the
`ns.ps` liveness check was added. The real cost is 1.8 GB. The claim in the header
should be corrected the next time this file is touched.
