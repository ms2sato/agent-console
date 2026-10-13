---
paths:
  - "packages/server/src/services/embedded-agent-worker-service.ts"
  - "packages/server/src/services/embedded-agent-idle-eviction.ts"
  - "packages/server/src/services/session-manager.ts"
  - "packages/server/src/lib/server-config.ts"
  - "packages/server/src/lib/worker-output-file.ts"
  - "packages/server/src/lib/session-data-path-resolver.ts"
  - "packages/server/src/lib/session-data-path.ts"
  - "packages/server/src/lib/memory-dir.ts"
  - "packages/server/src/lib/mcp-server-permissions.ts"
  - "packages/server/src/jobs/handlers.ts"
  - "packages/server/src/mcp/mcp-server.ts"
  - "packages/server/src/services/shared-account-registry.ts"
  - "packages/server/src/services/resolve-disable-claude-ai-connectors.ts"
  - "packages/server/src/services/embedded-agents/claude-sdk-builtin.ts"
  - "packages/server/src/routes/worktrees.ts"
  - "packages/server/src/routes/sessions.ts"
  - "packages/server/src/routes/shared-accounts.ts"
  - "packages/server/src/routes/auth.ts"
  - "packages/embedded-agent/src/restore.ts"
  - "packages/embedded-agent/src/attachment-content.ts"
  - "packages/embedded-agent/src/agent-loop.ts"
  - "packages/embedded-agent/src/main.ts"
  - "packages/embedded-agent/src/sdk-engine.ts"
  - "packages/embedded-agent/src/system-prompt.ts"
  - "packages/embedded-agent/src/mcp-discovery.ts"
  - "packages/embedded-agent/src/tools/types.ts"
  - "packages/embedded-agent/src/tools/read.ts"
  - "packages/embedded-agent/src/tools/write.ts"
  - "packages/embedded-agent/src/tools/edit.ts"
  - "packages/shared/src/constants/messages.ts"
  - "packages/shared/src/types/embedded-agent.ts"
  - "packages/shared/src/schemas/embedded-agent.ts"
  - "scripts/smoke/check-fatal-incarnation-replacement.ts"
  - "scripts/smoke/check-fatal-incarnation-replacement-artifact-capture.ts"
  - "scripts/smoke/check-embedded-agent-idle-eviction.ts"
  - "scripts/smoke/check-embedded-agent-idle-eviction-openai-api.ts"
  - "scripts/smoke/check-restart-all-embedded.ts"
  - "scripts/smoke/check-shared-account-binding.ts"
  - "scripts/smoke/check-restore-failure-declaration.ts"
  - "scripts/smoke/check-bulk-restart-exited-row.ts"
  - "scripts/smoke/check-embedded-agent-image-attachments.ts"
  - "scripts/smoke/check-restore-boundary-usage-seed.ts"
  - "scripts/smoke/check-instruction-loader-parity-e2e.ts"
  - "scripts/smoke/check-embedded-agent-memory-layer.ts"
  - "scripts/smoke/check-embedded-agent-project-mcp-permission.ts"
  - "scripts/smoke/check-claude-sdk-connectors-toggle.ts"
---

# Smoke Verification: embedded-agent E2Es

Smoke registrations for embedded-agent E2Es; the registration rule and the reachability exceptions live in `test-trigger.md`.

**Shared prerequisites (referred to by the sections below).** Every billable smoke here is a manual gate (the registration rule in `test-trigger.md`). A `claude-sdk` arm needs the invoking OS user's own real, authenticated `claude` CLI (the builtin runs as that user; no API key to configure). Billable sections state it with one clause (`Billable (...)`). An `openai-api` arm needs a provider key resolvable for `PROVIDER_KEY_REF` (default `opencode-go`, read from the single-user dev home; override with `PROVIDER_KEY_FILE`).

## Additional Verification: Fatal Incarnation Replacement Real-Tree E2E

PRs touching `handleEngineFatal` / `collectFatalIncarnation` / `fatalLeavesHarnessAlive` / the `fatalChainReplacementSpent` set in `packages/server/src/services/embedded-agent-worker-service.ts`, or that file's `deactivate` escalation, must run `bun scripts/smoke/check-fatal-incarnation-replacement.ts` locally before pushing. This is the real-process E2E for the defect where a `claude-sdk` worker's `claude` grandchild dies while its harness stays alive: it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives a real `claude-sdk` incarnation through a real `sh` -> `bun` -> `claude` tree, and SIGKILLs **only the grandchild** -- the one death shape that produces no OS exit for the server to observe. It then asserts the incarnation is replaced, the stranded processes are gone, the dead incarnation's MCP token no longer verifies **against the token registry itself** (no frame can substitute for that), and that the conversation survived the process boundary by recalling a word planted before the kill. A mid-turn kill covers the `turn-interrupted` marker, and a whole-tree kill in the same run is the positive control proving the healthy path was not what changed.

It is not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns in `test-trigger.md`.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue) for `check-fatal-incarnation-replacement.ts` itself; its companion `check-fatal-incarnation-replacement-artifact-capture.ts` below is Unprivileged (no tier-2/3/4 residue; any machine with bun) — it has no `## Additional Verification:` section of its own.

Re-running:

- **Billable (`claude` CLI).**
- **It has a polarity mode.** `bun scripts/smoke/check-fatal-incarnation-replacement.ts -- --expect-brick`, run against a build whose fatal routing is removed, **asserts the bug reproduces** rather than merely tolerating a failure -- a run that silently recovers is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".
- **The run's worker NDJSON is captured before the disposable home is deleted.** The script's `finally` block copies every `outputs/<sessionId>/<workerId>.log` file out of the disposable `AGENT_CONSOLE_HOME` to `$HOME/.agent-console-smoke-captures/check-fatal-incarnation-replacement/<disposable-home-basename>/` — printed to stdout as `worker NDJSON captured to: ...` — strictly BEFORE `rmSync` removes that home. Without the capture every run's raw event stream is destroyed when the run ends (Issue [#1468](https://github.com/ms2sato/agent-console/issues/1468); `docs/narratives/2026-10-12-fatal-incarnation-ndjson-capture.md`). The capture is wrapped so its own failure (e.g. an unwritable destination) never affects the smoke's exit code or skips the disposable-home cleanup that follows it.
  - **Stored under `$HOME`, not `os.tmpdir()`,** because `/tmp` is reboot-cleared and the run's worktree is deleted post-merge; `$HOME` survives both.
  - **Lifetime: not auto-pruned.** Each manual run adds one directory here. There is no cleanup job — runs are infrequent and small, and the operator who ran the smoke is expected to remove capture directories they no longer need (`rm -rf ~/.agent-console-smoke-captures/check-fatal-incarnation-replacement/<basename>`).
- **`bun scripts/smoke/check-fatal-incarnation-replacement-artifact-capture.ts` verifies the capture mechanism without a billed run.** It imports the exported `captureWorkerNdjson` function directly and exercises it against a synthetic disposable home containing a fake worker NDJSON file — no `AppContext`, no subprocess, no `claude` CLI. It is the Q13 proxy for this specific mechanism (`pre-pr-completeness.md`): the capture logic is pure filesystem plumbing sitting upstream of, and outside, the billable chain, so a billed run is not the right instrument to verify it with. It asserts the file survives at the capture destination byte-for-byte, that the disposable home is still removed on the default path, and that a forced capture failure (a same-named file blocking the destination directory) never changes the wrapping smoke's own exit code. Free to run, and worth re-running after any change to `captureWorkerNdjson` or the `finally` block's ordering — it is a manual gate like its billed sibling, not a CI job.

## Additional Verification: Idle Eviction Both-Polarities E2E

PRs touching `packages/server/src/services/embedded-agent-idle-eviction.ts`, the eviction machinery in `packages/server/src/services/embedded-agent-worker-service.ts` (`touchIdle` / `onIdleExpired` / `ensureDeliverable`, the `ready` / `evicting` / `evictable` runtime fields, or `handleExit`'s `reason` classification), or `EMBEDDED_AGENT_IDLE_EVICTION_MS` in `packages/server/src/lib/server-config.ts`, must run `bun scripts/smoke/check-embedded-agent-idle-eviction.ts` locally before pushing. This is the shipping-path E2E for idle eviction (Issue [#1412](https://github.com/ms2sato/agent-console/issues/1412)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives two real `claude-sdk` workers through real `sh` -> `bun` -> `claude` trees, and lets the real server-side timer evict one of them.

**It carries both polarities in one run, and the negative control is the point.** Subject A is activated first and control B later, so at the instant A's countdown elapses B is still inside its own — without that, "A was evicted" cannot be distinguished from "everything gets killed". The run asserts A's harness and its `claude` descendant are gone while B's are both alive, that A's persisted row is stamped `reason: 'evicted'` and reaches the global worker-exit callback as such, that B has no `exited` row at all, and that a message to the evicted A wakes it and **recalls a nonce planted before the eviction** on the same SDK session id. B, asked the identical question, must answer `UNKNOWN` — that control is what makes A's recall attributable to the resume rather than to a guessable prompt.

Re-running:

- **Billable (`claude` CLI):** roughly five real turns per run.
- **`--idle-ms N` sets the threshold** (default 45 s) so a run takes minutes rather than the production half-hour; the substitution is upstream of the chain under test.

**Do not weaken the graceful-exit assertion without re-measuring its reach.** The script asserts the `exited` row's `code` is `0` — that eviction went through the shutdown protocol rather than a signal — and that assertion exists because a mutation measurement showed the rest of the script could not tell the two apart. The measurement (a direct `SIGKILL` of the harness passed all twenty other assertions; only the settle latency and the exit code moved) is recorded in `docs/narratives/2026-10-12-idle-eviction-graceful-exit-mutation.md`. The script's own comments carry that measurement and the negative control's known limit.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Idle Eviction, `openai-api` Revival Mechanism E2E

PRs touching the `isEvictableEngine` predicate or the `evictable` assignment in `packages/server/src/services/embedded-agent-worker-service.ts`, or the `openai-api` reconstruction path in `packages/embedded-agent/src/restore.ts`, must run `bun scripts/smoke/check-embedded-agent-idle-eviction-openai-api.ts` locally before pushing. This is the shipping-path E2E for extending idle eviction to `openai-api` (Issue [#1502](https://github.com/ms2sato/agent-console/issues/1502)).

**It is a sibling of `check-embedded-agent-idle-eviction.ts`, not an extension:** the eviction MECHANISM is engine-agnostic and proven there; this script verifies the REVIVAL mechanism, which `openai-api` reconstructs from the persisted NDJSON log on every activation (no provider-side session). It drives a tool-using planting turn across a real eviction, per this file's "Restore E2E and smoke" section, and asserts the mechanism used (`restoreInfo.sdkResumed === undefined` and `restoredMessageCount > 0`), not merely that recall succeeded. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

Two-worker shape as in the `claude-sdk` script (subject A evicted, control B activated later); B is also the recall control (never heard the nonce, must answer `UNKNOWN`) because the threat is guessability, not confabulation.

Re-running:

- **Billable (provider key):** a handful of small real HTTP turns per run.
- **`--idle-ms N` sets the threshold** (default 45 s), as in the `claude-sdk` sibling.

**It has a polarity mode.** `bun scripts/smoke/check-embedded-agent-idle-eviction-openai-api.ts -- --expect-not-evictable`, run against a tree with the `isEvictableEngine` fix reverted to `definition.engine === 'claude-sdk'`, asserts A is NOT evicted within its threshold — this is literally the pre-#1502 bug, so the polarity mode doubles as the "confirm the apparatus reaches the defect" check `workflow.md`'s "A check's existence is not its detection power" requires.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Restart-All Embedded-Worker Real-Provider E2E

PRs touching `SessionManager.restartAllAgentWorkers` in `packages/server/src/services/session-manager.ts`, or `EmbeddedAgentWorkerService.restartIfActive` in `packages/server/src/services/embedded-agent-worker-service.ts`, must run `bun scripts/smoke/check-restart-all-embedded.ts` locally before pushing. This is the shipping-path E2E for restart-all's inclusion of embedded-agent workers (Issue [#1519](https://github.com/ms2sato/agent-console/issues/1519)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives two real `claude-sdk` embedded-agent workers through real `sh` -> `bun` -> `claude` trees, and calls the real `SessionManager.restartAllAgentWorkers()` -- the same method both `restart_all_agents` and `POST /api/sessions/restart-all-agents` call.

**Modeled on `check-embedded-agent-idle-eviction.ts`, but restart-all acts on every active worker in one sweep:** both workers are activated together and BOTH must be restarted by the one call. The second worker is the recall control (guessability threat; this file's "Restore E2E and smoke" threat table), not a selectivity control. "Fresh incarnation" is a before/after harness-pid comparison (must differ), and the pre-restart incarnation's persisted `exited` row is asserted `reason: 'managed'` to distinguish it from idle eviction's `'evicted'`. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

Re-running:

- **Billable (`claude` CLI):** three real turns per run in default mode (plant, recall, recall-control); polarity mode skips the recall-control turn (its B-side check is a pid comparison).
- **`--help` is free (Issue [#1552](https://github.com/ms2sato/agent-console/issues/1552)).** A pure, exported `parseArgs` parses argv and prints usage before any `AppContext`, disposable home, or `claude` spawn — the script is inspectable without billing. An unrecognised flag throws with the same usage text, mapped by `main()`'s top-level `.catch()` to exit 2.
- **`--expect-not-restarted` is the polarity mode.** It runs the identical two-worker setup and calls the real `restartAllAgentWorkers({ kind: 'all' })`, then asserts the pre-#1519 BUG instead of the fix: both harness pids stay unchanged, neither worker gains an `exited` row within a 5s bounded poll (`pollExitedCount`, shared by A and B -- an immediate, unbounded read only proves "none had appeared yet at this instant", not "none appears"), and a recall against A succeeds trivially because it is the same, never-restarted incarnation. A worker that IS actually restarted under this flag is a POLARITY FAILURE (exit 1), never tolerated. Run it against a one-hunk SCRATCH revert of the `embedded-agent` branch in `SessionManager.restartAllAgentWorkers` (replacing the `restartIfActive` call and its result push with a plain `continue`, mirroring the `terminal`-worker skip two cases above it — never committed) to confirm the apparatus reaches the defect, per `workflow.md`'s "A check's existence is not its detection power".

**Measured 2026-10-10 (`main` at ef7fd39b):** default mode PASSED 10/10; `--expect-not-restarted` against a one-hunk scratch revert reproduced the bug (7/7, exit 0); against the unmodified tree it exited 1 with `POLARITY FAILURE` (3 passed / 4 failed). Full record: `docs/narratives/2026-10-12-restart-all-embedded-polarity-measurements.md`.

**Known gap, tracked as Issue [#1944](https://github.com/ms2sato/agent-console/issues/1944): B's `exited`-row-within-5s pin reads `OK` on the real tree even though B is actually restarted, so it is currently vacuous for B.** It is kept as written because, once #1944 is fixed, it becomes B's regression net: run 3 (real tree, unmodified) must then flip from 3 pass / 4 fail to **2 pass / 5 fail**. Treat a future 2p/5f result on that exact invocation as the fix landing, not as a new failure. Diagnostic evidence: `docs/narratives/2026-10-12-restart-all-embedded-polarity-measurements.md`.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Shared-Account Binding Smoke

PRs touching `SharedAccountRegistry` (`packages/server/src/services/shared-account-registry.ts`), the `shared: true` branches in `packages/server/src/routes/worktrees.ts` or `packages/server/src/routes/sessions.ts`, `RepositoryRepository.getSharedAccountUserId` / `RepositoryManager.getSharedAccountUserId`, or the register/unregister live-cache hookup in `packages/server/src/routes/shared-accounts.ts`, must run `bun scripts/smoke/check-shared-account-binding.ts <account-A-username> <account-B-username>` locally before pushing. This is the shipping-path E2E for the shared-accounts Release 2 cutover (DB-backed set + per-repository binding actually consumed by session creation, Issue [#1842](https://github.com/ms2sato/agent-console/issues/1842)): it boots a disposable multi-user `AppContext` (`createTestContext`, in-memory SQLite) with a real `/api` router mounted, registers two real target OS users as shared accounts through the real `POST /api/shared-accounts` route, binds two real scratch git repositories (R1 -> account A, R2 -> account B) through the real `PATCH /api/repositories/:id` route, and creates a shared worktree session on each through the real `POST /api/repositories/:id/worktrees` route.

**It asserts the set/binding split, not just "a shared session spawns as someone".** Beyond the per-account PTY-identity assertion (below), it asserts a quick session with `shared: true` is unconditionally refused (400, Issue #1842 item 4), then rebinds R1 -> account B and asserts the EXISTING R1 session (created against the OLD binding, before the rebind) is STILL operable by a caller who is neither its owner nor the repository's new binding -- proving membership of the shared-account SET, not the repository's CURRENT binding, is what authorizes operating an already-created session (`assertCanOperateSession`, exercised via the real `PUT /api/sessions/:id/memo` route).

**PTY-identity proof reads a TERMINAL-type worker added to the shared session, not the session's own initial AGENT-type worker.** The verification container has no `claude` CLI login, so an agent-type worker's PTY exits 127 and `WorkerManager.detachPty` resets its `pty` to `null` before it can be read (measured; record in `docs/narratives/2026-10-12-shared-account-smoke-design-history.md`). A terminal-type worker (a plain login shell, no agent CLI ever invoked) sidesteps that exit entirely. Both worker types resolve identity through the identical `session.createdBy -> resolveSpawnUsername -> spawnPty` chain, so reading through a terminal worker never touches the binding/elevation logic under test (Q13 recorded proxy). Also does not read the spawned PTY's own pid as the account's pid: `sudo`'s PTY/PAM-session handling can fork a monitor process that stays at the invoking identity while a child performs the actual setuid+exec, so `pty.pid` is not reliably the account-owned process -- instead it descends each PTY's first-child chain to its deepest live descendant and compares that descendant's OS-level owning username via unprivileged `stat -c %U /proc/<pid>`.

**Authentication bypass**, used to drive the real `/api` router without a real PAM login: `ctx.userMode.authenticate` is monkey-patched to a fixed synthetic caller (not account A, not account B), so the "existing session still operable after rebind" assertion cannot pass by coincidentally matching the caller's own identity. `ctx.userMode.spawnPty` (the real elevation path `WorkerManager` calls to spawn the PTYs under test) is left untouched.

**`createTestContext()` must be given an explicit `MultiUserMode` via `overrides.userMode`, or every PTY in this smoke silently runs unelevated.** `app-context.ts`'s `createTestContext` defaults to `SingleUserMode` (every PTY spawns as the server process's own OS user) unless `overrides.userMode` supplies a `MultiUserMode` instance; `process.env.AUTH_MODE = 'multi-user'` is read by other code this smoke depends on (`createDisposableMultiUserHome`'s `2775` contract) but NOT by this specific decision. The smoke constructs `MultiUserMode.create(bunPtyProvider, <userRepository>)` itself and injects it; the `userRepository` argument is a Q13 recorded proxy (pre-pr-completeness.md) -- a throwaway, unshared, in-memory database, substituted because `MultiUserMode.create` only reads it inside `.login()` (never called here, since auth is bypassed), never inside `spawnSudoPty`'s argv construction or the elevated `sudo` invocation itself, both of which use the real, shared `bunPtyProvider`.

**Free, no LLM turn.** No `claude` CLI login or provider key is needed -- this smoke checks PTY spawn IDENTITY only, through a worker that never invokes an agent CLI.

**No shipped polarity flag:** the old global-account behavior is not constructible from the current tree (`SharedAccountRegistry.create` / `getDefaultUserId` are deleted), so proving it was a one-time cross-tree measurement recorded in the #1842 PR body (`docs/narratives/2026-10-12-shared-account-smoke-design-history.md`).

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 2 (the verification container's `--smokes` run).

**The reach of the "PTY owner is not the server process's own user" assertion was measured on 2026-10-08** by an unelevated-spawn mutation in the tier-2 container (it fires with `got <server user>`); the smoke's header comment carries the full record.

**`driver has already been destroyed` during teardown is a regression only after a completed queue drain**: `jobQueue.stop()` drains in-flight jobs since Issue [#1845](https://github.com/ms2sato/agent-console/issues/1845) (10/10 tier-2 runs green after the fix). If the log contains `JobQueue stop timed out waiting for in-flight jobs`, use its `jobIds` to identify the timed-out handler first. Add no sleep or explicit drain to this smoke.

## Additional Verification: Restore-Failure Declaration (R6) Smoke

PRs touching the R1 catch-block routing or the R6 write in `packages/server/src/services/embedded-agent-worker-service.ts` (the `preserved !== null` / fallback branch, or `writesDivergenceDeclaration`), `WorkerOutputFileManager.appendRestoreFailureMarker` / `resetWorkerOutput`'s `persistentMarkerLine` option in `packages/server/src/lib/worker-output-file.ts`, or the `restore-failure-declaration` / `restore-failure-boundary` members of `EmbeddedAgentServerEvent`, must run `bun scripts/smoke/check-restore-failure-declaration.ts` locally before pushing. This is the shipping-path smoke for R6 (#1447 stage 4, Issue [#1492](https://github.com/ms2sato/agent-console/issues/1492)): it boots a disposable server instance with a real `AppContext`, real DB-backed sessions/workers/definitions, and a real disk-backed `WorkerOutputFileManager`, drives the real `EmbeddedAgentWorkerService.activate` / `.deactivate` / `.sendUserMessage` through a forced restore-failure fallback, and asserts the persistent `restore-failure-declaration` marker is written into the fresh live file and survives a later, real second restore against it.

**FREE AND DETERMINISTIC -- the exception among this file's billable scripts.** No real `claude` CLI and no OS subprocess: `spawnAsUserFn` returns an in-process stub through which the script pushes scripted NDJSON lines (including a real `sdk-session-id` line, so `worker.sdkSessionId` is set by the production event handler). It is registered here like its billable siblings and CI-run since #1871 via `scripts/smoke/__tests__/check-restore-failure-declaration.run.test.ts` (both modes, under `test:scripts`, about two seconds per mode), so the manual-gate wording does not apply to it. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

**The fault-injection mechanism is a chmod asymmetry, not a mock.** `appendRestoreFailureMarker` (R1's primary path) does `fs.appendFile` on the EXISTING live file, which needs write permission on the file itself; `resetWorkerOutput`'s fallback does `fs.rename` (needs write permission on the containing directory, not the file) followed by `fs.writeFile` creating a brand-new file at that path once the old one has been moved out (again directory-permission, unaffected by the old file's mode). Chmod'ing the live file to `0o444` before the second activation therefore fails ONLY the primary path's append, deterministically driving the fallback branch without touching any production code. The script observes (not assumes) that the fallback actually ran, via `getRestoreInfo(...).preservation !== 'in-band'`.

**It carries three cases in one run, and the two negative controls are the point.** Case 1 (positive: `claude-sdk` with a surviving `sdkSessionId`) writes the marker; Case 2 (`openai-api`, same forced-fallback sequence) and Case 3 (`claude-sdk` with `sdkSessionId` still `null`) write nothing -- without those controls, "the marker got written" cannot be distinguished from "the fallback always writes something".

**It has a polarity mode.** `bun scripts/smoke/check-restore-failure-declaration.ts -- --expect-no-declaration` wraps `workerOutputFileManager.resetWorkerOutput` to strip `persistentMarkerLine` from every call before delegating to the real implementation -- simulating "the R6 fix is absent" at the exact call site the fix uses, without touching source -- and asserts the fresh file is EMPTY. A run that finds the marker anyway under this flag is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".

**This file's "the conversation must use a tool" rule (above) does not apply to this script**, and its header comment says so explicitly: the established conversation in Case 1 never survives the forced reset that is the scenario under test, so no activation here ever reconstructs it, and there is no tool-call ordering to protect.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Unprivileged (no tier-2/3/4 residue; any machine with bun) — free and deterministic, no elevation, no billing.

## Additional Verification: Bulk-Restart Exited-Row Smoke

PRs touching `WorkerOutputFileManager.hasEverBeenActivated` / `forceFlush` in `packages/server/src/lib/worker-output-file.ts`, or `EmbeddedAgentWorkerService.deactivate`'s tail (the `forceFlush` after `exitSettled`) in `packages/server/src/services/embedded-agent-worker-service.ts`, must run `bun scripts/smoke/check-bulk-restart-exited-row.ts` locally before pushing. It drives the real `SessionManager.restartAllAgentWorkers({ kind: 'all' })` over two embedded workers in a real `AppContext` with the real disk-backed `WorkerOutputFileManager` and a stub spawn, and asserts each worker's output history contains the `exited` row its previous incarnation's exit observer appended. The defect it guards: a worker whose whole first life fits inside one flush interval has nothing on disk, `hasEverBeenActivated` (disk-only) read that as "never activated", and the first-activation reset discarded the buffered rows -- including `exited`.

**FREE AND DETERMINISTIC.** No `claude` CLI, no OS subprocess, no billing. The default mode sets `WORKER_OUTPUT_FLUSH_INTERVAL` to 60 s so the first life's output is guaranteed pending at the restart; `--realistic` keeps the default interval and times B's first incarnation (it reports `ready` only at its shutdown) so its whole life falls inside one interval, as the billed run did. `--engine` and `--ready-delay-ms` / `--exit-delay-ms` vary the shape; `--help` is free.

**It has a polarity mode.** `--expect-lost` (also with `--realistic`) asserts the defect reproduces and reports a polarity failure when the row is present. Either fix alone keeps the rows (the predicate keeps them in the reader's view, the flush puts them on disk), so run it against a scratch revert of BOTH.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Unprivileged (no tier-2/3/4 residue; any machine with bun) -- free and deterministic, no elevation, no billing.

## Restore E2E and smoke: the conversation must use a tool

**A conversation used to verify restore in an E2E or smoke must include at least one tool-using turn.** A text-only exchange cannot produce the event order a tool-using turn writes, and that order is where restore has actually broken.

The two engines disagree about it. `openai-api` emits an iteration's (possibly empty) `assistant-message` and then its `tool-call`s; `claude-sdk` emits a `tool-call` as soon as it observes one, flushing the assistant message afterwards, because an iteration opening with a tool use has no accumulated text to flush yet. The restore reader was written against the first shape and rejected the second, so **every `claude-sdk` turn that began with a tool call failed reconstruction and fell to the destructive reset**.

In practice this costs a file and a sentence: write a nonce into the session's working directory and have the planting turn read it with `Read`, instead of putting the nonce in the message text. `scripts/smoke/check-embedded-agent-idle-eviction.ts` and `scripts/smoke/check-fatal-incarnation-replacement.ts` both do this, and are the worked examples.

### The recall assertion needs a negative control in the same run

**An assertion whose oracle is a model's generated text — a recall check, or anything read out of produced prose — must be accompanied, in the same run, by a control that fails when the fact under test is false.**

This is the reach measurement for a non-deterministic oracle, and it stands in the same place as mutation measurement for a deterministic pin. `workflow.md`'s standing rule is that a check's detection power is measured rather than assumed; what changes is the lever, and it changes with what the check reads:

| What the check reads | How its reach is measured |
|---|---|
| A deterministic system | **Mutate the code** — ordinary mutation measurement |
| A fixture's premise | **Assert the shape is present** — the tool-turn rule above (general rule: `workflow.md`, "A verification's input must contain the real shape") |
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

(Lesson, recorded in `docs/narratives/2026-10-12-restore-e2e-tool-turn-and-recall-control.md`: a green recall run was a fact about one sampling of a non-deterministic answer, not about the assertion.)

## Additional Verification: Image Attachment Vision E2E

PRs touching `packages/embedded-agent/src/attachment-content.ts`, `composeEmbeddedAgentDeliveryText` and its caller in `SessionManager.sendMessage` (`packages/server/src/services/session-manager.ts`), the `EMBEDDED_AGENT_IMAGE_MIME_TYPES` / `MAX_IMAGE_ATTACHMENT_BYTES` constants in `packages/shared/src/constants/messages.ts`, the `attachments` field on `EmbeddedAgentCommand` / the persisted `user-message` server event (`packages/shared/src/{types,schemas}/embedded-agent.ts`), or the `provider.supportsImages` capability gate anywhere it is read (`agent-loop.ts`'s `supportsImages` dep, `main.ts`'s init wiring, `embedded-agent-worker-service.ts`'s pass-through, `session-manager.ts`'s delivery-text resolution), must run `bun scripts/smoke/check-embedded-agent-image-attachments.ts` locally before pushing. This is the shipping-path E2E for Issue [#1571](https://github.com/ms2sato/agent-console/issues/1571): it boots a disposable server instance with a real `AppContext` and a real `/api` + `/mcp` on a real port, then drives a real headless-Chromium screenshot of a nonce word through the REAL `POST /api/sessions/:sessionId/messages` multipart upload route -- the same endpoint the browser composer calls, not a shortcut through `sessionManager.sendMessage` -- against three real embedded-agent workers: an `openai-api` worker with `provider.supportsImages: true` (SUBJECT), an `openai-api` worker with `provider.supportsImages: false` (negative control for the capability gate), and the `claude-sdk-builtin` worker (unconditional, no gate).

**A real screenshot, not a hand-built PNG:** a synthetic PNG would exercise the base64 / content-part plumbing but never the vision model reading text out of pixels.

**The negative control IS the polarity check here** (no `--expect-*` flag): the capability gate has a naturally occurring negative case, so the SUBJECT/CONTROL pair is a capability-gate control (does `supportsImages: false` suppress image parts?), not a selectivity-over-time control. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

**The CONTROL arm also asserts zero `tool-call` events in the turn (Issue [#1630](https://github.com/ms2sato/agent-console/issues/1630)), snapshotted after the turn's `idle`** per this file's "Restore E2E and smoke" absence-assertion rule. The pre-fix behaviour and its measurement are in `docs/narratives/2026-10-12-image-attachment-control-tool-calls.md`.

**Operational gotcha:** snap Chromium cannot write under dot-directories in `$HOME`; the script stages in a plain directory and copies (the capture directory is not auto-pruned; details: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`).

Re-running:

- **Billable (provider key + `claude` CLI):** a handful of small real turns across three workers per run.
- **Headless Chromium is required** at `CHROMIUM_BIN` (default `/snap/bin/chromium`, overridable).

Each case additionally asserts the persisted `user-message` server event actually carries `attachments: [{ path, mimeType: 'image/png' }]` for the message that used the image -- a passing recall is not credited to the model unless the attachment demonstrably reached the wire.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Restore-Boundary Usage-Seed Real-Provider E2E

PRs touching `findRestoredUsageSeed` / `reconstructConversation`'s `usageSeed` in `packages/embedded-agent/src/restore.ts`, `AgentLoop`'s `resolveRestoreBoundaryUsage` / `compactAtRestoreBoundaryIfNeeded` in `packages/embedded-agent/src/agent-loop.ts`, or the `restoredUsage` field on the `init` command (`packages/shared/src/{types,schemas}/embedded-agent.ts`, and where `packages/server/src/services/embedded-agent-worker-service.ts` composes it) must run `bun scripts/smoke/check-restore-boundary-usage-seed.ts` locally before pushing. This is the real-provider E2E for the restore-boundary compaction check: it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, creates a real `openai-api` definition with a deliberately conservative declared window, grows a conversation with **real billed turns** until the provider's own reported `prompt_tokens` clears the threshold, then restarts the worker and asserts the activation decided on the persisted **measurement** rather than on `estimateTokensFromChars`.

A unit test cannot substitute: the defect is a disagreement between two numbers and only one is ours, so a fake adapter turns the gap into an input; the unit layer pins the extraction and max rules, and only the real chain shows the gap exists at the assumed size (measurement: `docs/narratives/2026-10-12-usage-seed-estimator-vs-provider-gap.md`).

Re-running:

- **Billable (provider key):** a handful of small turns — cents, not dollars.
- **It has a polarity mode.** `bun scripts/smoke/check-restore-boundary-usage-seed.ts -- --expect-underfire`, run against a tree whose fix is removed (`git checkout origin/main -- packages/` and back), **asserts the defect reproduces** rather than merely tolerating a failure — a run that silently compacts is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".

**What it does not reach:** the Issue's full wedge ends in a provider 400 no `Compact` can escape, which needs a declared window `W < G / (1 - T)` (about 37,500 tokens at the measured defaults); the smallest window in the dev catalogue is 196,608 and that model truncates silently, so it is unreachable. The downstream link (a turn ending in error settles no compaction) is pinned in `packages/embedded-agent/src/__tests__/agent-loop-compaction.test.ts`. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Instruction-Loader Parity E2E, Both Engines

PRs touching `loadInstructions` / `loadRulesLayer` / `parseRuleFrontmatter` / `RULES_LAYER_CAP_BYTES` in `packages/embedded-agent/src/system-prompt.ts`, `main.ts`'s `initializeLoop` (either init arm's instruction-loading call), or `packages/server/src/services/embedded-agents/claude-sdk-builtin.ts`'s `instructions`/lack thereof, must run `bun scripts/smoke/check-instruction-loader-parity-e2e.ts` locally before pushing. This is the shipping-path E2E for Phase A (project-instruction parity on the SDK arm; Issue [#1343](https://github.com/ms2sato/agent-console/issues/1343)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives one real `openai-api` worker and one real `claude-sdk` worker (both real embedded-agent subprocesses, both against the SAME scratch git repo), and asks each a single first-turn question about three pieces of content: a `CLAUDE.md` nonce (the pre-existing chain layer, re-confirmed as a no-regression baseline), an unscoped `.claude/rules/*.md` nonce (R2, new), and a negative-control nonce planted under `.claude/rules-not/*.md` (same file shape, wrong directory name -- must never be honoured on either engine).

**A single first turn, no tool call:** this content is loaded EAGERLY into the system prompt at activation, so there is no recall across a process boundary and no need for the tool-turn discipline or a recall control. The `.claude/rules-not` nonce is a directory-scoping control (does the loader only scan `.claude/rules`?), not a recall-attribution control. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

Re-running:

- **Billable (`claude` CLI + provider key):** two small real turns total.
- **It does not re-verify `settingSources: []`.** That pin is unchanged by Phase A (`sdk-engine.ts` is not touched) and is already covered deterministically by `sdk-engine.test.ts`'s unit-level `expect(options.settingSources).toEqual([])`, which runs in the ordinary test suite -- intercepting the same fact from a live billed SDK session here would be strictly less reliable, not more, for a file this class of PR does not modify.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Memory Layer Cross-Session Recall E2E, both engines

PRs touching the memory layer's READ half (`loadMemoryLayer` in `packages/embedded-agent/src/system-prompt.ts`), its WRITE half (`BuiltinToolContext.memoryRoot` in `packages/embedded-agent/src/tools/types.ts` and its three forwarders `read.ts` / `write.ts` / `edit.ts`), the memory path writer (`SessionDataPathResolver.getMemoryDir` in `packages/server/src/lib/session-data-path-resolver.ts`), the activation-time directory creation + verification (`packages/server/src/lib/memory-dir.ts`, or `EmbeddedAgentWorkerService`'s `ensureMemoryDirFn` dep in `packages/server/src/services/embedded-agent-worker-service.ts`), or the definition-deletion job (`CLEANUP_DEFINITION_MEMORY` in `packages/server/src/jobs/handlers.ts` and `buildDefinitionMemoryCleanupTargets` in `packages/server/src/lib/session-data-path.ts`) must run `bun scripts/smoke/check-embedded-agent-memory-layer.ts` locally before pushing. This is the shipping-path E2E for the memory layer (epic [#1636](https://github.com/ms2sato/agent-console/issues/1636) Phase 2; spec `docs/design/embedded-agent-worker.md` "Verification plan for PR-3"): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, registers two real disposable git repositories (one with a fake `origin` remote, so both slug shapes the Session Data Path design produces are exercised), and per engine drives four real embedded-agent workers in four real worktree sessions -- A plants, B recalls, C and D are the controls.

**Recall after a restart is the wrong instrument:** a restarted worker remembers from its own transcript, so a same-worker recall passes with the layer removed. The layer exists for continuity across SESSIONS: B is a fresh worker in a fresh session on the same (definition, repository) key. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.) Step 1 (A, S1, D1) reads a nonce file in `cwd` with a tool (the tool-turn rule above) and is told to record it in memory; the script then asserts DETERMINISTICALLY on disk, before any recall, that a topic file under the server-owned `memoryDir` contains the nonce, that a `MEMORY.md` line's link target is that file, and that the nonce is absent from `MEMORY.md` itself -- so a later recall cannot be satisfied by the index alone. The cwd nonce file is then deleted (the second route closed) and every recall turn is pinned to have emitted no `tool-call` against it. Step 3 (B, S2, same repository, D1): the answer must contain the nonce AND B's turn must contain a `tool-call` whose path is under `memoryDir` -- the on-demand topic read asserted as a SHAPE from B's persisted NDJSON, scoped to B's turn by baseline index, never inferred from the answer text; absence assertions are snapshotted after B's `idle`. Steps 4-5: C (S3, same repository, a different definition D2) and D (S4, D1, a different repository) are asked the identical question and must answer `UNKNOWN`. The key has two halves; C and D each falsify one, so a pass cannot be explained by a guessable question or by a memory that is secretly global. Both controls are REQUIRED -- a run missing either is exit 2, not a pass. Every positive arm also pins the served `init` frame's `context.memoryDir` against the resolver's path.

**It has a polarity mode.** `bun scripts/smoke/check-embedded-agent-memory-layer.ts -- --expect-no-memory` passes `async () => undefined` as `createTestContext`'s `ensureMemoryDirFn` override (the layer's single seam, `EmbeddedAgentWorkerServiceDeps.ensureMemoryDirFn`; source untouched, no runtime reassignment of any private field), so `init` carries no `memoryDir` and the loader renders no layer at any call site. It runs the plant and B's recall only (no positive claim, so no controls) and asserts the absence on the wire (every captured `init` frame lacks `memoryDir`), on disk (no `<base>/memory` directory exists after B settles), and in the answer (B says `UNKNOWN`). A recall under the flag is reported as a polarity FAILURE, never tolerated -- run it FIRST, before the positive arms, to confirm the apparatus reaches the defect, per `workflow.md`'s "A check's existence is not its detection power".

**Q13 proxies (four, all upstream of and outside the chain under test, nothing else substituted):** see the script header; the list is in the rationale narrative (`docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`). **The disposable home is single-user** (`AUTH_MODE` unset, so the `0700` contract): the multi-user `2775` contract is NOT exercised here -- it is verified at tier 3 by the elevation smoke and by the real-fs test in `memory-dir.test.ts`, which now runs for real in CI's second `bun test` invocation (`packages/server/package.json`, Issue [#1699](https://github.com/ms2sato/agent-console/issues/1699)), and this smoke must NOT be switched to multi-user without `createDisposableMultiUserHome` (Issue [#1713](https://github.com/ms2sato/agent-console/issues/1713)).

Re-running:

- **Billable (`claude` CLI + provider key):** roughly four small turns per engine (plant, recall, two controls) plus two per engine for the polarity run.
- **`--engine openai-api|claude-sdk|both` selects the arm** (default `both`); a single-engine run needs only that engine's credential.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Project MCP Server Permission Shipping-Path E2E

PRs touching `set_mcp_server_permission` in `packages/server/src/mcp/mcp-server.ts`, `resolvePermissionDecisions` / `listAllowedProjectMcpServerPairs` in `packages/server/src/lib/mcp-server-permissions.ts`, `SessionManager.setMcpServerPermissions`, `EmbeddedAgentWorkerService.applyMcpServerPermissions`, `SdkEngine.setMcpServers` / `classifyMcpServerScope`, or `packages/embedded-agent/src/mcp-discovery.ts`, must run `bun scripts/smoke/check-embedded-agent-project-mcp-permission.ts` locally before pushing. This is the shipping-path E2E for the `set_mcp_server_permission` MCP tool (epic [#1636](https://github.com/ms2sato/agent-console/issues/1636) Phase 5 PR-3a, Issue [#1795](https://github.com/ms2sato/agent-console/issues/1795)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives one real `claude-sdk` embedded-agent worktree worker against a real `.mcp.json` declaring two real stdio fixture MCP servers, and decides for it through the real tool using a bearer token minted for a real, non-embedded (TUI-Orchestrator-shaped) caller.

**Polarity FIRST, always.** `bun scripts/smoke/check-embedded-agent-project-mcp-permission.ts -- --expect-no-permission` activates the target worker and sends one turn with NO permission ever recorded, asserting neither fixture's spawn canary appears, both are discovered `pending`, and no tool-call names either server -- proving "nothing starts without a record" before any positive arm is billed. Omitting the flag continues from the SAME activation into the positive arms: (1) a live add (`Query.setMcpServers`) of one fixture through the tool, confirmed by its canary and a turn that actually calls its tool; (2) a restart proving the OTHER, durable half -- the allowed fixture starts from the persisted record with no live-add needed; (3) editing the still-pending fixture's `.mcp.json` entry (a hash change) and allowing it by the NEW hash, proving hash-change resilience on the live-add path; and negative controls in the same run -- a deny's durable effect across a restart, an EMBEDDED caller's refusal with nothing persisted, and an isolated `CLAUDE_CONFIG_DIR` proving the operator's own `~/.claude.json` is never read (no `user`/`local`-scope row ever appears, `userLocalNamesUnavailable` is never set).

**Arm 4 (Issue #1786) extends the same script to the quick-session, path-keyed permission table.** After the arms/controls above, the script creates three additional quick sessions, each with its own `claude-sdk` worker: Dir A (the arm's subject) is allowed through the real tool, live-added, confirmed by a real tool-call, and its allow SURVIVES a restart -- the identical allow/live-add/restart-persistence shape as arms 1/2, but against `mcp_server_path_permissions` (migration v45, keyed by realpath'd `location_path` via `resolveMcpPermissionScope`) instead of the repository-keyed table. Two controls run in the same session: (arm4-a) Dir B, a second quick session at a DIFFERENT path with a byte-identical `.mcp.json` declaration for the same server (same command, same args, including the same `--canary` path, so its discovered hash is asserted equal to Dir A's rather than merely assumed) stays `pending` -- proving the permission key includes `location_path` and is not satisfiable by `(serverName, hash)` alone, which a hash mismatch would otherwise make this control pass vacuously; (arm4-b) Dir C, a quick session whose `locationPath` is a SYMLINK to Dir A, discovers the server as ALREADY allowed and live-adds it from the inherited record -- proving the scope key is realpath'd, not the literal `locationPath` string.

Re-running:

- **Billable (`claude` CLI):** about 10-11 real turns per full run (5-6 for arms 1-3 + control (a), plus 5 for arm 4 and its two controls).
- **Classifier unit test**: `scripts/smoke/__tests__/check-embedded-agent-project-mcp-permission.test.ts` covers its pure argument-parsing and event-classifier functions only, and never runs the billed measurement; `registry-reachability.test.ts` and `import-safety.test.ts` enforce the rest.
- **The run's worker NDJSON is captured before the disposable home is deleted**, same convention as `check-fatal-incarnation-replacement.ts`'s capture step: the script's `finally` block copies every `**/outputs/**/*` file out of the disposable `AGENT_CONSOLE_HOME` to `$HOME/.agent-console-smoke-captures/check-embedded-agent-project-mcp-permission/<disposable-home-basename>/` — printed to stdout as `worker NDJSON captured to: ...` when anything was captured — strictly before `rm -rf` removes that home. Not auto-pruned; the operator who runs the smoke is responsible for removing capture directories they no longer need. Origin (Issue #1795): `docs/narratives/2026-10-12-project-mcp-permission-ndjson-capture.md`.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

## Additional Verification: Per-User claude.ai Connectors Toggle Shipping-Path E2E

PRs touching `SdkEngineDeps.disableClaudeAiConnectors` / the `disableClaudeAiConnectors` settings composition in `packages/embedded-agent/src/sdk-engine.ts`, the `init.disableClaudeAiConnectors` threading in `packages/embedded-agent/src/main.ts`, `EmbeddedAgentWorkerServiceDeps.resolveDisableClaudeAiConnectors` / its composition in `packages/server/src/services/embedded-agent-worker-service.ts`, `resolveDisableClaudeAiConnectors` in `packages/server/src/services/resolve-disable-claude-ai-connectors.ts`, `UserRepository.getPreferences` / `.setPreferences` (either implementation), or the `GET /api/auth/me` / `PATCH /api/auth/me/preferences` routes in `packages/server/src/routes/auth.ts`, must run `bun scripts/smoke/check-claude-sdk-connectors-toggle.ts` locally before pushing. This is the shipping-path E2E for the per-user claude.ai connectors toggle (Issue #1836): it boots a disposable server instance with a real `AppContext` and a real `/api` on a real port, drives two real `claude-sdk` embedded-agent workers for the SAME user through real activations, and toggles the preference through a real `PATCH /api/auth/me/preferences` HTTP request against the real running server -- never a direct repository call.

**The mechanism has no runtime setter:** `disableClaudeAiConnectors` is read once at `SdkEngine` construction, so a preference change takes effect at a worker's NEXT activation. Worker A (activated BEFORE the PATCH) is the baseline; a fresh worker B (activated AFTER, same user) proves the new preference took effect -- reactivating A would not distinguish "the fix works" from "the SDK never re-reads settings". The observable is each worker's persisted `mcp-servers-discovered` event(s), never the model's prose. (Rationale: `docs/narratives/2026-10-12-embedded-smoke-design-rationale.md`.)

**The positive control is a gate, not a formality.** If the invoking OS user's Claude Code account has no claude.ai connectors configured, worker A observes zero `scope: 'connector'` rows and the run reports INCONCLUSIVE (exit 1) rather than a false "pass" -- there would be nothing for the toggle to suppress, and every downstream assertion would be meaningless.

**`--expect-connectors-present` is a BREAK-THE-FIX POLARITY FLAG**, same convention as this file's `--expect-not-evictable` / `--expect-underfire` siblings: it drives the SAME real PATCH the default run uses (toggle set to `true`), then activates a fresh worker B and asserts its discovered event(s) DO contain a `scope: 'connector'` row -- the PRE-FIX bug shape. On this, correctly-fixed tree, that assertion is EXPECTED TO FAIL (the toggle correctly suppresses the connector), and that failure is the documented, correct outcome -- it confirms the apparatus reaches the defect, per `workflow.md`'s "a check's existence is not its detection power". Run this flag against a REVERTED tree (the composition step removed from `embedded-agent-worker-service.ts`, or the field dropped from `sdk-engine.ts`'s `settings` object) to see it PASS. This flag has no INCONCLUSIVE gate of its own; a PASS under it (a genuinely reverted tree) is only meaningful once the same host's default run has cleared its INCONCLUSIVE gate.

Re-running:

- **Billable (`claude` CLI):** two real turns per default run (one per worker), one real turn for the `--expect-connectors-present` polarity run.
- **Wiring unit test**: `scripts/smoke/__tests__/check-claude-sdk-connectors-toggle.test.ts` covers the `--expect-connectors-present` argument-parsing function only, and never runs the billed measurement; `registry-reachability.test.ts` and `import-safety.test.ts` enforce the rest.

**Verification tier (Discipline 4 of `os-environment-coupling.md`):** Tier 4 (billable; dogfood host only -- permanent residue).

