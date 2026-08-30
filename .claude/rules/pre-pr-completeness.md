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
   - **1.7 (glossary recall sub-check):** When this PR introduces a new domain concept — an exported type or interface, a DB table or column, an API endpoint or MCP tool parameter — check it against `glossary-maintenance.md`'s trigger list and add the `docs/glossary.md` entry in the same PR if it matches. **The judgment lives there, not here.** This item is a recall point, not a second copy of the decision tree: do not restate the triggers or the drift-handling steps in this file. (Lesson: Sprint 2026-08-20 PRs [#1373](https://github.com/ms2sato/agent-console/pull/1373) and [#1384](https://github.com/ms2sato/agent-console/pull/1384) both reached the Orchestrator's acceptance check with the glossary entry missing. The #1384 delegate's retrospective identified the mechanism precisely: they had the glossary rule loaded and did not actively exclude it — their pre-implementation checklist was built from the AC plus the Orchestrator's emphasis, and a glossary step was simply never in the flow. Of the three layers that could catch this — AC drafting, this checklist, and acceptance-check Q9 — only Q9 was doing so, because this one had no entry at all.)

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
   - **A trigger names the defect class, not the first instance.** This applies to lesson comments in source as much as to rule text. Before committing a trigger ("when you add a new field to this function…"), ask what property made the incident possible and write the trigger on *that* ("when a decision here depends on state this function does not own…"). The instance is what you have; the class is what fires. When only the instance is known, keep its wording **and** add one line marking it as a hypothesis about the class, so the next reader can see the boundary is unverified rather than inheriting it as settled.

     A trigger written at instance shape fails silently and in the worst way: it is loaded, it is read, it is obeyed — and it does not fire, because the reader correctly judged their situation to be outside it. Nothing looks wrong afterwards.

     (Lessons, both Sprint 2026-08-30. A comment added by PR [#1503](https://github.com/ms2sato/agent-console/pull/1503) to `resetChatState` said "when you add a new field to this function"; the [#1507](https://github.com/ms2sato/agent-console/pull/1507) delegate added no field — they added a *dependency* on a field the function does not own — read the comment, correctly concluded it did not apply, and shipped the defect it was written to stop. Separately, [#1511](https://github.com/ms2sato/agent-console/issues/1511)'s acceptance criteria said "chrome", which was read as *state ownership*; every clause passed and the requirement — one visual rail instead of three — was not met.)

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

   **8.5 (review-mechanism ceiling) — for any PR that must land atomically:** the count has a second reader. **CodeRabbit skips a PR over 100 changed files entirely** (see [`coderabbit-ops`](../skills/coderabbit-ops/SKILL.md)), and a PR that cannot be reviewed cannot satisfy the Definition of Done — no fallback disposition substitutes for a review that never started.

   **Estimate the file count while writing the AC, not at the gate.** Near the ceiling, choose the mitigation there: a preceding PR removing mechanical fan-out, or a stacked review that still merges as one move. **Do not split the atomic change itself to fit a tool** — the window atomicity protects is measured in review round-trips, not minutes.

   (Lesson: Sprint 2026-08-28 PR [#1403](https://github.com/ms2sato/agent-console/pull/1403) — 107 files, found at the gate and reported as `Review rate limited`, which reads as "wait" for a condition that never clears. Twelve were migration tests whose entire diff bumped an assertion another test already owned; removing that duplication was right on its own merits, took the PR to 95, and let a real review run — which found a Major.)

9. **Target-environment cross-check — for bug fix PRs:**

   When this PR is a bug fix, enumerate every environment / mode the affected code path supports (single-user vs multi-user, AUTH_MODE=none vs multi-user, server-spawn vs elevated-spawn, dev vs prod, with-cache vs no-cache, etc.) and verify the fix design works in **all** of them, not just the one where the bug was first observed.

   1. **List the environments / modes** the modified function supports. Read the function and trace its `if (mode === ...)` / `if (shouldElevateForUser(...))` / `process.env.X === ...` branches.
   2. **For each mode, ask: "does the fix logic make sense here?"** Pay extra attention to permission / identity differences (which user owns the files, who can stat / read / spawn).
   3. **Write at least one test per mode** if the modes have meaningfully different paths.
   4. **If a mode introduces a blind spot the fix design didn't account for**, redesign the fix to cover that mode upfront — do not defer to a follow-up.

   (Lesson: Sprint 2026-06-26 PR #897 — the initial orphan-recovery design called `fsPromises.stat(worktreePath)` as the server process. In multi-user mode the worktree dir may be user-owned with mode 0700, causing EACCES on stat. The fix would have rejected valid orphan-recovery cases in multi-user mode — the very environment that surfaced the bug in dogfood. CodeRabbit MAJOR caught the EACCES blind spot before merge; pre-design environment enumeration would have caught it earlier.)

10. **Schema-Type Parallel Maintenance — for PRs that add a derived/computed field to a shared type that crosses the server/client wire:**

    When this PR adds a field to a shared TypeScript type (`packages/shared/src/types/`) that is populated server-side and consumed client-side over WebSocket or REST, walk this 3-step checklist:

    1. **Add the field to the matching runtime schema in the same PR.** The TypeScript type is not enough. Add the same field to the corresponding `valibot` schema in `packages/shared/src/schemas/` (e.g., `createdByUsername: v.optional(v.nullable(v.string()))`). A TS-only addition is silently lost at the wire boundary, with no compile or runtime error on either side until manual QA notices the missing data — see **What the failure actually is now** below, because the mechanism changed and the damage got larger.
    2. **Add an integration test in `packages/integration/src/`** that exercises the full path: server populates the field → it serializes through the WebSocket / REST handler → the runtime schema parses it → the parsed value reaches the shape consumed by the client. Frontend unit tests that inject mock objects directly (e.g., `createMockSession({ newField: ... })`) bypass the schema parse path and cannot detect schema-level drops. The integration test is the only layer that exercises the wire boundary end-to-end.
    3. **In any frontend test that injects the field via a mock factory, add an explicit header comment** noting the bypass:

       ```ts
       // NOTE: This test injects schema-derived fields directly via the mock
       // factory and DOES NOT exercise the WebSocket/valibot parse path.
       // Schema-level wire validation lives in packages/integration/src/.
       // Adding a new derived field requires updating BOTH places.
       ```

    **Why:** valibot's `v.InferOutput<typeof schema>` derives the TypeScript type from the schema, but the reverse — propagating a TS type addition into the schema — is manual. Nothing in the type system notices the omission, so the drift reaches runtime. This question closes the gap by requiring the schema update in the same PR plus an integration test that would catch the loss if either were forgotten.

    **What the failure actually is now — the mechanism changed, and it got worse.** This question was written when the wire schemas used the default `v.object`, which *strips* unknown fields: the omitted field arrived as `undefined` and the rest of the message was fine. Issue [#927](https://github.com/ms2sato/agent-console/issues/927) migrated them, and as of `e3ad4435` **every schema file under `packages/shared/src/schemas/` uses `v.strictObject` and none uses `v.object`** — a `strictObject` *rejects* the payload rather than trimming it. Combined with `parseMessage` in `packages/client/src/lib/app-websocket.ts`, which returns `undefined` on a `safeParse` failure and drops the frame with no log, the blast radius of forgetting step 1 moved from **"one field is silently missing"** to **"the entire message is silently discarded"**.

    So the check is unchanged and more urgent, and the forward-compat framing that used to soften it is gone: a newer server talking to an older client no longer degrades field-by-field. What still holds is the part that made the original bug expensive — the failure is silent at both ends, which is why step 2's integration test, not a unit test, is the layer that catches it.

    **Re-derive this paragraph rather than trusting it.** It describes a property of code that a future migration can change again, exactly as #927 changed it once. `grep -c 'v\.object(' packages/shared/src/schemas/*.ts` and the failure branch of `parseMessage` are the two observables; both are a few seconds to read.

    (Lesson: Sprint 2026-06-30 PR #926 — backend correctly populated `Session.createdByUsername`, the WebSocket message carried it, but `SessionBaseSchema` in `packages/shared/src/schemas/app-server-message.ts` was not updated. valibot stripped the unknown field; the frontend received `undefined`. All unit tests passed because the frontend tests injected the field directly via a mock factory, bypassing the parse path entirely. The bug surfaced only when the owner ran manual Browser QA and noticed the sidebar label was absent. Three hours of cross-layer debugging followed before the schema gap was identified. The agent and the Orchestrator both had approved skipping integration tests with the rationale "derived field, simple shape, unit tests suffice" — a joint judgment failure that this question is meant to prevent. Issue [#927](https://github.com/ms2sato/agent-console/issues/927) — the `v.strictObject` migration plus the server/client schema version handshake — has since shipped; it did not make this question redundant, it changed what happens when the question is skipped. See the paragraph above.)

    (Second lesson, Sprint 2026-08-30: the two paragraphs above were written during that sprint's retrospective, after a scan for *removable* rule text found instead that this one had gone stale. Nobody had asserted the `v.object` claim since #927 merged, so no verification pass could have reached it — this is `design-principles.md`'s "sweep for what your change invalidated" landing on a rule rather than on a doc. The tell was mechanical and took one query: a rule cited a closed Issue as future work.)

11. **Tool surface symmetry check — for PRs that introduce a new worker / agent / execution surface analogous to an existing one, OR add/change a cross-surface agent operation:**

    When this PR introduces a new worker kind, agent kind, or execution surface that is architecturally analogous to an existing one (e.g., a new agent kind alongside terminal-agent / Claude Code), answer these four questions before the design's initial phase merges:

    1. **What tools does the analogous existing surface expose** to the user / model? (e.g., terminal-agent exposes `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, MCP tools, and permission prompts.)
    2. **Does the new surface expose the same, a superset, a subset, or an intentionally distinct set** of tools?
    3. **If subset:** list the missing tools and confirm each is either filed as a fast-follow Issue linked from this PR, or documented as an "intentional non-goal, will not be added" in the spec. The fast-follow Issue must exist **before** the initial phase merges, not after.
    4. **If intentionally distinct:** document the divergence rationale in the spec's Non-goals (or equivalent) section, and confirm the user is informed (an Experimental label, an in-UI notice, or a docs entry).

    **Why:** the phase-decomposition review at design time did not ask this question for embedded-agent v1, so a large parity gap shipped silently and was only caught in post-release dogfood.

    (Lesson: Sprint 2026-07-11/12 — Embedded Agent Worker v1 (umbrella [#1004](https://github.com/ms2sato/agent-console/issues/1004)) shipped without built-in tools (`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`), the largest gap identified in the post-v1 dogfood retro. The tools were not deferred by a documented decision — the spec review simply never asked whether the new surface matched terminal-agent's tool set. Three fast-follow PRs closed the gap after the fact: [#1042](https://github.com/ms2sato/agent-console/issues/1042) (FF-1a, Read/Glob/Grep), [#1043](https://github.com/ms2sato/agent-console/issues/1043) (FF-1b, Bash), and [#1044](https://github.com/ms2sato/agent-console/issues/1044) (FF-1c, Write/Edit). Asking Q11 during the original phase-decomposition review would have surfaced the gap and let the fast-follows be filed and scheduled before v1 shipped, instead of after dogfood found the hole. See [Issue #1046](https://github.com/ms2sato/agent-console/issues/1046).)

    **5. Operation exposure tables (Issue #1160 PR-D extension):** the four questions above cover *tool-level* symmetry (what can this agent kind invoke?). A structurally different question is *operation-level* symmetry across consumer surfaces (UI, MCP, embedded-visible): does every surface that lets a caller act on "an agent" (list, resolve, create a session with one, add one to a session, manage its definition) expose the same set of operations, or record an explicit reason when it doesn't?

    That second question is now type-enforced, not just reviewed by hand: `AGENT_OPERATIONS` (`packages/shared/src/types/agent-operations.ts`) is the single writer of every cross-surface agent operation, and each surface owns a table typed `satisfies Record<AgentOperation, SurfaceExposure>` — `packages/client/src/lib/agent-operations-ui.ts` (UI), `packages/server/src/mcp/agent-operations-mcp.ts` (MCP), `packages/server/src/mcp/agent-operations-embedded.ts` (embedded-visible). Apply this sub-check whenever a PR does either of the following:

    - **Adds a new entry to `AGENT_OPERATIONS`** — the `satisfies` typing already makes an omission a compile error in all three tables, so this case cannot silently merge with an incomplete table. The human judgment this sub-check adds: confirm each table's new entry has an *accurate* `via` (a real, human-locatable entry point) or `reason` (a real rationale, not a placeholder), not just a value that satisfies the type.
    - **Adds a new consumer surface** analogous to UI / MCP / embedded-visible (e.g., a future CLI or webhook surface that lets a caller act on agents) — add a fourth exposure table for it in the same PR, covering all of `AGENT_OPERATIONS`, following the same `satisfies Record<AgentOperation, SurfaceExposure>` pattern and co-located with that surface's own code.

    Where a table's `via` claim is mechanically checkable (e.g., the MCP table's `via` naming a tool that must actually be registered in `packages/server/src/mcp/mcp-server.ts`), add or extend the corresponding test (see `packages/server/src/mcp/__tests__/agent-operations-mcp.test.ts` for the pattern) instead of relying on review alone. Where it is not mechanically checkable (UI `via` claims naming a component/page), accuracy stays a review-time judgment call — this residue is the same "process rule as the residual net" pattern documented in `docs/design/agent-surface.md` Mechanism 3.

    (Lesson: this rule itself — Issue [#1160](https://github.com/ms2sato/agent-console/issues/1160) PR-D built the exposure-table mechanism specifically because Q11's original four questions catch tool-level gaps like the embedded-agent-v1 case above, but had no equivalent for operation-level gaps like `list_agents` silently excluding embedded agents while `delegate_to_worktree` accepted them — see `docs/design/agent-surface.md` §0 "Verified current state" for that concrete parity bug.)

12. **Is the AC's own verification requirement still satisfiable? — before starting implementation:**

    Read the acceptance criteria and ask what would have to be true for you to *demonstrate* they are met, then confirm each of those things holds. An AC that mandates a real-environment check ("run the Docker smoke on a fresh checkout", "verify on the multi-user host", "reproduce the original symptom") is asserting that the check is currently runnable — an assumption nobody validated when the AC was written.

    Concretely, before the first commit:

    1. **Name the verification the AC requires**, and the environment it needs.
    2. **Run it once against unmodified `main`** — not to see it pass, but to see it *execute*. It should fail for the reason the Issue describes. Any other failure means the verification path itself is broken, and you have found that before it has cost you an implementation.
    3. **If it cannot run, stop and report before implementing.** The blocker may be a second, unrelated defect (fix it, or get a scope decision), or the AC may need a different verification. Both are cheap now and expensive after the work is done.

    **A blocker discovered here is a finding, not an obstacle.** The verification was mandated because the code path is environment-coupled; if the environment cannot even reach the starting line, that is information about the system.

    (Lesson: Sprint 2026-07-18b PR [#1228](https://github.com/ms2sato/agent-console/pull/1228) — the AC for Issue #1214 required a Docker smoke proving `bun install` completes on a fresh checkout. Implementation finished, then the smoke could not run: a *second*, unrelated defect (a missing workspace volume in `docker-compose.yml`) broke `bun install` on any fresh clone. The AC had become unsatisfiable without also fixing that. Discovered mid-implementation, it stalled the delegate and crossed with an in-flight architect consultation; the Orchestrator ultimately bundled both fixes with a scope note. Asking this question first would have surfaced it in the first five minutes — and the second defect was real and worth finding either way.)

13. **Role-switch self-pass — for anyone ISSUING an AC / verification plan / experiment design, and for anyone AUDITING one:**

    The moment a role becomes "inspector", its own artifacts silently leave the inspection scope. The concrete failure shape: applying a check to someone else's work and, the same day, not applying it to your own (both the Architect and the Orchestrator did exactly this on 2026-07-29 — a verification plan built on a synthetic probe was issued hours after demanding polarity from a delegate, and the Q12 satisfiability question was asked without asking what the satisfiable verification would actually prove).

    **Before issuing, run two questions against your own artifact:**

    1. **Production-real or proxy?** For each verification the plan mandates: does it traverse the production shipping path, or a proxy (synthetic stub, internal API call, mock, mechanism probe)? Proxies are allowed — but only as an explicit, recorded decision, never as an unnoticed default.
    2. **Does it have polarity?** Would the verification fail against the pre-change implementation (or, for an experiment, distinguish the hypotheses)? A verification that passes in both worlds proves nothing and reads as false confidence.

    **Two variants of the same blindness, checked at the same moment:**

    - **Retroactive application.** A newly-discovered fact must be applied backward to recently-merged conclusions, not only to in-flight work. (Lesson: 2026-07-29 — "the shared dev server runs an old binary" was discovered during one PR's verification and applied only to that PR; merged #1237/#1241 had never actually run on any dev server, and the shipping-path E2E gap sat undetected for two days until the owner asked.)
    - **Shipping-path AC audit line.** When an AC item names a shipping path ("MCP delegate_to_worktree starts the agent"), the audit must match it against *which executed verification actually traversed that path*. If a probe or unit test substituted for it, a documented joint-skip decision must exist — silence is a finding. (Lesson: #1234 AC item 1 was audited as satisfied by a sentinel smoke — a mechanism probe `workflow.md` explicitly says is not goal verification — with no joint-skip record; the AC author and the auditor were the same role.)

    **Boundary — what this question does NOT govern:** the self-pass guards the "WHAT does this verification prove" layer at issuance time. The "HOW" layer — concrete verification mechanics (which child process, which assertion shape, which counter) — is a hypothesis that legitimately changes during implementation; the implementer's deviation-report duty (hold and consult with data, per the AC's own escalation rule) is the safety net there. Do not read this clause as freezing verification mechanics at AC time. (Lesson: #1230/PR #1254 — the AC-specified smoke design was empirically wrong about child-exit behavior; the delegate's measured deviation report produced a better design. That was the process working, not failing.)

    The mechanical counterpart is `acceptance-check.js` Q12 (Shipping-Path Verification Match), which re-asks the same questions at audit time; this rule text is the issuance-side duty and the rationale layer.

    **When a verification is blocked by a credential you cannot legitimately obtain.** Occasionally the mandated verification needs a credential that is not available to you and cannot be made available cheaply (an OS password, a third-party account, a hardware token). Substituting the credential-issuance step is permitted, but only as a **recorded** decision meeting all three of:

    1. **Upstream and outside.** The mechanism you substitute sits upstream of, and outside, the chain under test — replacing it changes how you *arrive* at the thing being verified, never the thing itself. If the substituted mechanism is part of what the AC claims to verify, this is not available to you.
    2. **Genuinely provisioned.** The artifact your substitute produces is created the way production creates it, through real code paths, from real state — not hand-assembled to look right. (Worked example: a session JWT minted with the same signing call and payload shape as the login endpoint, whose subject came from a real `upsertByOsUid()` against the instance's own database, rather than a hand-written token.)
    3. **Recorded as a proxy, next to the result.** The evidence states what was substituted, why it is outside the chain under test, and what remained production-real — in the same place as the result, not a footnote. An unrecorded proxy is the failure mode this question exists to catch; a recorded one is simply an honest verification.

    Missing any of the three makes it a **bypass**, not a workaround: stubbing the mechanism under test, hand-writing the artifact, or relaxing the setting whose behavior is being verified are never permitted, however convenient. When in doubt, consult before improvising — the consultation is cheap and the wrong substitution invalidates the whole verification silently.

    (Lesson: Sprint 2026-08-03, Issue #1004 item 5 — the mandated check needed a real OS login password that the delegate had no legitimate way to obtain. Rather than improvise, they held and consulted; the JWT-mint substitution was approved against these three conditions, and the resulting evidence recorded it alongside the result. The same task's PAM-substitution *also* demonstrated the boundary: it was acceptable precisely because PAM sits outside the MCP caller-identity chain the item verifies.)

    **Where you record a correction is part of the correction.** When you discover that a claim in a PR body, an Issue, or a design doc overstates its evidence, correct it *there*. A note in a session memo, a chat message, or a report to the requester does not reach the person who reads the artifact six months from now — and the artifact is what they will act on. A memo is transient; a PR body is durable. This applies with particular force to observations recorded under the proxy rules above: an observation whose strength was overstated in a durable place, and corrected only in a transient one, is still overstated as far as every future reader is concerned. (Lesson: Sprint 2026-08-05 PR [#1283](https://github.com/ms2sato/agent-console/pull/1283) — the PR body reported "the alias form was accepted at spawn", evidenced only by the process still being alive ~2s later. The Orchestrator noticed the gap between that evidence and that claim, explained the distinction in the owner memo, and considered it handled. The Architect required the PR body itself be fixed before merge: the memo would be gone, the body would not.)

14. **Rollback-resource question — for PRs that add a resource acquisition inside a function that already has failure rollback:**

    When this PR makes a function acquire something new — spawn a subprocess, mint a token, open a handle, create a file, take a lock — and that function already has a failure path that cleans up (a `catch` that kills workers, deletes state, restores a previous status), ask one question:

    > **Does that existing rollback release the resource I just added?**

    It usually does not. Rollback code enumerates what existed when it was written; a new acquisition is invisible to it. The failure is silent — the happy path is unaffected, the rollback still "succeeds", and the leak only appears under a failure that tests rarely exercise.

    Check three things at the code, not from the caller:

    1. **Read every rollback path in the function**, not just the one nearest your change. A function with two `catch` blocks needs both updated; fixing one leaves the same hole half-open.
    2. **Confirm the cleanup call actually reaches your resource type.** A shared cleanup helper may silently ignore it — a `killWorker` gated on `worker.type === 'agent' || 'terminal'` no-ops on anything else, so appending your worker to its list looks correct and does nothing.
    3. **Confirm the ordering.** Cleanup that runs after the lookup structure is torn down cannot find the resource. Deactivating a worker *after* `deleteSession` removes it from the session map is a no-op, and the resource becomes permanently unreachable rather than merely leaked.

    Then add a test per rollback path: acquisition succeeds, a *later* step fails, the resource is released. A test that only exercises "my own acquisition failed" does not cover this.

    (Lesson: Sprint 2026-08-05 PR [#1276](https://github.com/ms2sato/agent-console/pull/1276) — session-resume gained an embedded-agent activation inside a function whose two rollback paths killed only PTY workers. On a later PTY failure or a DB-persist failure, the activated subprocess and its minted MCP token survived the rollback, and the subsequent `deleteSession` made them unreachable, so each retry compounded the leak. CodeRabbit found it in a review body; the Architect's own audit had missed it, and named the gap precisely: they had required exactly this check of a delegate four days earlier in PR #1237 and did not apply it to their own review. That is the role-switch blind spot Q13 describes, in its most direct form.)

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
  - A new worker / agent / execution surface analogous to an existing one, or a new entry in `AGENT_OPERATIONS` / a new agent-operations exposure table (Question 11) — required regardless of whether other criteria match
- **Question 14 applies to any PR that adds a resource acquisition inside a function with an existing failure-rollback path** — required regardless of whether other criteria match
- **Question 12 applies to any PR whose AC mandates a real-environment verification** (a smoke script, a dogfood pass, a container / multi-user / real-device check) — required regardless of whether other criteria match, and it runs **before implementation**, not before the PR. It is the one question here that is worthless if asked late.
- **Question 13 applies at AC / verification-plan issuance and at audit time** — it binds the author and auditor roles, not the implementing delegate.
- **Optional but encouraged** for any production code PR touching infrastructure or cross-cutting patterns
- **Not required** for single-file bug fixes, typo corrections, or test-only additions — **except** that Question 12 still applies if such a fix's AC mandates a real-environment check

## Why

The Orchestrator's self-review is calibrated for *content correctness* (does the code do what it claims?). It is structurally weak on *completeness* ("what else should also be here?"). Both substantive defects surfaced in Sprint 2026-04-18 — the initial `file-test-map.md` proposal duplicating existing `test-trigger.md`, and the missing Post-Merge Flow `§7f` trigger documentation for the brewing system — were caught by the owner, not by self-review. A mechanical checklist converts the owner-catch burden into a self-catch habit.

Cross-reference: `memory/feedback_check_existing_before_proposing.md` captured the first incident as a single-case reminder; this rule generalizes it into a process gate.

## How this rule is expected to decay

As the Orchestrator develops completeness instincts, these questions may become automatic and the explicit checklist may be retired. Until then, apply mechanically rather than skipping on the assumption that the answer is obvious.
