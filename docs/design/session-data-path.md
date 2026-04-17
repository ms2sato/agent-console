# Session Data Path — Design

## Purpose

Define how filesystem paths for session-scoped data (worker output logs, memos, messages) are determined, persisted, and remain stable across server restarts, repository lifecycle events, and runtime initialization windows.

This document is the specification. `SessionDataPathResolver` and related code must conform to this spec.

## Background: Observed Problem

A single worker's output log file was observed fragmented across three paths after a series of server restarts:

```
~/.agent-console/outputs/<sid>/<wid>.log                              (oldest, 3.2MB)
~/.agent-console/repositories/<repoName>/outputs/<sid>/<wid>.log      (middle, 8.17MB)
~/.agent-console/_quick/outputs/<sid>/<wid>.log                        (newest, active)
```

Symptoms:
- Client requests history at offset X (from memory/cache) but server returns a file of size Y < X → "full history resync" fires every reconnect, returning stale content.
- Truncation, incremental sync, and history-based features operate on whichever path was active at the moment of the call — producing divergent state.

Root cause: `SessionDataPathResolver` derives the base path at every instantiation from a runtime lookup (`repositoryId → repository.name`). If the lookup returns `undefined` at any point (deleted repo, uninitialized callbacks, DB inconsistency), it falls back to `_quick/`. The silent fallback, combined with the lack of a persisted "canonical path", produces fragmentation.

## Design Goals

1. **Path stability.** Once a session is created, the location of its data files is determined and persisted. It does not change across server restarts, repository rename/deletion, initialization races, or `AGENT_CONSOLE_HOME` changes.
2. **No silent fallback.** Ambiguity in path resolution surfaces as an explicit error, never a quiet redirect.
3. **Separation of concerns.** "Quick session" (sessions not tied to a worktree) and "fallback when repo resolution fails" are different concepts. They do not share a directory.
4. **No legacy read path.** Existing fragmented files are treated as ephemeral (owner decision). New code neither reads nor writes them. Sessions whose persisted location cannot be resolved are marked orphaned and excluded from auto-resume, visible in the UI for manual deletion.
5. **Portability.** The persisted location must remain correct if `AGENT_CONSOLE_HOME` changes, the config directory is moved, or the DB is restored from backup into a different filesystem layout.
6. **Boundary safety.** Cleanup operations (triggered asynchronously via jobs) cannot target filesystem locations outside the configured data directories, even if persisted values or job payloads are corrupted.

## Non-Goals

- Data recovery from already-fragmented files.
- Reorganizing the directory tree beyond what is necessary to eliminate the fragmentation root cause.
- Removing the `_quick/` concept — it remains valid for legitimate non-worktree sessions.
- Handling repository rename as an automatic data-move operation. If a repository is renamed at the git/OS level, existing sessions keep their original path (pre-rename). A separate migration tool may be considered later.

## Current Behavior (as-is)

`SessionDataPathResolver(repositoryName?: string)`:

```
getBaseDir():
  if repositoryName is truthy:
    return <configDir>/repositories/<repositoryName>
  else:
    return <configDir>/_quick
```

Constructed at (enumerated for acceptance criteria coverage):

| Call site | Context | Failure mode |
|-----------|---------|--------------|
| `SessionManager.getPathResolverForSession(session)` | Per-request for active session | Silent fallback to `_quick/` if repo lookup fails |
| `SessionManager.getPathResolverForPersistedSession(persisted)` | Resume-time reconstruction | Same silent fallback |
| `WorkerLifecycleManager.readWorkerOutput` (fallback branch) | Session not found | Bare `new SessionDataPathResolver()` → `_quick/` unconditionally |
| `WorkerLifecycleManager.getCurrentOffset` (fallback branch) | Session not found | Same as above |
| `WorkerLifecycleManager` cleanup enqueue | Serializes `repositoryName` into job payload | May capture `undefined` |
| `SessionDeletionService` cleanup enqueue (active + persisted) | Serializes `repositoryName` into job payload | Same |
| `jobs/handlers.ts` (`CLEANUP_SESSION_OUTPUTS`, `CLEANUP_WORKER_OUTPUT`) | Reconstructs from payload `repositoryName` | Falls back to `_quick/` if payload value is `undefined` |
| `SessionInitializationService` (startup flows) | Resume-time path operations | Same silent-fallback chain |

Failure modes that cause fragmentation:

| Scenario | Trigger |
|----------|---------|
| A | Repository deleted while sessions still reference its `repository_id`. On resume, lookup returns `undefined` → `_quick/`. |
| B | A request arrives before `repositoryCallbacks.isInitialized() === true` during server startup. Lookup short-circuits to `undefined` → `_quick/`. |
| C | DB inconsistency (no FK constraint on `repository_id`). Lookup returns `undefined` → `_quick/`. |
| D | Bare `new SessionDataPathResolver()` in fallback branches of read/cleanup paths, independent of whether the session has a repository. Produces `_quick/` unconditionally. |

## Target Behavior (to-be)

### 1. Persist a data-location scope, not a full path

Add two new columns to the `sessions` table:

```sql
data_scope      TEXT    NULL  -- 'quick' | 'repository' | NULL (orphaned)
data_scope_slug TEXT    NULL  -- repository slug at session creation, or NULL for 'quick'
```

Rationale (addressing the full-absolute-path pitfalls raised in review):
- **Portability**: not storing the config root means `AGENT_CONSOLE_HOME` can change without invalidating persisted state.
- **Boundary safety**: runtime code derives the actual filesystem path from `(scope, slug)` via a single helper (`computeSessionDataBaseDir`) that always joins under `getConfigDir()`. A corrupted DB value cannot point to `/etc/passwd` because it is never interpreted as a filesystem path directly.
- **Rename decoupling**: the slug is captured at creation time and never updated. Repository rename does not affect existing sessions.

The pair `(data_scope, data_scope_slug)` is the only persistence format. No absolute paths are stored.

Allowed combinations:

| `data_scope` | `data_scope_slug` | Meaning |
|--------------|-------------------|---------|
| `'quick'`    | `NULL`            | Session uses the `_quick/` directory |
| `'repository'` | `'<slug>'`      | Session uses `repositories/<slug>/` directory |
| `NULL`       | `NULL`            | Orphaned — see §3 |

### 2. Path derivation is a pure function

A single module-level helper is the only writer-of-truth for path computation:

```ts
function computeSessionDataBaseDir(
  configDir: string,
  scope: 'quick' | 'repository',
  slug: string | null,
): string
```

Invariants (enforced in the helper):
- Returns a canonical absolute path (symlinks resolved where applicable).
- The returned path is always under `configDir` — verified by string-prefix check after `path.resolve`.
- `scope === 'quick'` requires `slug === null`; `scope === 'repository'` requires a non-empty slug matching `^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$`.
- Throws `InvalidSessionDataScopeError` on any violation.

`SessionDataPathResolver` becomes a thin wrapper around a `baseDir: string` value:

```ts
class SessionDataPathResolver {
  constructor(private readonly baseDir: string) {}
  getOutputsDir(): string { return path.join(this.baseDir, 'outputs'); }
  // ... etc.
}
```

No parameterless overload exists. No `repositoryName` argument exists. All call sites derive `baseDir` through `computeSessionDataBaseDir(configDir, session.dataScope, session.dataScopeSlug)` (or equivalent from a job payload).

### 3. Orphan lifecycle

Add an explicit recovery-state field to the `sessions` table:

```sql
recovery_state TEXT NOT NULL DEFAULT 'healthy'  -- 'healthy' | 'orphaned'
orphaned_at    INTEGER NULL                      -- timestamp when marked
orphaned_reason TEXT NULL                         -- short machine-readable code
```

Lifecycle:
- **Creation**: `recovery_state = 'healthy'`. `data_scope` + `data_scope_slug` are set atomically.
- **Detection**: orphan marking applies **only** to durable metadata problems — `data_scope` is `NULL`, `data_scope_slug` fails the slug grammar, `scope`/`slug` combination is invalid (e.g., `scope='quick'` with a non-null slug), or a migration cannot resolve the repository. Transient filesystem conditions (permissions glitch, disk full, readonly mount) **do not** cause orphan marking — they fail the individual operation and are logged; the DB's `recovery_state` is not mutated.
- **Exclusion**: auto-resume skips orphaned sessions. They are not replaced by new sessions; they are not auto-deleted.
- **Visibility**: the sessions list API surfaces `recovery_state`. The UI displays them in a dedicated "needs attention" state so the owner can delete manually.

Note: this replaces the current behavior where some resume code paths silently delete sessions with missing `locationPath`. Those deletion paths must be removed (see §6 and acceptance criteria).

### 4. Job payloads carry `(scope, slug)`, not `repositoryName`, not absolute paths

Cleanup jobs (`CLEANUP_SESSION_OUTPUTS`, `CLEANUP_WORKER_OUTPUT`) serialize `{ scope, slug }` into their payload. Handlers reconstruct the path via the same `computeSessionDataBaseDir` helper.

Validation (defense in depth): if the handler cannot compute a valid path from the payload, it logs an error and skips the job. It does not delete anything.

### 5. Required constructor dependencies (no late setters)

`SessionManager.create(...)` takes the repository lookup as a required argument:

```ts
SessionManager.create({
  // ...existing deps...
  repositoryLookup: RepositoryLookup, // required, non-optional
});
```

`RepositoryLookup` is a narrow interface exposing only what path resolution needs:

```ts
interface RepositoryLookup {
  getRepositorySlug(repositoryId: string): string | undefined;
}
```

`setRepositoryCallbacks()` and the `isInitialized()` check are deleted. Construction in `app-context.ts` is:

1. Build `RepositoryManager` (provides `RepositoryLookup`).
2. Pass `repositoryLookup` into `SessionManager.create({...})`.
3. `SessionManager` `initialize()` runs after construction, with dependencies guaranteed.

This makes "uninitialized state" unrepresentable. Scenario B is eliminated structurally.

### 6. Session creation: fail-fast for worktree sessions

At creation of a `type === 'worktree'` session:

1. Look up `slug = repositoryLookup.getRepositorySlug(repositoryId)`.
2. If `slug === undefined`: throw `RepositoryNotFoundError`. No DB row is inserted.
3. Validate `slug` via `computeSessionDataBaseDir`'s invariants (see §2).
4. Persist `(data_scope='repository', data_scope_slug=slug)` atomically with the rest of the session.

At creation of a `type === 'quick'` session: persist `(data_scope='quick', data_scope_slug=NULL)`. No lookup needed.

### 7. Legacy paths are not read

The new code does not read, list, write, or clean up any file under `<configDir>/outputs/` (flat), `<configDir>/_quick/outputs/<sid>/...` for sessions of `type='worktree'`, or `<configDir>/repositories/<name>/outputs/<sid>/...` for any session whose persisted scope/slug does not match. Existing files remain on disk untouched.

### 8. Startup orphan detector (required, not optional)

On `SessionManager.initialize()`, before auto-resume runs:

1. Iterate all sessions.
2. For each, attempt `computeSessionDataBaseDir(configDir, scope, slug)`.
3. If it throws (due to invalid metadata — not due to transient FS errors; the helper is pure string manipulation and does not touch the filesystem), set `recovery_state = 'orphaned'`, `orphaned_reason = 'path_resolution_failed'`.
4. Emit one summary log with counts: healthy, orphaned, orphaned-reasons histogram.

This runs exactly once per startup. The cost is O(sessions in DB) string operations — negligible.

## Migration

### Schema migration (one-off, on first startup of the new version)

```sql
ALTER TABLE sessions ADD COLUMN data_scope TEXT NULL;
ALTER TABLE sessions ADD COLUMN data_scope_slug TEXT NULL;
ALTER TABLE sessions ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE sessions ADD COLUMN orphaned_at INTEGER NULL;
ALTER TABLE sessions ADD COLUMN orphaned_reason TEXT NULL;
```

Backfill logic (runs after schema change, within the same migration transaction):

- For rows with `type = 'quick'` → set `data_scope = 'quick'`, `data_scope_slug = NULL`, `recovery_state = 'healthy'`.
- For rows with `type = 'worktree'`:
  - Resolve slug via current `RepositoryLookup`.
  - If resolvable: `data_scope = 'repository'`, `data_scope_slug = <slug>`, `recovery_state = 'healthy'`.
  - If not resolvable: leave `data_scope` and `data_scope_slug` as `NULL`; set `recovery_state = 'orphaned'`, `orphaned_reason = 'migration_unresolved_repository'`.

### Data migration

None. Existing output files are not moved. Orphaned sessions display in the UI; the owner deletes them manually, which triggers cleanup jobs that will no-op (since scope is NULL) and remove the DB row.

### One-time fragmentation report

At first startup after deployment:
- Scan `<configDir>/_quick/outputs/<sid>/` and `<configDir>/outputs/<sid>/` (flat) directories.
- For each `sid` found on disk that corresponds to a DB session of `type='worktree'`, log one warn line with `(sid, path, size, mtime)`.
- This is informational only. No files are deleted or moved.

## Error Surfaces

| Condition | Behavior | HTTP (if API) |
|-----------|----------|---------------|
| Worktree session creation, repository not found | Throw `RepositoryNotFoundError`. Session is not created. | `404` with `{ error: 'repository_not_found' }` |
| Invalid slug at session creation (shouldn't happen; defense in depth) | Throw `InvalidSessionDataScopeError`. | `422` |
| Read/cleanup for session with `recovery_state='orphaned'` | Return empty history. Cleanup jobs no-op. | `200` with empty data |
| Invalid payload in cleanup job | Log error, skip job (do not delete anything). | N/A |
| Server start with `SessionManager.create()` missing required deps | TypeScript compile error (structural enforcement). | N/A |

## Trade-offs and Alternatives Considered

### A. Persist `repositoryId` only, harden runtime lookup (as-is, with FK)

Add FK constraint + throw on lookup failure. Rejected because:
- Repository rename still changes the resolved path → fragmentation returns in a different shape.
- FK cascade on repository delete would delete session data as a side-effect of metadata — undesirable.

### B. Persist absolute filesystem path

Earlier draft of this design. Rejected after review because:
- Binds DB to current `AGENT_CONSOLE_HOME` → breaks on config moves, DB restores, test envs.
- Cleanup handlers deleting by absolute path are a footgun if the value is corrupted.

### C. Persist `(scope, slug)` (chosen)

As described above. Addresses portability, boundary safety, rename-decoupling in one shape.

Trade-off: adds a small amount of DB schema and a helper function. The helper being the only writer-of-truth is a plus for auditing and testing.

### D. Content-addressed storage (flat under `sessions/<sessionId>/`)

Considered but rejected for this iteration:
- Breaks the current directory layout relied on by operators and external tooling.
- Larger UX/ops change; consider separately if the repo-grouped structure becomes a liability.

## Acceptance Criteria

Implementation PR must satisfy ALL of the following:

### Schema and persistence
- [ ] `sessions` table has columns `data_scope`, `data_scope_slug`, `recovery_state`, `orphaned_at`, `orphaned_reason`. → schema migration test
- [ ] `computeSessionDataBaseDir` helper exists and is the only function that joins config dir + scope + slug. → unit test (+ grep-based invariant test)
- [ ] `computeSessionDataBaseDir` rejects slugs outside the allowed character set, throws on path-escape attempts (`..`, absolute paths in slug, etc.). → unit test with adversarial inputs
- [ ] `SessionDataPathResolver` has no parameterless constructor and no `repositoryName` argument. → unit test (+ type test)

### Call-site coverage (grep-based invariants)
- [ ] No production code constructs `SessionDataPathResolver` from a repository name. `grep -R 'new SessionDataPathResolver' packages/server/src` shows only internal uses receiving a `baseDir: string`. → repo-grep test
- [ ] No job payload contains a `repositoryName` field for path purposes. → repo-grep test + payload-schema test
- [ ] The following code paths all route through `computeSessionDataBaseDir`: session auto-resume, pause/resume, session delete (active + persisted), force delete, worker history read (`readWorkerOutput`), **worker offset read (`getCurrentOffset`, including the branch where the in-memory session is not found)**, worker cleanup, session output cleanup. → integration tests per path
- [ ] `getCurrentOffset` never falls back to a bare `new SessionDataPathResolver()`; the "session not found" branch either resolves the persisted `(scope, slug)` from the DB or returns a documented error — it does not silently pick `_quick/`. → unit test for the fallback branch

### Startup and creation
- [ ] `SessionManager.create({...})` requires `repositoryLookup` as a non-optional argument; `setRepositoryCallbacks()` no longer exists. → type test + unit test
- [ ] Creating a worktree session when the repository is not resolvable throws `RepositoryNotFoundError` and persists no DB row. → unit test
- [ ] Creating a quick session persists `(scope='quick', slug=NULL)`. → unit test

### Migration
- [ ] Schema migration adds the five columns with correct nullability. → migration test
- [ ] Backfill: quick sessions get `scope='quick'`. → migration test
- [ ] Backfill: worktree sessions with resolvable repo get `scope='repository', slug=<current>`. → migration test
- [ ] Backfill: worktree sessions with unresolvable repo get `recovery_state='orphaned'`, slug stays NULL. → migration test
- [ ] Startup fragmentation report runs once and logs a summary. → startup test

### Runtime behavior
- [ ] Auto-resume skips sessions with `recovery_state='orphaned'`. → unit test
- [ ] Orphaned sessions appear in the sessions list API with their state exposed. → API test
- [ ] Cleanup job handlers validate payload before doing any filesystem operation. → unit test (including adversarial payload)
- [ ] No new writes occur under `_quick/` for a session of `type='worktree'`. → integration test (create worktree session, restart server with repository deleted, verify no writes go to `_quick/`)

### worker-output-file invariants (must not regress)
- [ ] Flush ordering: writes appear in the file in the same order `bufferOutput` was called. → existing test
- [ ] Truncate semantics: size-based truncation preserves the tail, not the head. → existing test
- [ ] Offset monotonicity: `getCurrentOffset` never decreases for a live worker under normal operation. → existing + new test (cross-restart)
- [ ] Initial history read returns the full content up to current offset. → existing test

## Terminology

- **DB column names**: snake_case (`data_scope`, `data_scope_slug`, `recovery_state`).
- **TypeScript field names**: camelCase (`dataScope`, `dataScopeSlug`, `recoveryState`).
- **Scope values**: lowercase string literals (`'quick'`, `'repository'`).
- **"Canonical path"**: `path.resolve()` applied to the result of joining config dir + scope-derived subpath. Not the same as "real path" (which resolves symlinks) — this design uses `path.resolve` only, not `fs.realpath`, to avoid startup I/O.

## Related

- PR [#632](https://github.com/ms2sato/agent-console/pull/632) — defensive hardening of `worker-output-file.ts` (buffer restore, flushAll drain, backoff, cap, observability). Independent of this design; can merge before or after.
- Issue [#631](https://github.com/ms2sato/agent-console/issues/631) — the original bug report. Root cause is the subject of this document, not the symptom #632 addressed.
