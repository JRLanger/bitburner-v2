---
name: devlog
description: Scaffold a new devlog entry in docs/devlog/ for a script or design decision. Use when the user asks to write up, document, or log a devlog entry for something just built or decided.
---

# Devlog entry skill

Creates a new numbered devlog entry in `docs/devlog/`, following the format
established in `docs/devlog/00-intro.md`.

## Steps

1. List existing files in `docs/devlog/` and find the highest-numbered entry
   (e.g. `00-intro.md`, `01-foo.md` → next number is `02`).
2. Slugify the title argument (lowercase, spaces → hyphens, strip punctuation) to build
   the filename: `docs/devlog/NN-<slug>.md` (zero-padded two-digit number).
3. Create the file with this structure, using today's date and filling in each section
   based on the conversation context about what was just built/decided. Do not leave
   placeholder text — write real content. If something genuinely isn't applicable
   (e.g. no real alternatives were considered), say so briefly rather than omitting the
   section.

```markdown
# Devlog NN — <Title>

**Date:** <YYYY-MM-DD>

## Why

<What problem or need this addresses — what prompted this script/decision.>

## What

<What was built: script name(s), location under src/, what it does.>

## How it works

<Brief walkthrough of the logic/approach.>

## Alternatives considered

<Other approaches considered and why this one was chosen instead.>
```

4. After creating the file, tell the user the filename and give a one-line summary of
   what was recorded.
