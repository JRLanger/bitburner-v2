---
name: ship
description: Wrap up the current branch and get it merged — document changed scripts with /devlog, commit outstanding work, open a PR against main, merge it, and clean up merged branches. Use whenever the user says they want to "ship", "wrap up", "finish", "land", or "merge" the current branch, or asks to commit + PR + merge + clean up in one go.
---

# Ship the current branch

Take the work on the current branch from "done coding" to "merged and cleaned up".
Run the steps in order. The guiding principle: this is a hard-to-reverse, outward-facing
workflow (it publishes commits and merges to `main`), so move confidently on the routine
parts but **stop and ask the user** the moment something looks unexpected — uncommitted
work you didn't create, surprising diffs, conflicts, or failing checks. A wrong merge is
much more expensive than a pause.

## 0. Orient

Run these first so you know what you're working with:
- `git fetch origin` — do this **before** any comparison below. `main` here is a local
  ref that goes stale the moment anyone else pushes, and a stale base makes
  `git diff main...HEAD` report a branch scope that is simply wrong — usually by
  claiming work as this branch's that already landed. Compare against `origin/main`
  once fetched.
- `git branch --show-current` — confirm you're not on `main`. If you are, stop and ask
  the user which branch to ship; never PR `main` into itself.
- `git status` — see uncommitted/untracked changes.
- `git diff origin/main...HEAD --name-only` — see what this branch changed versus `main`.
- `git log origin/main..HEAD --oneline` — see commits that will go into the PR.

## 1. Devlog

For each **script** created or changed on this branch, invoke the `/devlog` skill to
create or update its `docs/scripts/<name>.md` doc. This keeps the per-script reference
current, which is a core project convention.

A script here means a file under `src/` that runs in game — anything under `src/`,
`src/managers/`, or `src/utils/` with a `main(ns)` export. Two things that are not
scripts and need no doc of their own: `src/config/constants.js`, and shared modules
under `src/lib/`. When a constant or a lib function changes behavior, update the doc
of each script that depends on it instead.

Also check for scripts that have **no** doc yet, not just ones whose doc went stale.
Compare the script files this branch touched against `docs/scripts/`. A brand-new
script is the most common gap, because nothing about it looks out of date.

Skip this step only when no scripts changed (a docs-only or config-only branch). If
unsure whether a change is significant enough to devlog, err toward updating it — a
stale doc is worse than a verbose one.

## 2. Commit outstanding work

Run `git status` again (the devlog step may have added files). If there are
uncommitted or untracked changes:
- Review them with `git diff` (and `git diff --staged`) so you understand what you're
  committing.
- Stage and commit with a clear message that matches the repo's style — look at recent
  `git log` for the format (this project uses prefixes like `pilot:`, `fix(scope):`,
  `lifecycle:`). End the commit message with a co-author trailer naming **the model
  running this session**, which your system prompt states:

  ```
  Co-Authored-By: Claude <model name> <noreply@anthropic.com>
  ```

  Read the current model name rather than copying one from a past commit. The history
  reflects whichever model was current at the time, so copying the previous line
  attributes new work to an older model and the error compounds every release.

**If anything in the working tree looks unrelated to this branch's work, or you didn't
create it, stop and ask before committing it.** Don't sweep up stray changes.

## 3. Syntax-check the changed scripts

Run `node --check` on every `.js` file this branch changed under `src/`:

```
git diff origin/main...HEAD --name-only --diff-filter=d -- 'src/*.js' | xargs -r -n1 node --check
```

Silence means every file parses. Any output names the file and line that failed, and
that is a stop — fix it before you push.

This repo has no CI, no test suite, and no build, so nothing else stands between a
typo and `main`. The check is cheap and catches the failure that hurts most: a syntax
error does not fail loudly at merge time, it fails in game on the next run, often
after a reset, when the script that was supposed to bring everything back up will not
parse.

Be clear about what this does not cover. `node --check` parses the file and nothing
more. It cannot see a wrong RAM assumption, a Netscript v3 function that no longer
exists, a bad import path, or any logic error. Those still need the game. Treat a
clean check as "this file is valid JavaScript", never as "this change works".

## 4. Push and open the PR

- Push the branch: `git push -u origin <branch>`.
- Open a PR against `main` with the `gh` CLI. Write a concise body summarizing what the
  branch does and why. End the PR body with:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

- If a PR for this branch already exists, reuse it (`gh pr view`) rather than opening a
  duplicate.

## 5. Merge

- If the repo has CI/status checks, wait for them to pass first (`gh pr checks`).
- Merge with squash and delete the remote branch:
  `gh pr merge --squash --delete-branch`.
- **If there are merge conflicts or failing checks, stop and tell the user** — report
  what failed and let them decide. Do not force the merge or push past red checks.

## 6. Clean up

After a successful merge:
- Switch to `main` and pull the latest: `git checkout main && git pull`.
- Delete the local branch that was just merged: `git branch -d <branch>`.
- Find any other fully-merged local branches and offer to delete them:
  `git branch --merged main` — never delete `main` itself, and never delete a branch
  that isn't fully merged (don't use `-D` to force). If several show up, list them and
  confirm with the user before deleting more than the one you just shipped.
- Prune stale remote-tracking refs: `git remote prune origin`.

## 7. Report

Summarize what happened at each step: the PR link, what was merged, and which branches
were deleted. If you paused anywhere, make clear what's still outstanding.
