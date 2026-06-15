---
name: devlog
description: Create or update the per-script documentation file in docs/scripts/ for a script. Use when the user asks to write up, document, or log a script that was just created or changed.
---

# Script documentation skill

Maintains one documentation file per script in `docs/scripts/`, explaining what the
script does and why it's built that way — meant as a reference for when the script
needs to change later.

## Steps

1. Determine the script name (e.g. `controller` for `src/controller.js`).
2. Check if `docs/scripts/<script-name>.md` already exists.
   - If it doesn't exist, create it using the structure below.
   - If it exists, update it in place to reflect the current state of the script —
     rewrite the relevant sections rather than appending a changelog.
3. File structure:

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

4. Fill in each section with real content based on the conversation context about the
   script — do not leave placeholder text.
5. After creating or updating the file, tell the user the filename and a one-line
   summary of what was recorded or changed.

## Note

`docs/devlog/` is a separate, chronological log of overall project decisions (see
`docs/devlog/00-intro.md`) and is not affected by this skill.
