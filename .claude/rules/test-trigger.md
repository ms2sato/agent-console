---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/server/src/mcp/**/*.ts"
  - "packages/server/src/lib/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.tsx"
  - "packages/shared/src/**/*.ts"
  - "packages/embedded-agent/src/**/*.ts"
  - ".claude/hooks/**/*.sh"
  - "!**/*.test.ts"
  - "!**/*.test.tsx"
  - "!**/*.test.mjs"
  - "!**/__tests__/**"
---

# Test Coverage Requirement

When modifying production files matching these patterns, corresponding test files **must** be added or updated.

## Expected Test File Locations

| File Pattern | Expected Test Location |
|-------------|------------------------|
| `packages/server/src/routes/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/services/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/mcp/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/lib/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/client/src/hooks/**/*.ts` | `.../__tests__/*.test.ts(x)` or sibling `*.test.ts(x)` |
| `packages/client/src/components/**/*.tsx` | `.../__tests__/*.test.tsx` or sibling `*.test.tsx` (a JSX-free pure-logic test may instead use `*.test.ts`, e.g. `SessionPage.test.ts` alongside `SessionPage.tsx`) |
| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/embedded-agent/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory) for its boundary tests. This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory. The one exception is `src/e2e-native/`, which holds the two shipping-path e2e test files that require a separate `bun test` invocation without the happy-dom preload (see `src/e2e-native/setup-native.ts` for why, and `package.json`'s `test` / `test:coverage` / `test:watch` scripts for the two-invocation chain). This subdirectory is process-partitioning infrastructure, not a `__tests__/`-shaped test-to-production mapping, so it does not contradict the flat-layout rationale above.
- **`*.gen.ts` / `*.gen.tsx`** files are build-time generated (e.g. `packages/shared/src/schema-version.gen.ts` emitted by a codegen step). Their contents derive from an authoritative source at build time, so a hand-written sibling test would be tautological — test the generator, not its emitted output. The exclusion is anchored on the `.gen.<ext>$` suffix; files like `generator.ts` (substring "gen", no `.gen.` suffix) still require coverage.
- **Bare `types.ts` / `types.tsx` as a full path segment** are module-level type-definitions files colocated with their consumers (a natural React / Node.js convention — e.g. `packages/embedded-agent/src/tools/types.ts`). Same rationale as the `-types.ts` convention above: the type system enforces shape at consume sites. Exclusion is anchored on the segment boundary, so files like `mytypes.ts` (mid-segment match) or `type.ts` (singular, may contain runtime enums / factories) still require coverage.
- **Comment-only diffs** are exempted content-based, not path-based (Issue #1189). For each production file matching a coverage pattern, `check-utils.js`'s `findTestFiles()` inspects the file's actual diff hunks against the base branch (`git diff --unified=0`); if every added/removed line is a comment (`//`, `/* */` block, or `#` for `.sh`) or blank, the sibling-test requirement is skipped for that file. A mixed diff (any real code line alongside comment changes) still requires a sibling test. This exception cannot be expressed as a glob and is intentionally excluded from `check-mirror-drift.js`'s comparison, same as the `isTestFile()` negation entries above.

  Both `preflight-check.js` and `acceptance-check.js` call the same `findTestFiles()`, so this exemption has always been a single writer, not duplicated logic — Issue [#1463](https://github.com/ms2sato/agent-console/issues/1463) was filed on the mistaken premise that it wasn't. What was actually broken: the diff `findTestFiles()` reads defaults to the checked-out worktree's `HEAD`, which is correct when the process is running inside the exact PR being checked (CI's checkout, or `preflight-check.js`'s no-PR-number local mode) but wrong when checking an arbitrary PR number from a *different* worktree — `acceptance-check.js`'s actual usage pattern, run by the Orchestrator against whichever PR they're reviewing. `resolvePrDiffRef(prNumber)` resolves that PR's real base/head SHAs via the GitHub API and fetches them, so the comment-only check diffs against the PR's actual content regardless of what the calling worktree happens to have checked out. It fails loudly (no silent fallback to `HEAD`) if the SHAs can't be resolved or fetched, rather than quietly reproducing the original bug.

## Registering a smoke script (applies to every section below)

**A new `scripts/smoke/*` script registers both a `package.json` `check:` alias and an Additional Verification section here, in the same PR that adds it.** The sections below are instances of that rule, not a closed list — a sixth smoke needs a sixth section.

Do not read "this is a manual gate, never a CI job" as a reason to skip registration. **Every smoke listed below is a manual gate.** Registration is about *reachability* — a script nobody can find is a script nobody re-runs after the change that would have broken it — while automation is about CI, and the two decisions are independent. When a script is billable or needs an authenticated CLI, say so in its section, so a future reader knows the cost before running it rather than after.

(Lesson: Issue [#671](https://github.com/ms2sato/agent-console/issues/671)'s sibling problem, surfaced twice in one day. Two smokes were added in parallel and neither was registered; the second author could not have learned it from the first author's correction, because the requirement existed nowhere as a rule — only as four examples that a reader had to generalise from unprompted. A mechanical reconciliation of `scripts/smoke/*` against `package.json` is tracked separately; this sentence is what stops the next one in the meantime.)

**A new smoke script is born import-safe and born-covered.** Write it with a named `main()` whose only top-level invocation is guarded by `if (import.meta.main) { main(); }` — importing an exported function from it (the pattern this file's own sections use for a free, non-billed proxy verification) must never execute the script. `scripts/smoke/__tests__/import-safety.test.ts` discovers every `scripts/smoke/*.{ts,mjs}` via a glob and subprocess-imports each one, so a new script is enforced mechanically with no separate registration step for this specific check (Issue #1479).

## Additional Verification: Preview Sandbox Real-Browser Check

PRs touching `packages/client/src/lib/preview-sandbox.ts`, `packages/client/src/lib/__fixtures__/preview-sandbox-corpus.ts`, or `packages/client/src/components/workers/PreviewPanel.tsx` must run `bun run check:preview-sandbox-browser` locally before pushing. This runs `scripts/run-preview-sandbox-browser-check.mjs`, which re-verifies the mXSS regression corpus against a real Chromium browser — `bun:test`'s happy-dom environment does not reproduce Chromium's HTML5 parsing edge cases (see `.claude/rules/os-environment-coupling.md`). This check is a real-browser regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: PTY Master FD Leak Check

PRs touching `packages/server/src/lib/pty-provider.ts` or `packages/server/src/services/worker-manager.ts`'s `detachPty` must run `bun run check:pty-fd-leak` locally before pushing. This runs `scripts/smoke/check-pty-fd-leak.ts`, which drives 100 real spawn/kill cycles through the production `bunTerminalProvider` and asserts that the process's ptmx-fd count (`/proc/self/fd`) and the kernel-wide allocated-pty counter (`/proc/sys/kernel/pty/nr`) stay flat — confirming `BunTerminalPtyAdapter.dispose()` actually releases the `Bun.Terminal` master-fd handle deterministically, rather than relying on the object becoming unreachable and incidentally GC-finalized (unsound in production, where `InternalPtyWorker.pty` stays reachable via session/worker maps for the life of the worker) (see Issue #1196). This check is a real-fd regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: Artifact Sandbox Boundary Real-Browser Check

PRs touching `packages/server/src/routes/artifacts.ts` (the `ARTIFACT_SERVING_CSP` header), `packages/server/src/routes/artifacts-viewer.ts` (the navigation-jail shell), or the `create_html_artifact` MCP tool in `packages/server/src/mcp/mcp-server.ts` must run `bun run check:artifact-sandbox-boundary` locally before pushing. This runs `scripts/smoke/check-artifact-sandbox-boundary.mjs`, which is the load-bearing real-Chromium probe for `docs/design/html-artifacts.md` §3's CSP sandbox boundary (premises P1/P2): it boots a disposable multi-user-mode server instance, creates a real artifact via a real MCP call, and drives a real headless browser through the opaque-origin document to confirm cookies, localStorage, credentialed same-origin fetch, external fetch, and external form POST are all blocked exactly as the design doc requires — plus same-run positive controls proving the walls are the sandbox's rather than the environment's. This check is a real-browser regression gate for a security boundary, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

Those same PRs must also run `bun run check:artifact-server-story-e2e`. This runs `scripts/smoke/check-artifact-server-story-e2e.mjs`, the real-HTTP server-story E2E for `docs/design/html-artifacts.md` §8's per-surface E2E (terminal half) and the create→serve→list→delete→serve round trip: it boots its own disposable multi-user-mode server instance, creates an artifact via a real `/mcp` JSON-RPC call (the actual terminal-agent-shaped call), verifies the artifact's stored `user_id` against the session's `createdBy` via a direct read of the disposable instance's SQLite file (the wire responses never expose `userId`), then drives the full `GET /:id` (exact CSP header) → `GET /` (list) → `DELETE /:id` → `GET /:id` (404) sequence as real HTTP. This check is a real-HTTP regression gate for the routes' shipping-path caller, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: Fatal Incarnation Replacement Real-Tree E2E

PRs touching `handleEngineFatal` / `collectFatalIncarnation` / `fatalLeavesHarnessAlive` / the `fatalChainReplacementSpent` set in `packages/server/src/services/embedded-agent-worker-service.ts`, or that file's `deactivate` escalation, must run `bun run check:fatal-incarnation-replacement` locally before pushing. This runs `scripts/smoke/check-fatal-incarnation-replacement.ts`, the real-process E2E for the defect where a `claude-sdk` worker's `claude` grandchild dies while its harness stays alive: it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives a real `claude-sdk` incarnation through a real `sh` -> `bun` -> `claude` tree, and SIGKILLs **only the grandchild** -- the one death shape that produces no OS exit for the server to observe. It then asserts the incarnation is replaced, the stranded processes are gone, the dead incarnation's MCP token no longer verifies **against the token registry itself** (no frame can substitute for that), and that the conversation survived the process boundary by recalling a word planted before the kill. A mid-turn kill covers the `turn-interrupted` marker, and a whole-tree kill in the same run is the positive control proving the healthy path was not what changed.

This is a real-process regression gate for a defect the unit layer structurally cannot catch -- the wedge only exists because a live harness hides a dead engine, and every fake spawn has an exit the observer sees. It is not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

Two properties of the script that matter when re-running it:

- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user, like the SDK probes under `scripts/smoke/`. It is a manual gate, never a CI job.
- **It has a polarity mode.** `bun run check:fatal-incarnation-replacement -- --expect-brick`, run against a build whose fatal routing is removed, **asserts the bug reproduces** rather than merely tolerating a failure -- a run that silently recovers is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".
- **The run's worker NDJSON is captured before the disposable home is deleted.** The script's `finally` block copies every `outputs/<sessionId>/<workerId>.log` file out of the disposable `AGENT_CONSOLE_HOME` to `$HOME/.agent-console-smoke-captures/check-fatal-incarnation-replacement/<disposable-home-basename>/` — printed to stdout as `worker NDJSON captured to: ...` — strictly BEFORE `rmSync` removes that home. Read this **before** running the smoke, not after losing a run you wanted to keep: without this, every run's raw event stream is destroyed the moment the run ends, which is what happened to the reader shape recorded in Issue [#1468](https://github.com/ms2sato/agent-console/issues/1468) (observed in 1 of 6 runs, never captured, and unrecoverable once gone — see that Issue for the shape itself, deliberately not turned into a hand-built fixture). The capture is wrapped so its own failure (e.g. an unwritable destination) never affects the smoke's exit code or skips the disposable-home cleanup that follows it.
  - **Why `$HOME`, not `os.tmpdir()`.** `/tmp` is reboot-cleared on Ubuntu and may be swept by `systemd-tmpfiles` on an age basis; this smoke's billed runs also happen inside a delegate's worktree, itself deleted post-merge. Both are the same loss this Issue exists to stop — the NDJSON that prompted it (`/tmp/fatal3.log`) was already gone through exactly this route by the time anyone asked for it. `$HOME` survives both.
  - **Lifetime: not auto-pruned.** Each manual run adds one directory here. There is no cleanup job — runs are infrequent and small, and the operator who ran the smoke is expected to remove capture directories they no longer need (`rm -rf ~/.agent-console-smoke-captures/check-fatal-incarnation-replacement/<basename>`).
- **`bun run check:fatal-incarnation-replacement-artifact-capture` verifies the capture mechanism without a billed run.** This runs `scripts/smoke/check-fatal-incarnation-replacement-artifact-capture.ts`, which imports the exported `captureWorkerNdjson` function directly and exercises it against a synthetic disposable home containing a fake worker NDJSON file — no `AppContext`, no subprocess, no `claude` CLI. It is the Q13 proxy for this specific mechanism (`pre-pr-completeness.md`): the capture logic is pure filesystem plumbing sitting upstream of, and outside, the billable chain, so a billed run is not the right instrument to verify it with. It asserts the file survives at the capture destination byte-for-byte, that the disposable home is still removed on the default path, and that a forced capture failure (a same-named file blocking the destination directory) never changes the wrapping smoke's own exit code. Free to run, and worth re-running after any change to `captureWorkerNdjson` or the `finally` block's ordering — it is a manual gate like its billed sibling, not a CI job.

## Additional Verification: Idle Eviction Both-Polarities E2E

PRs touching `packages/server/src/services/embedded-agent-idle-eviction.ts`, the eviction machinery in `packages/server/src/services/embedded-agent-worker-service.ts` (`touchIdle` / `onIdleExpired` / `ensureDeliverable`, the `ready` / `evicting` / `evictable` runtime fields, or `handleExit`'s `reason` classification), or `EMBEDDED_AGENT_IDLE_EVICTION_MS` in `packages/server/src/lib/server-config.ts`, must run `bun run check:embedded-agent-idle-eviction` locally before pushing. This runs `scripts/smoke/check-embedded-agent-idle-eviction.ts`, the shipping-path E2E for idle eviction (Issue [#1412](https://github.com/ms2sato/agent-console/issues/1412)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives two real `claude-sdk` workers through real `sh` -> `bun` -> `claude` trees, and lets the real server-side timer evict one of them.

**It carries both polarities in one run, and the negative control is the point.** Subject A is activated first and control B later, so at the instant A's countdown elapses B is still inside its own — without that, "A was evicted" cannot be distinguished from "everything gets killed". The run asserts A's harness and its `claude` descendant are gone while B's are both alive, that A's persisted row is stamped `reason: 'evicted'` and reaches the global worker-exit callback as such, that B has no `exited` row at all, and that a message to the evicted A wakes it and **recalls a nonce planted before the eviction** on the same SDK session id. B, asked the identical question, must answer `UNKNOWN` — that control is what makes A's recall attributable to the resume rather than to a guessable prompt.

Two properties of the script that matter when re-running it:

- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user — the `claude-sdk` builtin runs as the executing user and uses that user's own authentication, so there is no API key to configure. Roughly five real turns per run. It is a manual gate, never a CI job, which is why it has a `check:` alias but no workflow.
- **`--idle-ms N` sets the threshold** (default 45 s) so a run takes minutes rather than the production half-hour. That substitution is upstream of and outside the chain under test: it changes how long the script waits to arrive at the eviction, never what eviction does.

**Do not weaken the graceful-exit assertion without re-measuring its reach.** The script asserts the `exited` row's `code` is `0` — that eviction went through the shutdown protocol rather than a signal — and that assertion exists because a mutation measurement showed the rest of the script could not tell the two apart. Replacing the deactivation call with a direct `SIGKILL` of the harness, which is exactly the hazard-line violation Issue [#1414](https://github.com/ms2sato/agent-console/issues/1414) makes dangerous, **passed all twenty other assertions**: the child dies anyway when it loses its stdio pipes, the exit observer still fires, and the reason is still `evicted`. Only the settle latency (1 ms against 253 ms) and the exit code moved, and the exit code is the one that separates them deterministically. The script's own comments carry that measurement and the negative control's known limit.

## Restore E2E and smoke: the conversation must use a tool

**A conversation used to verify restore in an E2E or smoke must include at least one tool-using turn.** A text-only exchange cannot produce the event order a tool-using turn writes, and that order is where restore has actually broken.

The two engines disagree about it. `openai-api` emits an iteration's (possibly empty) `assistant-message` and then its `tool-call`s; `claude-sdk` emits a `tool-call` as soon as it observes one, flushing the assistant message afterwards, because an iteration opening with a tool use has no accumulated text to flush yet. The restore reader was written against the first shape and rejected the second, so **every `claude-sdk` turn that began with a tool call failed reconstruction and fell to the destructive reset** — on a two-turn conversation of thirteen lines, with no rotation involved.

Every shipped `claude-sdk` restore E2E and smoke was text-only. That is the whole reason the defect reached a user-facing surface with the feature otherwise fully covered: within a single process it works, and the failure appears only across a restart, only after a tool was used, and only as an absence.

In practice this costs a file and a sentence: write a nonce into the session's working directory and have the planting turn read it with `Read`, instead of putting the nonce in the message text. `scripts/smoke/check-embedded-agent-idle-eviction.ts` and `scripts/smoke/check-fatal-incarnation-replacement.ts` both do this, and are the worked examples.

### The recall assertion needs a negative control in the same run

**An assertion whose oracle is a model's generated text — a recall check, or anything read out of produced prose — must be accompanied, in the same run, by a control that fails when the fact under test is false.**

This is the reach measurement for a non-deterministic oracle, and it stands in the same place as mutation measurement for a deterministic pin. `workflow.md`'s standing rule is that a check's detection power is measured rather than assumed; what changes is the lever, and it changes with what the check reads:

| What the check reads | How its reach is measured |
|---|---|
| A deterministic system | **Mutate the code** — ordinary mutation measurement |
| A fixture's premise | **Assert the shape is present** — the tool-turn rule above |
| **A non-deterministic oracle** (a model's answer) | **Control the world** — neither code nor model can be mutated, so a negative control is the only lever left |

**Choose the control to match the threat; the two shapes are not interchangeable.**

- **The same question, asked of a second worker that never had the fact.** Controls for the question being answerable by anyone. `check-embedded-agent-idle-eviction.ts` uses this, because it already has a second worker and its risk is a guessable prompt.
- **A question about a fact that was never true, asked of the same worker.** Controls for that worker answering agreeably to anything — confabulation. `check-fatal-incarnation-replacement.ts` uses this, because it has one worker and a resume, and a resumed worker inventing a plausible answer is its specific risk.

**Be precise about what the control buys, because it is easy to credit it with more.** When the recalled token is unguessable — a random nonce, or a literal that exists only in the script — the recall assertion was never vacuous against blind invention in the first place: a model that never saw the token cannot emit it. The control does not rescue it from that. What it adds is narrower and still worth having: evidence that the worker returns a truthful negative when it genuinely lacks something, so a passing recall is not merely an agreeable answer.

**And check first whether the fact has a second route to the model.** A control cannot see one. If the nonce is also sitting in a file the worker can still read, the recall passes by reading it back, and no control over the model's answers detects that — the answer is genuine, it just came from somewhere the assertion's label does not claim. **Close the route (remove the file once the planting turn has used it), then pin that it stayed closed (assert the recall turn emitted no `tool-call`).** The first makes the assertion true; the second measures that it stays true.

**Absence assertions are the ones read-too-early makes pass falsely.** An absence check read early passes *because the thing has not happened yet*, identically whether or not it was going to. So an absence assertion is only as strong as the latest moment it could observe: **snapshot it after the boundary past which the event would no longer be written** (a turn's `idle`, a replacement's `ready`), never at the first sign the turn produced.

**A presence check is safe only when it is SCOPED to the current turn or incarnation** — by a baseline index, a slice, a **baseline-relative** occurrence count, or an identifier carried on the event. An unscoped presence check that scans accumulated history can be satisfied by an *earlier* event of the same type: a wait for "the replacement reported `ready`" written as `events.some(e => e.type === 'ready')` is satisfied by the first incarnation's `ready` and returns immediately, having observed nothing. Scoped forms that work: `.slice(marker).some(...)`, `const before = events.filter(...).length` then waiting for the count to exceed `before`, `.some(e => e.turnId === turnId)`. **A hard-coded count is not one of them**: `.filter(...).length >= 2` encodes an assumption about how many matching events history already holds, and passes immediately the moment that assumption is off by one. It is contextually safe at best -- correct in a run where exactly one such event precedes it, and silently vacuous in any run where two do.

**Defining the class by polarity is what makes a sweep possible, but a single-syntax grep is not the sweep.** `!x.some(...)` is one JavaScript form; the same assertion is written as `x.every(e => e.type !== 'k')`, `x.filter(...).length === 0`, `!x.find(...)`, `!s.includes(...)`, and a zero-length or `=== undefined` comparison. **Search for each known form — and treat that list as known forms rather than an exhaustive one**, because the next equivalent spelling is not in it. Enumerable beats a judgement like "reads too early"; it does not mean complete, and "I grepped, therefore I swept" is the failure this paragraph exists to block.

**That pin is also the boundary of this rule.** **Do not read this as "add more assertions over the event stream".** No assertion over emitted events could have caught the instance that produced this rule: the defect lived in a natural-language presupposition inside the question text, and the event stream is precisely where that is invisible. The tool-turn rule above is enforceable by asserting a shape; this one is not, which is why it needs a control rather than another pin. **But do not run the inference backwards.** "The premise is invisible to the event stream" does not license "recall assertions cannot be checked structurally": the second-route property above *is* visible there and must be pinned. Control what is genuinely unobservable; pin everything else.

(Lesson: both smokes had their planting turn routed through a tool in one change, which made "the secret word I told you" false in both. The eviction smoke's control broke loudly and forced an investigation; the fatal smoke's recall **passed, 18 of 18**, and forced nothing. The difference was not the defect, which was identical — it was how the model happened to answer once. **A green run there was a fact about one sampling of a non-deterministic answer, not a fact about the assertion.** It was found by review, after both an implementer and an orchestrator had read the run as clean.)

## Additional Verification: Restore-Boundary Usage-Seed Real-Provider E2E

PRs touching `findRestoredUsageSeed` / `reconstructConversation`'s `usageSeed` in `packages/embedded-agent/src/restore.ts`, `AgentLoop`'s `resolveRestoreBoundaryUsage` / `compactAtRestoreBoundaryIfNeeded` in `packages/embedded-agent/src/agent-loop.ts`, or the `restoredUsage` field on the `init` command (`packages/shared/src/{types,schemas}/embedded-agent.ts`, and where `packages/server/src/services/embedded-agent-worker-service.ts` composes it) must run `bun run check:restore-boundary-usage-seed` locally before pushing. This runs `scripts/smoke/check-restore-boundary-usage-seed.ts`, the real-provider E2E for the restore-boundary compaction check: it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, creates a real `openai-api` definition with a deliberately conservative declared window, grows a conversation with **real billed turns** until the provider's own reported `prompt_tokens` clears the threshold, then restarts the worker and asserts the activation decided on the persisted **measurement** rather than on `estimateTokensFromChars`.

The reason a unit test cannot substitute: the defect is a disagreement between two numbers, and only one of them is ours. A fake adapter can be told to report anything, which makes the gap an input rather than a measurement — so the unit layer can pin the extraction rule and the max rule, but only the real chain establishes that the gap exists at the size the fix assumes. Measured 2026-08-29 on a 12,000-token declared window: the estimator read **5,450** where the provider reported **10,512** for the same conversation.

Two properties of the script that matter when re-running it:

- **It is billable and needs a provider key** resolvable for `PROVIDER_KEY_REF` (default `opencode-go`, read from the single-user dev home; override with `PROVIDER_KEY_FILE`). It is a manual gate, never a CI job. A run is a handful of small turns — cents, not dollars.
- **It has a polarity mode.** `bun run check:restore-boundary-usage-seed -- --expect-underfire`, run against a tree whose fix is removed (`git checkout origin/main -- packages/` and back), **asserts the defect reproduces** rather than merely tolerating a failure — a run that silently compacts is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".

**What it does not reach, and why that is arithmetic rather than effort.** The Issue's full wedge ends in a provider 400 no `Compact` can escape. Reaching it needs the declared window to be both honest and small: with `G` the tool-schema gap and `T` the threshold, `W < G / (1 - T)` — about 37,500 tokens at the measured defaults. The smallest context window across the dev instance's provider catalogue is 196,608, and that model silently truncates rather than erroring, so the 400 is unreachable there. The downstream link (a turn ending in error settles no compaction) is pinned in `packages/embedded-agent/src/__tests__/agent-loop-compaction.test.ts` instead, where a turn's ending is directly constructible.

## Additional Verification: Compaction Identifier-Fidelity Probe

PRs touching `DEFAULT_COMPACTION_PROMPT` / `loadCompactionPrompt` in `packages/embedded-agent/src/compaction-prompt.ts`, or `AgentLoop.compact()`'s distillation call in `packages/embedded-agent/src/agent-loop.ts`, should run `bun run check:compaction-fidelity` locally before pushing (measurement, not a pass/fail gate — see below). This runs `scripts/smoke/probe-compaction-fidelity.ts`, the real-provider measurement for Issue [#1350](https://github.com/ms2sato/agent-console/issues/1350): whether conversation-local identifiers stated as **ordinary facts, with no preservation coaching**, survive a real `openai-api` compaction boundary verbatim. It boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, plants three synthetic identifiers (a run id, a filename, a change reference) in a single uncoached turn, drives real pressure-round turns until a real `context-compacted` boundary fires, and reads the boundary's own persisted `summary` field — the actual distillation text the model produced — for each identifier's presence.

**Why this is a measurement, not a gate.** Per the Issue's own ruling: "a post rate not better than pre is a finding to report, not to hide." The script never fails on a low retention rate — it exits 0 whenever every requested run reached a real boundary and its summary was read, regardless of what fraction of identifiers survived. A non-zero exit means the *harness* could not produce a measurement (a run never reached a boundary within its round/time budget, a turn errored or timed out), which is a different fact from a low rate.

**Why this is the real-provider chain and not a unit test.** The retention outcome is a property of what a real LLM does when asked to distil a real conversation under a real prompt — no fake adapter's output can stand in for that without begging the question the Issue is about. There is currently no CI-level pin on the prompt's composition, since no preservation clause has shipped; this script is the only measurement that exists for this prompt today.

Two properties of the script that matter when re-running it:

- **It is billable and needs a provider key**, same resolution as `check:restore-boundary-usage-seed` (`PROVIDER_KEY_REF`, default `opencode-go`, read from the single-user dev home; override with `PROVIDER_KEY_FILE`). It is a manual gate, never a CI job. A run is a handful of small turns per `--n` repetition — cents, not dollars.
- **`--prompt-file <path>` selects the arm.** Omitted, the run measures the CURRENT bundled `DEFAULT_COMPACTION_PROMPT` (the PRE arm). Passed, the run measures the file's content instead, delivered through the exact same repo-layer override path `loadCompactionPrompt()` reads in production (`<cwd>/.agent-console/compaction-prompt.md`) — there is no test-only fork of the loader. `--n <count>` repeats the arm and aggregates a retention rate; comparing a PRE run against a POST run (pointed at a candidate revised prompt) is how a change to the clause is evaluated before it ships.

## Before Creating a PR

Run the coverage check to verify all production files have corresponding tests:

```bash
# With a PR number (uses gh pr diff):
node .claude/skills/orchestrator/preflight-check.js <PR-number>

# Without a PR number (uses local git diff against origin/main):
node .claude/skills/orchestrator/preflight-check.js
```

If any gaps are detected (non-zero exit code), add the missing tests before proceeding.

## Mirror Maintenance

The patterns above are a **markdown mirror** of the executable single-writer `COVERAGE_PATTERNS` in `.claude/skills/orchestrator/check-utils.js` (the source of truth used by `preflight-check.js`). When updating one, update the other in the same PR.

Drift between the two is detected mechanically by `.claude/skills/orchestrator/check-mirror-drift.js` (CI workflow: `.github/workflows/check-mirror-drift.yml`). To verify locally:

```bash
node .claude/skills/orchestrator/check-mirror-drift.js
```

The check normalizes the regex `^DIR\/.+\.EXT$` shape to its glob `DIR/**/*.EXT` equivalent and compares against both the markdown table above and the YAML `globs:` frontmatter. Negation entries in the YAML (`!**/*.test.ts`, `!**/__tests__/**`) mirror the `isTestFile()` helper rather than `COVERAGE_PATTERNS`, and are excluded from the comparison. (Issue #752)
