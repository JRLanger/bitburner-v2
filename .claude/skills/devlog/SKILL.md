---
name: devlog
description: Create or update the per-script documentation file in docs/scripts/ that records what a script does, how it works, and why it is built that way. Use this whenever a script under src/ is created, rewritten, or changed in a way that affects its behavior or design — and whenever the user says devlog, document this script, write this up, update the docs, or log what we just did. Also use before shipping or opening a PR that touches a script, so its doc does not go stale.
---

# Script documentation skill

Maintains one documentation file per script in `docs/scripts/`, explaining what the
script does and why it's built that way — meant as a reference for when the script
needs to change later.

## Writing style

Write all prose in this file using the `ste-writing` skill — invoke it before
drafting. In short: active voice, one idea per sentence, short common words, no
nominalizations or "-ing" main verbs, no marketing adjectives, and no semicolons.
Keep sentences long enough to read naturally. Code, identifiers, command syntax,
and RAM tables are exempt — do not rewrite them.

## Steps

1. Determine the script name (e.g. `controller` for `src/controller.js`).
2. **Read the script itself, in full**, plus `docs/reference/game-mechanics.md`.
   Do this even when the script was just written in this conversation — the doc must
   describe the code as it stands on disk, not as it was planned. `game-mechanics.md`
   corrects common wrong assumptions about the game engine (the static RAM model
   especially), so a doc written without it tends to explain the code with reasoning
   that is simply false. Also read the constants the script imports, so the doc names
   real values rather than guesses.
3. Skim two or three neighbouring files in `docs/scripts/` (`gang.md` and `boot.md`
   are good ones) to match the established format — bold run-in headers for phases,
   tables for RAM math, and a bias toward explaining *why* over restating the code.
4. Check if `docs/scripts/<script-name>.md` already exists.
   - If it doesn't exist, create it using the structure below.
   - If it exists, update it in place to reflect the current state of the script —
     rewrite the relevant sections rather than appending a changelog. Keep any
     reasoning that is still true, even where the code around it changed. That
     reasoning is the expensive part and is usually not recoverable from the diff.
5. File structure:

```markdown
# <script-name>

**Location:** `src/<path>`

## What it does

<Plain description of the script's purpose and behavior.>

## How it works

<Walkthrough of the logic/approach.>

## Why it's built this way

<Key design decisions and the reasoning behind them.>

## Alternatives considered

<Other approaches considered and why this one was chosen instead. If none were
seriously considered, say so briefly.>
```

6. Fill in each section with real content from the script you read and the
   conversation context — do not leave placeholder text. "Why it's built this way"
   is the section that earns the file's keep, so give it the most effort. Record the
   constraints and dead ends, not just the outcome.
7. After creating or updating the file, tell the user the filename and a one-line
   summary of what was recorded or changed.

## Note

`docs/devlog/` is a separate, chronological log of overall project decisions (see
`docs/devlog/00-intro.md`) and is not affected by this skill.
