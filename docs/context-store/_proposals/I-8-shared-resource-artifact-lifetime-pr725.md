---
proposed_id: I-8
slug: shared-resource-artifact-lifetime
source_pr: 725
source_issue: 719
related_prs: [728, 729]
brewed_at: 2026-04-30
brewed_by: claude-opus-4-7 (orchestrator session c0822cc3)
---

# I-8 (proposed). Shared-Resource Artifact Lifetime

**Rule.** When code writes an artifact (symlink, config file, lock file, registered handler, hook, daemon registration, package metadata) into a **shared location** that outlives the code's invocation context, every path / handle / identifier embedded inside the artifact must resolve to a context whose lifetime is at least as long as the artifact's longest-lived reader.

If any embedded reference resolves to an ephemeral context (the install-time `cwd`, a temporary directory, a worktree that may be removed, a per-session ID), the artifact silently breaks when that context disappears.

## Why it matters

The failure mode is **silent**. The artifact stays in place; the OS / git / package manager doesn't error on dangling references; the next reader simply sees nothing or skips the artifact. The only signal is the absence of the expected behavior, which often goes unnoticed until a downstream effect surfaces.

## Domains where this applies

| Domain | Artifact (shared) | Embedded reference (must outlive readers) |
|---|---|---|
| Git hooks | symlink/copy in `<common-dir>/hooks/` | source path the symlink targets |
| Daemon registration | systemd / launchd unit file | absolute path to the binary, working dir, env files |
| Package manager | `package.json` `bin` field, lock file | absolute paths to bundled scripts |
| Log aggregation config | log forwarder config | absolute paths to log files / sockets |
| Session-shared lock files | `.lock` in shared dir | host/process identifier inside the lock |
| OS-level integrations | URL handlers, cron entries | paths to executables they invoke |

## Detection heuristics

1. **Trace `path.resolve(<relative>)` and `process.cwd()` to a write site.** If the resolved path ever flows into a `writeFile` / `symlinkSync` / `link()` / config-file-write that targets a shared directory, the resolved path becomes a *stored* reference. Stored references must not be cwd-bound.
2. **`path.resolve(<relative>)` is cwd-anchored.** Any helper that uses `path.resolve(<relative>)` produces a value tied to the running process's cwd at call time. If that value is then written into a shared artifact, the artifact captures the cwd at install time.
3. **Worktree-aware multi-dimensional check.** When a PR claims to be "worktree-aware", enumerate every dimension where worktree-awareness must hold: (a) where to write, (b) where to read at runtime, (c) **what to embed inside the written artifact**. Identifying only one or two dimensions is a typical premature-closure pattern (see `feedback_worktree_aware_premature_closure.md`).
4. **Lifetime ≤ comparison.** For each embedded reference, classify it by lifetime: `cwd-anchored` (process lifetime), `worktree-anchored` (until that worktree is removed), `globally-stable` (until the repo / system is uninstalled). Confirm: `embedded-reference lifetime ≥ artifact lifetime ≥ longest-reader lifetime`.

## Resolution patterns

- **Resolve via canonical helper.** Replace `resolve(<relative>)` with a helper that resolves against a stable canonical anchor (e.g., `git rev-parse --git-common-dir` then `dirname` for a git repo, `os.homedir()` for user-level installs, `__dirname` of a checked-in script for monorepo-relative anchoring).
- **Self-contained copy fallback.** If the artifact must be self-contained, copy the source content into the artifact rather than embedding a path. Disk cost is bounded by artifact size; correctness is unconditional.
- **Relative reference where the shared location is stable.** A relative reference inside the artifact (e.g., relative symlink `../../src/foo`) is correct iff the shared location's containing path is itself stable across the embedded reference's resolution context.

## Concrete past incident — why this is the canonical instance

**PR #725 (Issue #719) → Issue #728 → PR #729 hot-fix** (Sprint 2026-04-29).

Sequence:
1. PR #725 introduced `scripts/install-hooks.mjs`, an installer that writes a symlink into `<common-dir>/hooks/commit-msg`. The symlink target was computed via `path.resolve(SOURCE_REL)` — cwd-anchored.
2. Agents executed `bun run hooks:install` from inside their per-task linked worktree. The cwd at that moment was the linked worktree path. `resolve('scripts/git-hooks/commit-msg')` produced `/Users/.../worktrees/wt-006-ulve/scripts/git-hooks/commit-msg`.
3. The symlink was created. The hook worked from any worktree because `git rev-parse --git-path hooks` is shared.
4. **The agent's worktree was removed after merge.** The source file at `wt-006-ulve/scripts/git-hooks/commit-msg` was deleted along with the worktree.
5. The symlink became dangling. **git silently skips broken hooks** (no error, no warning) — the language gate the hook was supposed to enforce was disabled without anyone noticing.

Issue #728 surfaced the bug. PR #729 fixed it via `git rev-parse --git-common-dir` (option (a) — absolute symlink to main worktree path).

The PR #725 author's own retrospective (`§3 self-retrospective`) explicitly identified the failure mode as "I marked 'worktree-aware' as addressed after handling 1 of 3 dimensions; the 3rd dimension (installer cwd anchoring) was the one that bit us". This is the **named failure mode** the proposed invariant addresses.

## Why this satisfies all four catalog criteria

- **Cross-cutting.** Applies to every installer / config writer / handler registrar that places artifacts in a shared location. Concrete sibling examples already in the codebase: `package.json` `bin` (npm), launchd plist files (macOS daemon registration), `.git/info/exclude` writes, future enterprise integrations.
- **High-leverage detection.** The detection heuristic ("trace `path.resolve(<relative>)` to a `writeFile`/`symlink` write site that targets a shared directory") is mechanical. A reviewer can apply it without understanding the domain — it is a syntactic check at the read-then-write boundary.
- **Named failure mode.** "Shared artifact embeds a reference whose lifetime is shorter than the artifact's reader's lifetime → silent disablement on context teardown."
- **Concrete past incident.** PR #725 → #728 → #729 (with #725 author's retrospective as primary evidence). Owner-caught? No — the orchestrator caught it during routine post-merge cleanup planning, before any user impact, but only because the worktree-removal step forced the dangling-symlink scenario into existence. In a one-developer-without-worktrees setup, the bug could have lived for months.

## Suggested cross-references

- `pre-pr-completeness.md` — propose new Q7 "Shared-resource lifetime checklist" (see PR #725 retrospective `§3` for proposed wording).
- `feedback_worktree_aware_premature_closure.md` — companion feedback memory describing the cognitive failure mode that produces violations.

## Open question for owner / CTO review

Does the catalog want to formalize this as I-8, or should the rule live primarily in `pre-pr-completeness.md` as a process gate? The arguments:

- **For catalog (I-8)**: the rule is structural / addressing-related (similar to I-1 "I/O Addressing Symmetry"); applying it should be part of design + acceptance review, not just pre-PR.
- **For pre-pr-completeness only**: the rule is most catchable as a mechanical syntactic check at PR review time; catalog entries are typically about runtime correctness, not write-site design.

The author of this proposal recommends **both**: I-8 as the runtime-correctness statement, with `pre-pr-completeness.md` Q7 as the mechanical pre-PR gate that catches it before merge. The two reinforce rather than duplicate.
