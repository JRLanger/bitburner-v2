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
- `git branch --show-current` — confirm you're not on `main`. If you are, stop and ask
  the user which branch to ship; never PR `main` into itself.
- `git status` — see uncommitted/untracked changes.
- `git diff main...HEAD --name-only` — see what this branch changed versus `main`.
- `git log main..HEAD --oneline` — see commits that will go into the PR.

## 1. Devlog

For each **script** that was created or changed on this branch (look at the changed
files under `src/`), invoke the `/devlog` skill to create or update its
`docs/scripts/<name>.md` doc. This keeps the per-script reference current, which is a
core project convention.

Skip this step only when no scripts changed (e.g. a docs-only or config-only branch).
If unsure whether a change is significant enough to devlog, err toward updating it —
a stale doc is worse than a verbose one.

## 2. Commit outstanding work

Run `git status` again (the devlog step may have added files). If there are
uncommitted or untracked changes:
- Review them with `git diff` (and `git diff --staged`) so you understand what you're
  committing.
- Stage and commit with a clear message that matches the repo's style — look at recent
  `git log` for the format (this project uses prefixes like `pilot:`, `fix(scope):`,
  `lifecycle:`). End the commit message with:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

**If anything in the working tree looks unrelated to this branch's work, or you didn't
create it, stop and ask before committing it.** Don't sweep up stray changes.

## 3. Push and open the PR

- Push the branch: `git push -u origin <branch>`.
- Open a PR against `main` with the `gh` CLI. Write a concise body summarizing what the
  branch does and why. End the PR body with:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

- If a PR for this branch already exists, reuse it (`gh pr view`) rather than opening a
  duplicate.

## 4. Merge

- If the repo has CI/status checks, wait for them to pass first (`gh pr checks`).
- Merge with squash and delete the remote branch:
  `gh pr merge --squash --delete-branch`.
- **If there are merge conflicts or failing checks, stop and tell the user** — report
  what failed and let them decide. Do not force the merge or push past red checks.

## 5. Clean up

After a successful merge:
- Switch to `main` and pull the latest: `git checkout main && git pull`.
- Delete the local branch that was just merged: `git branch -d <branch>`.
- Find any other fully-merged local branches and offer to delete them:
  `git branch --merged main` — never delete `main` itself, and never delete a branch
  that isn't fully merged (don't use `-D` to force). If several show up, list them and
  confirm with the user before deleting more than the one you just shipped.
- Prune stale remote-tracking refs: `git remote prune origin`.

## 6. Report

Summarize what happened at each step: the PR link, what was merged, and which branches
were deleted. If you paused anywhere, make clear what's still outstanding.
