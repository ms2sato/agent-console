# Pre-PR Completeness Gap-Scan

Before opening a PR that introduces a **new skill, script, rule, file type, or canonical procedure**, walk this mechanical checklist. Each question should take 30 seconds to 2 minutes. If any answer is "unsure", resolve before pushing.

## The questions

1. **Does a similar existing mechanism already exist?**
   - `ls` the relevant directories (`.claude/rules/`, `.claude/skills/`, `.claude/skills/orchestrator/`, `scripts/`, `packages/*/src/`)
   - `grep -r` for keywords from the proposal (concept name, file pattern, command)
   - Read any file that looks relevant, even briefly
   - If a similar mechanism exists: is this new thing a genuine extension, a replacement, or a duplicate? Duplicate → stop and reuse. Extension → cross-link. Replacement → document migration.
   - **1.5 (cross-doc citation sub-check):** When this PR cites another document's technical claim (schema, API, command behaviour), verify the claim against the actual code, not just the other document. Documents describe intent; code describes reality. When the two drift, cite the code's current state. (Lesson: Sprint 2026-04-20 PR #677 claimed `multi-user-shared-setup.md` "declared REFERENCES users(id)"; CodeRabbit caught that migration v14 shipped without the REFERENCES DDL. The design doc described the spec; the code did something different.)
   - **1.6 (adjacent-fallback sub-check):** When designing a new "X-fallback" / "X-recovery" / "X-retry" mechanism, do not stop at "grep the function I'm modifying". Also grep adjacent code paths for the same pattern: `catch` blocks within the same function family, sibling functions that handle the same failure mode, helper functions in the same file with `force` / `fallback` / `recovery` / `retry` keywords. The risk is **duplicating existing recovery logic** because the new mechanism's intent is described in different words than the existing one. Read the full function body of any nearby `catch (error)` block before committing to the design. (Lesson: Sprint 2026-06-26 PR #897 — agent designed a new `pruneWorktrees` helper + a dedicated orphan-recovery branch in `WorktreeService.removeWorktree`, without auditing `lib/git.ts:removeWorktree`'s existing force-fallback catch block which already did `fs.rm` + `git worktree prune` for the same orphan case. Owner caught the duplicate during review. The agent had grepped `removeWorktree` for callsites but did not read the function body or the adjacent catch block.)
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

8. **Signature shape change pre-estimate — for PRs that change a function / method signature shape:**

   When this PR changes a signature shape — `sync` → `async`, return-type widening, parameter addition / removal / reorder, generic-parameter changes — pre-estimate the integration cost before committing to the change:

   1. **Count affected call sites.** Run `grep -c "<functionName>(" packages/` (or the equivalent across the repo) and note the result.
   2. **Record the count in the PR description.** Example: "`activateAgentWorkerPty` async migration affects 47 call sites in 12 files (production + tests)." This sets the reviewer's expectation for diff volume and surface area before they open the diff.
   3. **If using a bulk-replace script (sed / Python / `ts-morph`), validate on one file first** before applying repo-wide. Confirm indent / surrounding-context preservation. Indent-count mistakes (e.g., 14 spaces vs the file's 2-space convention) are easy to make and produce silently-wrong diffs.

   **Do not use the count as an excuse to escape the change.** If the right design is `async`, accept the test-call-site churn rather than introducing overload / optional-param / wrapper alternatives — those warp the design to dodge integration cost. The pre-estimate exists to set expectations, not to gate the change.

   (Lesson: Sprint 2026-05-10 PR #770 — `activate*Pty` async migration produced ~50 call-site changes in tests; the bulk-replace script was rerun twice (the first pass had a 14-space indent bug). Counting up-front would have set churn expectations and surfaced the indent assumption earlier.)

9. **Target-environment cross-check — for bug fix PRs:**

   When this PR is a bug fix, enumerate every environment / mode the affected code path supports (single-user vs multi-user, AUTH_MODE=none vs multi-user, server-spawn vs elevated-spawn, dev vs prod, with-cache vs no-cache, etc.) and verify the fix design works in **all** of them, not just the one where the bug was first observed.

   1. **List the environments / modes** the modified function supports. Read the function and trace its `if (mode === ...)` / `if (shouldElevateForUser(...))` / `process.env.X === ...` branches.
   2. **For each mode, ask: "does the fix logic make sense here?"** Pay extra attention to permission / identity differences (which user owns the files, who can stat / read / spawn).
   3. **Write at least one test per mode** if the modes have meaningfully different paths.
   4. **If a mode introduces a blind spot the fix design didn't account for**, redesign the fix to cover that mode upfront — do not defer to a follow-up.

   (Lesson: Sprint 2026-06-26 PR #897 — the initial orphan-recovery design called `fsPromises.stat(worktreePath)` as the server process. In multi-user mode the worktree dir may be user-owned with mode 0700, causing EACCES on stat. The fix would have rejected valid orphan-recovery cases in multi-user mode — the very environment that surfaced the bug in dogfood. CodeRabbit MAJOR caught the EACCES blind spot before merge; pre-design environment enumeration would have caught it earlier.)

10. **Schema-Type Parallel Maintenance — for PRs that add a derived/computed field to a shared type that crosses the server/client wire:**

    When this PR adds a field to a shared TypeScript type (`packages/shared/src/types/`) that is populated server-side and consumed client-side over WebSocket or REST, walk this 3-step checklist:

    1. **Add the field to the matching runtime schema in the same PR.** The TypeScript type is not enough. Add the same field to the corresponding `valibot` / `zod` schema in `packages/shared/src/schemas/` (e.g., `createdByUsername: v.optional(v.nullable(v.string()))`). valibot's default `v.object` silently strips unknown fields — a TS-only addition causes the field to disappear at the wire boundary, with no compile or runtime error on either side until manual QA notices the missing data.
    2. **Add an integration test in `packages/integration/src/`** that exercises the full path: server populates the field → it serializes through the WebSocket / REST handler → the runtime schema parses it → the parsed value reaches the shape consumed by the client. Frontend unit tests that inject mock objects directly (e.g., `createMockSession({ newField: ... })`) bypass the schema parse path and cannot detect schema-level drops. The integration test is the only layer that exercises the wire boundary end-to-end.
    3. **In any frontend test that injects the field via a mock factory, add an explicit header comment** noting the bypass:

       ```ts
       // NOTE: This test injects schema-derived fields directly via the mock
       // factory and DOES NOT exercise the WebSocket/valibot parse path.
       // Schema-level wire validation lives in packages/integration/src/.
       // Adding a new derived field requires updating BOTH places.
       ```

    **Why:** valibot's `v.InferOutput<typeof schema>` derives the TypeScript type from the schema, but the reverse — propagating a TS type addition into the schema — is manual. The default permissive parse mode (silent unknown-field strip) is intentional (forward-compat for older clients receiving newer payloads), but it converts schema-vs-type drift from a loud failure into a silent one. Q3.5 closes the gap by requiring the schema update in the same PR plus an integration test that would catch the drop if either were forgotten.

    (Lesson: Sprint 2026-06-30 PR #926 — backend correctly populated `Session.createdByUsername`, the WebSocket message carried it, but `SessionBaseSchema` in `packages/shared/src/schemas/app-server-message.ts` was not updated. valibot stripped the unknown field; the frontend received `undefined`. All unit tests passed because the frontend tests injected the field directly via a mock factory, bypassing the parse path entirely. The bug surfaced only when the owner ran manual Browser QA and noticed the sidebar label was absent. Three hours of cross-layer debugging followed before the schema gap was identified. The agent and the Orchestrator both had approved skipping integration tests with the rationale "derived field, simple shape, unit tests suffice" — a joint judgment failure that this question is meant to prevent. The deeper structural fix is tracked in Issue #927 — `v.strictObject` migration plus server/client schema version handshake.)

11. **Tool surface symmetry check — for PRs that introduce a new worker / agent / execution surface analogous to an existing one:**

    When this PR introduces a new worker kind, agent kind, or execution surface that is architecturally analogous to an existing one (e.g., a new agent kind alongside terminal-agent / Claude Code), answer these four questions before the design's initial phase merges:

    1. **What tools does the analogous existing surface expose** to the user / model? (e.g., terminal-agent exposes `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, MCP tools, and permission prompts.)
    2. **Does the new surface expose the same, a superset, a subset, or an intentionally distinct set** of tools?
    3. **If subset:** list the missing tools and confirm each is either filed as a fast-follow Issue linked from this PR, or documented as an "intentional non-goal, will not be added" in the spec. The fast-follow Issue must exist **before** the initial phase merges, not after.
    4. **If intentionally distinct:** document the divergence rationale in the spec's Non-goals (or equivalent) section, and confirm the user is informed (an Experimental label, an in-UI notice, or a docs entry).

    **Why:** the phase-decomposition review at design time did not ask this question for embedded-agent v1, so a large parity gap shipped silently and was only caught in post-release dogfood.

    (Lesson: Sprint 2026-07-11/12 — Embedded Agent Worker v1 (umbrella [#1004](https://github.com/ms2sato/agent-console/issues/1004)) shipped without built-in tools (`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`), the largest gap identified in the post-v1 dogfood retro. The tools were not deferred by a documented decision — the spec review simply never asked whether the new surface matched terminal-agent's tool set. Three fast-follow PRs closed the gap after the fact: [#1042](https://github.com/ms2sato/agent-console/issues/1042) (FF-1a, Read/Glob/Grep), [#1043](https://github.com/ms2sato/agent-console/issues/1043) (FF-1b, Bash), and [#1044](https://github.com/ms2sato/agent-console/issues/1044) (FF-1c, Write/Edit). Asking Q11 during the original phase-decomposition review would have surfaced the gap and let the fast-follows be filed and scheduled before v1 shipped, instead of after dogfood found the hole. See [Issue #1046](https://github.com/ms2sato/agent-console/issues/1046).)

## When to apply

- **Required** for PRs that introduce:
  - A new script in `.claude/skills/**` or `scripts/**`
  - A new rule in `.claude/rules/**` or skill in `.claude/skills/**`
  - A new directory under `docs/` or `.context-store/` (or similar infrastructure)
  - A new canonical procedure step (e.g., new subsection in `core-responsibilities.md §N`)
  - A signature shape change with a meaningful call-site count (Question 8) — required regardless of whether other criteria match
  - A cross-runtime spawn (Question 6) — required regardless of whether other criteria match
  - A shared / persistent artifact write (Question 7) — required regardless of whether other criteria match
  - A derived field added to a shared type that crosses the server/client wire (Question 10) — required regardless of whether other criteria match
  - A new worker / agent / execution surface analogous to an existing one (Question 11) — required regardless of whether other criteria match
- **Optional but encouraged** for any production code PR touching infrastructure or cross-cutting patterns
- **Not required** for single-file bug fixes, typo corrections, or test-only additions

## Why

The Orchestrator's self-review is calibrated for *content correctness* (does the code do what it claims?). It is structurally weak on *completeness* ("what else should also be here?"). Both substantive defects surfaced in Sprint 2026-04-18 — the initial `file-test-map.md` proposal duplicating existing `test-trigger.md`, and the missing Post-Merge Flow `§7f` trigger documentation for the brewing system — were caught by the owner, not by self-review. A mechanical checklist converts the owner-catch burden into a self-catch habit.

Cross-reference: `memory/feedback_check_existing_before_proposing.md` captured the first incident as a single-case reminder; this rule generalizes it into a process gate.

## How this rule is expected to decay

As the Orchestrator develops completeness instincts, these questions may become automatic and the explicit checklist may be retired. Until then, apply mechanically rather than skipping on the assumption that the answer is obvious.
