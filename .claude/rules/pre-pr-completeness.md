# Pre-PR Completeness Gap-Scan

Before opening a PR that introduces a **new skill, script, rule, file type, or canonical procedure**, walk this 7-question mechanical checklist. Each question should take 30 seconds to 2 minutes. If any answer is "unsure", resolve before pushing.

## The seven questions

1. **Does a similar existing mechanism already exist?**
   - `ls` the relevant directories (`.claude/rules/`, `.claude/skills/`, `.claude/skills/orchestrator/`, `scripts/`, `packages/*/src/`)
   - `grep -r` for keywords from the proposal (concept name, file pattern, command)
   - Read any file that looks relevant, even briefly
   - If a similar mechanism exists: is this new thing a genuine extension, a replacement, or a duplicate? Duplicate → stop and reuse. Extension → cross-link. Replacement → document migration.
   - **1.5 (cross-doc citation sub-check):** When this PR cites another document's technical claim (schema, API, command behaviour), verify the claim against the actual code, not just the other document. Documents describe intent; code describes reality. When the two drift, cite the code's current state. (Lesson: Sprint 2026-04-20 PR #677 claimed `multi-user-shared-setup.md` "declared REFERENCES users(id)"; CodeRabbit caught that migration v14 shipped without the REFERENCES DDL. The design doc described the spec; the code did something different.)
2. **Is the invocation or trigger of this new thing documented in a canonical procedure?**
   - If it is a script or a skill that needs to run at a specific point, find where that point is described (e.g., `core-responsibilities.md §N`, `sprint-lifecycle.md`, or equivalent)
   - Add the invocation instruction there in the same PR
   - A future Orchestrator or agent that follows the canonical procedure must be able to execute this new thing without reading the PR description
3. **If this has tests, are failure paths tested?**
   - Unit tests: happy path + at least one failure / edge case (empty input, invalid input, boundary value)
   - Integration tests where applicable per `test-trigger.md`
   - "What happens when the underlying call fails silently" is a common blind spot — ask it explicitly
   - **Sibling test must be touched in the SAME PR.** Even when a sibling test file already exists for the production file you modified, you MUST add or update at least one test case in that file in the same PR. Existing-file presence is not sufficient — the preflight coverage check (`node .claude/skills/orchestrator/preflight-check.js`) verifies that production files modified in this PR have *changed* test files alongside them. See `test-trigger.md` for the file → test path mapping. (Lesson: Sprint 2026-05-03 PR [#764](https://github.com/ms2sato/agent-console/pull/764) — agent's first push modified production code without a sibling-test diff; preflight CI failed before merge. Adding a test that exercises the production diff costs little and closes the gate cleanly.)
   - **3.5 (filesystem watcher sibling check):** When this PR uses `fs.watch`, `chokidar`, or any file-system watcher API, confirm the target. Watching a **specific file path** binds to its inode at watch-add time on macOS (kqueue) and Linux (inotify); an atomic rename — including `git`'s `HEAD.lock → HEAD` — replaces the file with a new inode and silently detaches the watcher. The robust pattern is to watch the **containing directory** with a `filename === 'TARGET'` filter, which survives atomic replacement. (Lesson: Sprint 2026-04-28 PR #709 (#708) — `fs.watch(headFilePath, ...)` worked on the first checkout and stopped firing afterward. Reproduction with three successive `rename(2)` calls: 1/3 events before the fix, 3/3 after switching to directory watching.)
4. **If this adds a new file type or directory, is the full lifecycle (create / read / update / delete / rename / archive) documented in a README or skill?**
   - Who creates it, when? Who reads it, when?
   - What moves it (accept / reject / archive)?
   - What should never be done to it (e.g., "never silently delete rejected entries")?
5. **Rule clarity pass — for PRs that introduce or substantially modify rule text:**
   - Read each clause as a fresh reader who has never seen the codebase. Would they apply the rule mechanically without further context?
   - Prefer concrete examples or file paths over abstract verbs ("check file X" beats "verify appropriately").
   - Remove prediction-framed statements (e.g., "X will fade") — rules describe what to do, not what the ecosystem will become.

6. **Layer-Boundary Crossing Checklist — for PRs that introduce a cross-runtime spawn:**

   When this PR adds an invocation that crosses runtime boundaries (e.g., a `node` script that spawns `bun`, a shell script that spawns `node`, a build step that spawns a CLI not previously required), walk this 4-step checklist:

   1. **Enumerate all callers of the script being modified** — both direct (`gh workflow list`-style) and transitive (other scripts, hooks, CI workflows that invoke this script). `paths-ignore` filters do not exempt callers from transitive impact; a script change reaches every caller regardless.
   2. **Inspect each caller's runtime setup** — does the workflow yml or shell environment install the spawn target? Look for `setup-bun`, `setup-node`, `actions/cache`, equivalent shell-side prerequisites.
   3. **Update missing setups in the same PR** — if any caller is missing the runtime, add the setup step to that caller's yml in this PR. Closing the transitive blast radius is part of the PR's scope, not a follow-up.
   4. **Test the spawn-failure path** — the helper that performs the spawn must produce a meaningful error when the target binary is unavailable. A silent `result.status === null` or empty-stdout failure surfaces only at CI runtime and is hard to diagnose. Add a test that mocks the binary as missing and asserts the helper returns a clear error.

   (Lesson: Sprint 2026-04-28 PR #716 — language-check helper added `spawn('bun', ...)` to `preflight-check.js`. The author (this same role) updated the script and the new `language-lint.yml` workflow, but did not enumerate callers and missed `test-coverage-check.yml`'s call to `preflight-check.js`. CI failed on first push with a contradictory "Found 0 violations + exit 1" message because `spawnSync` returned `null` status, which the helper template did not handle. The agent traced the chain and added `setup-bun` to the missing workflow plus a `spawnFailed` flag in the helper.)

7. **Shared-Resource Lifetime Checklist — for PRs that write artifacts to a shared / persistent location:**

   When this PR introduces an installer, daemon registrar, hook installer, package metadata generator, or any code that **writes an artifact to a location whose readers outlive the writer's invocation context**, walk this 4-step checklist. This complements `architectural-invariants/SKILL.md` I-8 "Shared-Resource Artifact Lifetime" — I-8 is the runtime-correctness statement; Q7 is the mechanical pre-PR gate.

   1. **State the artifact's lifetime** — what triggers its deletion? (e.g., "until the repo is uninstalled", "until the user removes the systemd unit", "until `npm uninstall`").
   2. **Enumerate the artifact's reader contexts and each reader's lifetime** — who reads it, from where, until when?
   3. **For each path / reference embedded in the artifact, classify it**: `cwd-anchored` (process lifetime) / `worktree-anchored` (until that worktree is removed) / `globally-stable` (until the repo / system is uninstalled).
   4. **Confirm: artifact lifetime ≥ longest reader lifetime, AND every embedded reference's source lifetime ≥ artifact lifetime.** If not, redesign (route through a stable canonical anchor) or use copy-fallback to make the artifact self-contained.

   **Multi-dimensional check.** When a PR claims to be "worktree-aware", enumerate every dimension where worktree-awareness must hold: (a) where to write, (b) where to read at runtime, (c) **what to embed inside the written artifact**. Identifying only one or two dimensions is a typical premature-closure pattern — see `memory/feedback_worktree_aware_premature_closure.md`.

   (Lesson: Sprint 2026-04-30 PR #725 (#719) — `scripts/install-hooks.mjs` resolved the symlink target via `path.resolve(SOURCE_REL)`, cwd-anchored to the linked worktree at install time. After merge the worktree was removed; the symlink became dangling and git silently skipped the broken hook. Issue #728 surfaced the bug, PR #729 hot-fixed via `git rev-parse --git-common-dir`, PR #738 reinforced the invariant via `bun install` postinstall + worktree-aware setup. The author's self-retrospective named this "premature closure of Concerns Surfacing Discipline" — addressed 1 of 3 worktree-awareness dimensions before stopping.)

## When to apply

- **Required** for PRs that introduce:
  - A new script in `.claude/skills/**` or `scripts/**`
  - A new rule in `.claude/rules/**` or skill in `.claude/skills/**`
  - A new directory under `docs/` or `.context-store/` (or similar infrastructure)
  - A new canonical procedure step (e.g., new subsection in `core-responsibilities.md §N`)
  - A cross-runtime spawn (Question 6) — required regardless of whether other criteria match
  - A shared / persistent artifact write (Question 7) — required regardless of whether other criteria match
- **Optional but encouraged** for any production code PR touching infrastructure or cross-cutting patterns
- **Not required** for single-file bug fixes, typo corrections, or test-only additions

## Why

The Orchestrator's self-review is calibrated for *content correctness* (does the code do what it claims?). It is structurally weak on *completeness* ("what else should also be here?"). Both substantive defects surfaced in Sprint 2026-04-18 — the initial `file-test-map.md` proposal duplicating existing `test-trigger.md`, and the missing Post-Merge Flow `§7f` trigger documentation for the brewing system — were caught by the owner, not by self-review. A mechanical checklist converts the owner-catch burden into a self-catch habit.

Cross-reference: `memory/feedback_check_existing_before_proposing.md` captured the first incident as a single-case reminder; this rule generalizes it into a process gate.

## How this rule is expected to decay

As the Orchestrator develops completeness instincts, these questions may become automatic and the explicit checklist may be retired. Until then, apply mechanically rather than skipping on the assumption that the answer is obvious.
