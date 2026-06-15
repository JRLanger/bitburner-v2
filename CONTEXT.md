# Context for Claude

This is a from-scratch rewrite of Bitburner automation scripts, started 2026-06-15.

## Background

The user has an existing, more advanced Bitburner project at
`/Users/jrlanger/Documents/Claude/Projects/Bitburner` with years of accumulated scripts.
That project has grown organically and become hard to follow.

## What this project is

- A brand new save game, scripts rewritten from scratch
- Reference only the in-game docs / Netscript API definitions — do NOT copy code from
  the old project, even if asked to look at it for inspiration
- The user is new to coding and to git/GitHub — explain things in beginner-friendly terms,
  walk through git commands step by step rather than assuming familiarity

## Documentation goal

The user wants to extensively document the process as we go: the logic behind each script,
how it works, and why design decisions were made. Write a devlog entry (in `docs/devlog/`)
for each meaningful script or decision — see `docs/devlog/00-intro.md` for the format.

## Status so far

- Git repo initialized, first commit made (project skeleton: README, .gitignore, devlog intro)
- GitHub repo not yet created/connected
- No scripts written yet — next step is to pick the first script to write for a new save
  (commonly something like an initial hacking/automation script) and start documenting it
