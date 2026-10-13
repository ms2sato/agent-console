# Repository Transactions: multi-write paths that cannot share a database transaction

Investigation note for Issue [#1844](https://github.com/ms2sato/agent-console/issues/1844). Design only: no code, no schema, no test. Every claim below was read at `origin/main` **`7082ec5d`** (2026-10-13) and is cited as `file:line` at that SHA. Three claims were also measured against the installed library (Kysely 0.28.9 with `kysely-bun-sqlite` 0.4.0, the same stack `database/connection.ts` builds); each says so and names the throwaway probe.

## Context

Server repositories take no part in a transaction that spans more than one of them. Every `Sqlite*Repository` is constructed once in `packages/server/src/app-context.ts` with the shared `Kysely<Database>` handle and writes through it in every method; Kysely routes a transaction's statements through the `trx` handed to `db.transaction().execute(async (trx) => ...)`, and there is no way to hand that `trx` to a repository method. A caller that opens a transaction and then calls repository methods writes outside it.

**Premise correction.** Issue #1844 says `db.transaction()` is used only inside migrations. That is no longer true. Three call sites open transactions on an application write path, all INSIDE one repository:

```
packages/server/src/repositories/sqlite-session-repository.ts:63   save     -> db.transaction().execute(trx => upsertSessionInTrx(trx, ...))
packages/server/src/repositories/sqlite-session-repository.ts:71   saveAll  -> db.transaction().execute(trx => for each session upsertSessionInTrx(trx, ...))
packages/server/src/repositories/sqlite-message-template-repository.ts:90   reorder  -> db.transaction().execute(trx => ...)
```

Single-repository atomicity therefore exists (a session and its workers are saved together; a template reorder is all-or-nothing). Cross-repository atomicity does not. That is the gap this note inventories.

Scope notes that shape everything below:

- **The write targets are not only the "repositories".** Thirteen `sqlite-*-repository.ts` classes exist; twelve are constructed in `app-context.ts` (twenty-four `new Sqlite*Repository(db)` lines, once in each of the two context builders: L362-L406 and L866-L996) and `SqliteWorktreeRepository` is built inside `WorktreeService` (`services/worktree-service.ts:253`). Three more DB writers sit outside that tree and matter to this study: `JobQueue` (`jobs/job-queue.ts:199`, `enqueue` is a bare `insertInto('jobs')` on the same `db`), `InboundEventNotificationRepository` (`repositories/inbound-event-notification-repository.ts:26`), and `RepositorySlackIntegrationService` (`services/notifications/repository-slack-integration-service.ts:37`).
- **The most damaging partial states pair a row write with a job enqueue**, not two repository writes. Cleanup jobs delete files on disk; they are the one place where a half-finished sequence destroys data rather than merely leaving a stray row.
- **Not every multi-step path is a database-transaction problem.** A path that interleaves a DB write with `git`, a PTY write, or an `fs` operation cannot be made atomic by a transaction, because the external step cannot roll back and (measured below) holding a transaction open across a slow `await` blocks every other database access in the process.

## Method and controls

The seed is the Architect's grep for repository write calls under the four service-layer directories, which yields fifteen non-test files:

```
$ cd packages/server/src && grep -rlE 'Repository\.(create|update|delete|upsert|register|insert|save|remove|set|mark|record|append|add)' services routes jobs mcp | grep -v __tests__ | sort | wc -l
15
mcp/mcp-server.ts  routes/artifacts.ts  routes/auth.ts  routes/bookmarks.ts  routes/message-templates.ts
routes/shared-accounts.ts  services/inbound/job-handler.ts  services/repository-manager.ts
services/session-deletion-service.ts  services/session-initialization-service.ts  services/session-manager.ts
services/session-metadata-service.ts  services/session-pause-resume-service.ts  services/user-mode.ts
services/worktree-service.ts
```

**A second control bounds the row-plus-job class, which the seed grep cannot see** (it matches `Repository` receivers, not `jobQueue`):

```
$ cd packages/server/src && grep -rn "jobQueue.enqueue(\|jobQueue?.enqueue(" --include=*.ts . | grep -v __tests__ | wc -l
8
```

Exactly eight non-test enqueue sites exist at `7082ec5d`. Six are inventory rows: `repository-manager.ts:900` (#1), `session-deletion-service.ts:152` (#2) and `:244` (#3), `worker-lifecycle-manager.ts:1989` (#4), `session-initialization-service.ts:406` (#5), `embedded-agent-manager.ts:414` (#11). Two are single-write: `routes/webhooks.ts:52` (the event enqueue is that handler's only database write) and `routes/worktrees.ts:443` (the `WORKTREE_DELETE` enqueue, with no row write around it). Every enqueue site is therefore classified.

**The grep is a seed, not the population.** It only matches receivers whose name ends in `Repository`, so it cannot see a write made through `jobQueue.enqueue`, through a manager that wraps a repository, or through a helper. Every function in the fifteen files that has at least one write was read in full; the multi-write paths those functions reach through called services were then followed by reading. Rows reached that way are marked **found by reading**. Writes were counted in the vocabulary of the grep plus `enqueue` and any `db.` statement. A read followed by a write on one repository (`findById` then `save`) is not counted as a multi-write.

## Inventory

Legend for the last columns: **MA** = must-be-atomic; **BP** = benign-if-partial; **SO** = safe-otherwise (the mechanism is named in the justification).

### Multi-write paths

| # | Path (`file:function (line)`) | Writes, in order | Class | Justification |
|---|---|---|---|---|
| 1 | `services/repository-manager.ts:unregisterRepository (466)` | `jobQueue.enqueue(CLEANUP_REPOSITORY)` (payload from `buildCleanupRepositoryPayload`, L895; enqueue L501) -> `repository.delete(id, trx)` (L502), both inside one `db.transaction()` | **atomic (one transaction) since PR #2074** (was **MA**) | The job removes the repository directory tree, worktrees and session data; the row delete follows it. Before the change, a failure between left a registered repository whose data was being or had been deleted (see F1); now the enqueue and the delete commit together and the queue is woken after the commit. |
| 2 | `services/session-deletion-service.ts:deleteSession (89)` | `jobQueue.enqueue(CLEANUP_SESSION_OUTPUTS)` (L152) -> `sessionRepository.delete(id)` (L202) | **MA**, atomic since [#2075](https://github.com/ms2sato/agent-console/pull/2075) | Same shape: file-deleting job first, row delete second. A failure between leaves a session row whose output files are being deleted. See F2. |
| 3 | `services/session-deletion-service.ts:forceDeleteSession (224)` | `jobQueue.enqueue(CLEANUP_SESSION_OUTPUTS)` (L244) -> `sessionRepository.delete(id)` (L261) | **MA**, atomic since [#2075](https://github.com/ms2sato/agent-console/pull/2075) | The orphaned-session variant of #2, same order, same leftover. |
| 4 | `services/worker-lifecycle-manager.ts:deleteWorker (528)` -- **found by reading** | `jobQueue.enqueue(CLEANUP_WORKER_OUTPUT)` (via `cleanupWorkerOutput`, L1978, called L540/L556) -> `persistSession` (L576) -> `sessionRepository.save` (`session-manager.ts:1917`) | **MA**, atomic since [#2075](https://github.com/ms2sato/agent-console/pull/2075) | The cleanup job is enqueued before the session row without the worker is saved. A failure between leaves a worker row whose output is being deleted. See F3. |
| 5 | `services/session-initialization-service.ts:cleanupOrphanProcesses (353)` | `sessionRepository.delete(orphan.id)` (L402) -> `jobQueue.enqueue(CLEANUP_SESSION_OUTPUTS)` (L406) | **BP**, aligned since [#2075](https://github.com/ms2sato/agent-console/pull/2075) | Boot-time removal of sessions owned by a dead server that this server did not inherit (L353-L380). As inventoried it ran in the OPPOSITE order to #2/#3: a failure between left orphaned output files, a disk leak with no live reader. It now uses the same enqueue-plus-delete transaction as #2/#3, so the row-plus-job pair has one order and one atomicity (the remaining orders are row first in #11, and files first in #6). See F2. |
| 6 | `services/session-initialization-service.ts:initializeSessions (230)` | `workerOutputFileManager.deleteSessionOutputs` (fs, L316) -> `sessionRepository.delete(orphan.id)` (L325); then `sessionRepository.saveAll(sessionsToSave)` (L334) | **SO** | Removal of sessions whose `locationPath` no longer exists here deletes files first, row second, each in its own try/catch that logs and continues; an orphan whose delete fails is re-detected and retried at the next boot (the detector is path-existence based, so it is idempotent). `saveAll` is the in-repository transaction. |
| 7 | `services/session-initialization-service.ts:detectOrphans (124)` | `sessionRepository.update(id, { recoveryState: 'orphaned', ... })` (L149), once per session in a loop | **SO** | Independent single-row writes; a failure on one is logged and the loop continues (the `continue` after the error log), and the same detector re-marks it next boot. No cross-row invariant. |
| 8 | `routes/shared-accounts.ts:registerSharedAccountCore (31)` | `userRepository.upsertByOsUid` (L41) -> `sharedAccountRepository.register` (L42) -> in-memory `sharedAccountRegistry.register` | **BP** | The known instance. If the second write fails, the `users` row remains: the same row a login for that OS account would have created, with no `shared_accounts` mark. Harmless, accepted by the owner on 2026-10-07. A retry upserts the same row. |
| 9 | `services/session-manager.ts:setMcpServerPermissions (1159)` | `mcpServerPermissionRepository.upsert` x N in a loop (L1173) -> `persistSession` (L1192) | **SO** | Every write is an idempotent upsert keyed by `(scope, server_name, config_hash)` (`sqlite-mcp-server-permission-repository.ts:93-94`, `:124-125`); a failure part-way leaves fewer decisions than requested and surfaces as an error, so the caller retries the whole batch. An undecided server is not allowed, so a partial batch fails closed. The `persistSession` write refreshes a display copy of the decisions on the session row, not the source of truth. |
| 10 | `services/inbound/job-handler.ts` (notification block, L221-L330) | `notificationRepository.createPendingNotification` (L221) -> `handler.handle` (a PTY or worker delivery) -> `markNotificationDelivered` / `markNotificationFailed` (L247/L272/L323) | **SO** | Deliberately NOT atomic. The `pending` row is a sentinel written BEFORE the external side effect so a crash after delivery cannot re-run the handler (at-most-once); the code comments (L199-L217 and the terminal-write comment at L234-L240) say a `pending` row is left standing rather than guessed to `delivered`. A transaction would defeat it: the delivery cannot be inside one. |
| 11 | `services/embedded-agent-manager.ts:deleteEmbeddedAgent (380)` -- **found by reading** | `repository.delete(id)` (L394) -> `jobQueue.enqueue(CLEANUP_DEFINITION_MEMORY)` (L414) | **BP** | Row first, job second (the documented ordering discipline, L398-L405). A failure between leaves the definition's memory directory on disk with no row to reach it: an unreachable disk leak. |
| 12 | `services/worktree-creation-service.ts:createWorktreeWithSession (101)` -- **found by reading** | `worktreeService.createWorktree` (git worktree add, then `worktreeRepository.save`, `worktree-service.ts:545`) -> `sessionManager.createSession` (`sessions` + `workers`, in-repository transaction) | **SO** | On a failure after the worktree exists, `rollbackWorktree` (L23-L40) removes it (git and the `worktrees` row) -- a compensating step, and the `mcp-server.ts` `delegate_to_worktree` path repeats it (L1384). The crash window leaves a worktree row with no session, which is an ordinary legal state: worktrees exist without sessions (created by hand, or after a session is deleted). |
| 13 | `services/worktree-deletion-service.ts:deleteWorktree (322)` -- **found by reading** | `worktreeService.removeWorktree` (git remove, then `worktreeRepository.deleteByPath`, `worktree-service.ts:868`) -> `sessionManager.deleteSession(sid)` per session (L461) | **SO** | Sessions are deleted AFTER the worktree is gone. A crash between leaves sessions whose `locationPath` no longer exists; the boot-time orphan detector removes exactly those (#5/#6). The existing sweep repairs it. |
| 14 | `services/worktree-deletion-service.ts:cleanupOrphanedWorktree (186)` -- **found by reading** | `removeOrphanedWorktree` (`rm`, then `deleteByPath`, `worktree-service.ts:949`) -> `sessionManager.deleteSession(sid)` per session (L261) | **SO** | Same order and same repair as #13; the removal step is documented idempotent (L240-L242). |
| 15 | `services/session-pause-resume-service.ts:resumeSessionInternal (205)` | `sessionRepository.save` (L375); on failure, compensating `sessionRepository.update` (L358, L394) | **SO** | One write per outcome on one repository; the `update` is a compensating write on the failure branch, itself wrapped in a try/catch that logs (L394-L402). `pauseSession` (L110) is a single `save` (L158). |

### Already atomic, single repository

| Path | Mechanism |
|---|---|
| `sqlite-session-repository.ts:save (63)` and `saveAll (71)` | one `db.transaction()` over the session row and its worker rows |
| `sqlite-message-template-repository.ts:reorder (90)` | one `db.transaction()` over the reorder |
| `sqlite-repository-repository.ts:addOrchestratorSession (171)` | one `INSERT ... ON CONFLICT DO NOTHING`, then a `findById` read (not a second write) |

### Paths that are not multi-write (listed for completeness of the fifteen files)

One write each, or a read-then-write on one repository: `routes/artifacts.ts` (L164), `routes/auth.ts` (L134), `routes/bookmarks.ts` (L49, L84), `routes/message-templates.ts` (L29, L49, L59), `routes/shared-accounts.ts` `DELETE /:username` (L147: counts, then `unregister`, then an in-memory registry update; the bound-repository FK is `ON DELETE RESTRICT`, so the count is a friendly pre-check, not the guard), `services/user-mode.ts` (L242, L373: a single `upsertByOsUid`), `services/session-metadata-service.ts` (L138, L158: `findById` then `save`, a lost-update shape, not a multi-write), `services/repository-manager.ts` `registerRepository (318)` / `updateRepository` / `addOrchestratorSession` / `removeOrchestratorSession` (each a single write), `services/worktree-service.ts` (L545, L868, L967: one DB write amid git/`fs` work -- see the scope note), `mcp/mcp-server.ts` artifact and bookmark tools (L2445, L2530, L2609, L2691: one write each).

## Failure analysis

For each must-be-atomic row: the state a failure between write N and N+1 leaves, what observes it, and whether an existing sweep repairs it. All three share the root cause: a `jobs` row is committed and, within milliseconds, picked up (`job-queue.ts:256`, `this.emitter.on('job:added', () => this.tryProcess())`) and executed, independent of whether the second write ever lands.

### F1. `unregisterRepository` (#1): the repository survives its own cleanup

Sequence before the atomic change (at `7082ec5d`; the method was `cleanupRepositoryData` then, now `buildCleanupRepositoryPayload`, and the two writes share one transaction): `cleanupRepositoryData` enqueues `CLEANUP_REPOSITORY` with `repoDir`, `sessionDataDirs` and, when requested, the source clone as `extraDir` (`repository-manager.ts:900`); the in-memory cache entry is deleted (L472); only then `repository.delete(id)` runs (L473).

If the DELETE fails (SQLite busy, I/O error) or the process dies between the enqueue and the DELETE:

- The `repositories` row still exists, so the repository is listed and registered again after a restart (the cache is rebuilt from the table at boot, L306-L310). On a thrown DELETE the cache entry is already gone, so it also diverges from the table until restart.
- The committed job deletes the repository's directory tree: every worktree directory, the session outputs, memos and messages, and (opt-in) the source clone. The user sees a registered repository whose worktrees and history no longer exist on disk.
- What observes it: the next worktree listing (a worktree row with no directory is shown as `(orphaned)`, `worktree-service.ts:353-362`), the next session resume, the next clone-dependent git call. Nothing repairs it: the boot-time sweeps cover sessions with a missing `locationPath` (#5/#6), not repositories whose data directory is gone, and the destructive step has already run.

This is the highest-damage row: data is destroyed while the record that says the data should exist is kept.

### F2. Session deletion (#2, #3; reversed in #5): a live row with its outputs deleted

Sequence: `CLEANUP_SESSION_OUTPUTS` is enqueued (`session-deletion-service.ts:152`, forced path L244), in-memory state is removed, workers are killed, then `sessionRepository.delete(id)` (L202, L261).

If the DELETE fails or the process dies after the enqueue:

- In `deleteSession` the catch restores the in-memory session (L211-L218), but the job is already queued and runs: the worker output files (scrollback) of a session that still exists are deleted.
- After a crash the session row is still there, so it is rehydrated at boot (`initializeSessions`, L230-) as a resumable session; its worker output files are gone. The user resumes a session whose scrollback is gone.
- What observes it: opening the session's worker (an empty history where one was persisted). No sweep repairs it: the boot code reconciles a session's `locationPath` and `serverPid` (`detectOrphans`, `initializeSessions`), and the only output-file operation in `session-initialization-service.ts` is the deletion on the orphan path (`grep -n deleteSessionOutputs` finds L316 only; the other `outputs` hits are the fragmentation report's directory scan, L172-L188).

The mirror image is real and milder: #5 deletes the row first and enqueues second, so a failure leaves orphaned files (a leak, class BP). The codebase contains BOTH orders for the same pair (row + file-deleting job), plus a third (files first, #6). That inconsistency is itself a finding: nobody can state the intended invariant without a transaction to hold it. **Resolved by [#2075](https://github.com/ms2sato/agent-console/pull/2075):** #2, #3, #4 and #5 now write the pair in one transaction (the job enqueue first, the row write second, the wake-up after commit), so the row-plus-job pair has one order in the codebase.

### F3. `deleteWorker` (#4): a listed worker with no output

Sequence: `cleanupWorkerOutput` enqueues `CLEANUP_WORKER_OUTPUT` (`worker-lifecycle-manager.ts:540`/`:556`), inter-session message files are deleted, `session.workers.delete(workerId)`, then `persistSession` (L576), which is the session `save`; `cleanupWorkerOutput` is defined at L1978.

If the persist fails or the process dies after the enqueue: the worker row remains in `workers`, and the committed job deletes its output file. The worker is listed with its history gone. Same observation and same absence of repair as F2, smaller blast radius (one worker, not a session).

### Benign rows

- **#8 `registerSharedAccountCore`:** a `users` row with no `shared_accounts` row. Harmless, as the Issue says: it is exactly what a login by that OS account creates (`upsertByOsUid`, `sqlite-user-repository.ts:13`), and a retry upserts the same row.
- **#5 `cleanupOrphanProcesses`:** orphaned output files for a session whose row is already gone. No reader reaches them; disk only.
- **#11 `deleteEmbeddedAgent`:** a memory directory for a definition whose row is gone. Unreachable through the create/activate path; disk only.

### Why the safe-otherwise rows are safe

#6, #7: idempotent, re-detected next boot. #9: idempotent upserts, partial batch fails closed. #10: at-most-once by design; the external delivery cannot be inside a transaction. #12: compensating rollback, and the crash window is a legal state. #13, #14: the existing orphan detector repairs the crash window. #15: single write per outcome with a logged compensating write.

## Proposal

### What a candidate must satisfy

The failure analysis says what has to be possible: **one transaction that contains a `jobs` insert and a row write (`repositories` delete, `sessions` delete, `sessions` save)**. Two measurements bound the design space. Both were taken against this repository's own stack with a throwaway script over `createDatabaseForTest()` (an in-memory database, same `BunSqliteDialect`):

1. **A `Transaction` is a `Kysely`.** The installed declaration is, verbatim, `node_modules/.bun/kysely@0.28.9/node_modules/kysely/dist/cjs/kysely.d.ts:409: export declare class Transaction<DB> extends Kysely<DB> {`. A repository method that accepts `Kysely<Database>` therefore accepts a `trx` with no change to its body. Option (a) below stands on this one line.
2. **A forgotten `trx` does not write outside the transaction; it deadlocks.** `kysely-bun-sqlite` holds one connection behind a mutex (`kysely-bun-sqlite/dist/index.js:8`, `ConnectionMutex`). In the probe, a statement issued on the outer `db` from inside `db.transaction().execute(async (trx) => ...)` never completed (`forgotten-trx outcome: HUNG`, 3 s guard), while the control that used `trx` committed. The same probe measured the rollback itself: after injecting a throw at write N+1, the rows from write N were gone (`rows after rollback: 0`). Two consequences: the "silent write outside the transaction" trap of option (a) is, on this driver, a loud hang (test-detectable), but a hang inside a production request freezes ALL database access in the process until restart, so it must still be prevented; and **a transaction body must contain database statements only** -- an `await` on git, a PTY or `fs` inside it blocks every other query.

One more measured fact constrains the two existing in-repository transactions: `trx.transaction()` on a `Transaction` throws (`calling the transaction method for a Transaction is not supported`), and `executor.isTransaction` distinguishes the two (`false` on `db`, `true` on `trx`). `SqliteSessionRepository.save` / `saveAll` and `reorder` therefore need `executor.isTransaction ? run(executor) : executor.transaction().execute(run)` when they gain an executor.

### Comparison

Counts are from `grep -rhE '^  async (create|update|delete|upsert|save|saveAll|register|unregister|set|mark|reorder|remove|add|touch|insert|append|record)\w*\(' repositories/sqlite-*.ts | wc -l` = **31** write-named methods across the 13 sqlite repositories (per file: session 4, repository 5, message-template 4, timer 3, and 2 each for artifact, agent, embedded-agent, bookmark, user, shared-account, worktree; mcp-server-permission 1), plus `JobQueue` (`enqueue` at `job-queue.ts:199`, `retryJob`, `cancelJob`) and 4 on `InboundEventNotificationRepository`. The fix-now paths touch **4** of them (below).

| | (a) optional trailing `executor` on write methods | (b) `withRepositories(trx)` factory | (c) unit-of-work object |
|---|---|---|---|
| Shape | `async delete(id, executor: Kysely<Database> = this.db)`; callers inside `db.transaction().execute(trx => ...)` pass `trx` | `db.transaction().execute(trx => { const r = createRepositories(trx); ... })` returns a repository set bound to one executor | a `UnitOfWork` collects writes and commits once |
| Methods touched | only those on a converted path: **4 now** (`repositoryRepository.delete`, `sessionRepository.delete`, `sessionRepository.save` -- which also gains the `isTransaction` branch -- and `JobQueue.enqueue`); the other ~30 stay as they are until a path needs them | all 31 + 3 on `JobQueue` + 4 on the inbound repository must be constructible from an executor: every class gains a factory entry, even if no path uses it | all of them, plus a new coordinating type and its commit protocol |
| Call-site count | converted paths only: 5 call sites for the fix-now groups (`unregisterRepository`, `deleteSession`, `forceDeleteSession`, `deleteWorker`, `cleanupOrphanProcesses`) | the 24 `new Sqlite*Repository(db)` lines in `app-context.ts` become factory calls, then each call site that wants a transaction moves to the bound set | every write call site that joins a unit of work |
| Test impact | zero when omitted (a trailing optional parameter): 29 test files build a real in-memory database (`createDatabaseForTest`); only 2 hand-written fakes implement a repository interface (`InMemoryAgentRepository`, `InMemoryEmbeddedAgentRepository`), neither on a fix-now path | every test that constructs a repository by hand moves to the factory, or keeps a second path | new fakes for the unit-of-work contract |
| A forgotten executor fails by | **hanging** inside the transaction (measured above), not by corrupting; mitigation below | impossible to forget within the bound set; fails if a caller mixes the bound set with an old reference captured outside the transaction | impossible to forget; fails by never committing if the caller forgets `commit` |
| Pay-as-you-go | yes | no, all-or-nothing | no |

### Recommendation: (a), converted per path

**A partial write must not be able to leave the state the failure analysis describes.** Option (a) closes F1-F3 with four touched methods and no reshaping of construction; (b) and (c) buy a protection against forgetting the executor that (a) can buy more cheaply (below), at the price of a wholesale change to every repository and 24 constructions. (c) additionally introduces a concept (a unit of work) the codebase has no other use for.

Rules the implementation Issues must carry:

1. **The executor is a trailing optional parameter defaulting to `this.db`.** Omitting it is today's behaviour byte for byte. `Kysely<Database>` is the parameter type; `Transaction<Database>` satisfies it.
2. **A transaction body contains database statements only.** No git, PTY, `fs` or network `await` inside `db.transaction().execute(...)` -- measured above, it blocks every other query. This is why #10 (`job-handler`) stays out of scope and why F1-F3 are fixable: both of their writes are database statements; the destructive file work happens LATER, in the job handler, after commit.
3. **The mitigation for a forgotten `trx` is the polarity test, not a lint.** Every converted path ships a test that injects a failure at write N+1 and asserts write N was rolled back. With a forgotten `trx` that same test does not fail on an assertion -- it times out, so it fails loudly, which is the signal wanted. A type that distinguishes `Transaction` from `Kysely` at the call site was considered and rejected: `Transaction extends Kysely`, so the distinction would have to be a brand wrapped around every executor, which is (b)/(c)'s cost.
4. **`JobQueue.enqueue` takes the executor too, and the wake-up moves after commit.** `enqueue` ends with `this.emitter.emit('job:added')` (`job-queue.ts:222`). Inside a transaction that emit must not fire before the commit: the explicit design is that `enqueue(..., { executor })` does not emit, and the caller calls a public wake method on the queue after `execute()` resolves. A missed wake only delays the job (rows are durable; `start()` reclaims `processing` rows at L242-L247 and the retry timer emits at L659-L661), it never loses it. (On this driver an early emit would also be harmless, since the queue's own read would wait behind the transaction on the single-connection mutex -- but that is a property of the driver, not a contract to lean on.)
5. **`SqliteSessionRepository.save` / `saveAll` / `reorder` use the `isTransaction` branch** measured above, never a nested `transaction()`.

### Migration path

1. **Done ([#2070](https://github.com/ms2sato/agent-console/pull/2070)).** Add `executor` to `JobQueue.enqueue`, `RepositoryRepository.delete`, `SessionRepository.delete` and `.save` / `.saveAll` (interface, sqlite implementation, and the JSON test double, which ignores it), and the post-commit `wake()`. No caller changes; the existing suites prove omission is a no-op.
2. **Done (PR #2074).** Convert `unregisterRepository` (F1): enqueue + delete in one transaction, then wake; the polarity test throws at the delete and asserts the `jobs` table is unchanged.
3. **Done ([#2075](https://github.com/ms2sato/agent-console/pull/2075)).** Convert `deleteSession`, `forceDeleteSession`, `deleteWorker` (F2, F3), and make `cleanupOrphanProcesses` use the same pair so the codebase has ONE order. `SessionManager` takes an optional `db` and hands it to the three services; each opens the transaction itself (a shared helper would be a fourth file for about eight lines), and without a `db` they fall back to the previous two writes and warn.
4. Optional, only if a path needs it: `deleteEmbeddedAgent` (#11, a disk leak), `registerSharedAccountCore` (#8, benign). Converting them is cheap once step 1 exists, but nothing demands it.

## Recommendation

Fix now, ordered by the damage in the failure analysis:

| Order | Group | Rows | Reason |
|---|---|---|---|
| 1 | Atomic repository unregister | #1 (F1) | destroys data while keeping the record that says it should exist |
| 2 | Atomic session and worker deletion | #2, #3, #4, and aligning #5 (F2, F3) | a live session or worker loses its output; one order for the row-plus-job pair |
| defer | Embedded-agent definition delete | #11 | disk leak only; convert after step 1 if convenient |
| defer | Shared-account registration | #8 | the leftover is the row a login creates |
| no change | #6, #7, #9, #10, #12, #13, #14, #15 | | safe for the stated mechanism; #10 is correct as a deliberately non-atomic protocol |

This study introduces no named concept in any signature, so it adds no `docs/glossary.md` entry. The umbrella Issue below introduces `executor` as a parameter name in repository signatures and carries the glossary obligation (trigger 2 of `.claude/rules/glossary-maintenance.md`) for the PR that ships it.

## Filed Issues

- Umbrella: [#2068](https://github.com/ms2sato/agent-console/issues/2068) -- optional `executor` parameter on repository and job-queue write methods
- Atomic repository unregister (F1): [#2066](https://github.com/ms2sato/agent-console/issues/2066)
- Atomic session and worker deletion (F2, F3): [#2067](https://github.com/ms2sato/agent-console/issues/2067) (landed in PR [#2075](https://github.com/ms2sato/agent-console/pull/2075))
