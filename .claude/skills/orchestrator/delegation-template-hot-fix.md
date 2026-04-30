# Hot-Fix Delegation Template

Use when delegating an urgent surgical bug fix — typically a symbol-level
bug surfaced post-merge that needs same-sprint resolution.

This template is an **index of existing rules that apply to hot-fix
delegation**. Most of its content is pointers — its purpose is to ensure
the Orchestrator pastes these reminders into the delegation prompt at
delegation time, rather than relying on the agent to discover them by
reading every rule from scratch.

## When NOT to use

- Multi-file refactors disguised as fixes
- Performance / behavior questions where the root cause is not yet established
- Anything requiring design discussion before code change

## Paste this block into "Key Implementation Notes"

### Hot-Fix Specific Guidance

Read these files before writing code:

- `.claude/rules/workflow.md` Testing Requirements — TDD for bug fixes (including the stash-polarity verification ritual)
- `.claude/rules/pre-pr-completeness.md` Question 3.5 — filesystem watcher sibling check (only if the fix touches `fs.watch` / `chokidar`)
- `CLAUDE.md` "Avoid over-engineering" — surgical scope reminder

### Procedure

1. **Reproduce locally.** Isolate the failing input. Confirm the symptom.
2. **TDD step.** Per `.claude/rules/workflow.md` "TDD for bug fixes":
   - Add a unit test that fails against the current production code.
   - Verify the failing direction by `git stash`-ing the candidate fix
     (or by writing the test before the fix) and running the test.
3. **Implement the minimal fix.**
4. **Verify.**
   - The new test now passes.
   - Full `bun run test` is green (regression check).
5. **Worktree-aware sanity check.** If the fix writes to or links into
   any shared resource — `.git/hooks`, `.agent-console/`, repo root, any
   path under `~/.claude/` — trace each `path.resolve(<relative>)` to
   verify it anchors to a *stable canonical location* (main worktree /
   repo root / project root, depending on the resource — see the table
   below), not the current cwd. The recurring failure is a write or
   symlink whose target binds to an ephemeral worktree that is later
   removed, breaking the resource for every other worktree.
6. **Surgical scope.** Hot-fix PRs target one specific bug. Refactors,
   cleanups, and "while I'm here" changes belong in a separate PR.

### Common shared-resource paths to audit (worktree-aware)

| Resource | Anchor it to |
|---|---|
| `.git/hooks/*` | main worktree (use `git rev-parse --git-common-dir`, then take the parent) |
| `.agent-console/repositories/<repo>/...` | repo root (`git rev-parse --show-toplevel`) or main worktree |
| `~/.claude/projects/<project>/...` | project root (independent of worktree) |

(Lesson: Sprint 2026-04-29 PR #729 — `install-hooks.mjs` resolved the
hook source via `path.resolve(<relative>)` against `cwd`, which bound to
the ephemeral worktree where the installer happened to run. Later
worktree removal broke the symlink for every other worktree. Fix: anchor
to `git rev-parse --git-common-dir`'s parent.)
