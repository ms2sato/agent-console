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

#### Slug shapes (important)

A repository slug has **two valid shapes** — both must be handled by every code path that touches the slug:

1. **`org/repo`** — for repositories mirrored from a remote host with an organization / owner namespace (e.g., GitHub). The slug maps to a nested directory (`repositories/org/repo/`).
2. **`repo`** — for **local-only repositories** that have no remote namespace. The slug maps to a flat directory (`repositories/repo/`).

The grammar `^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$` permits both shapes. Anything that consumes the slug — path computation, migration backfill, orphan detection, job-payload validation, tests — must cover **both**. Treating `org/repo` as the only shape silently breaks local-only repositories with no error signal (the else branch takes the wrong path). See [architectural-invariants I-7 "Enumeration Exhaustiveness"](../../.claude/skills/architectural-invariants/SKILL.md) for the broader pattern.

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
- The returned path is always under `configDir` — verified by string-prefix check after `path.resolve`, and, at creation time, on the inode chain: every segment from `configDir` to the leaf is created non-recursively and lstat-verified (not a symlink, a directory, owned by the server) by `ensureTrustedDirChain` (`packages/server/src/lib/trusted-dir.ts`). The string check constrains the path the server *intends*; the walker constrains the directory the filesystem *actually* hands back — under a group-writable multi-user data root the two can disagree when a group member pre-plants a symlink at `_quick/` or `repositories/<slug>/` (or any segment between) before the server first creates it, and a recursive `mkdir` follows that link silently. Every session-data writer (worker output, memos, inter-session messages, the memory layer's base) calls the walker with `resolver.getTrustedRoot()` as the root; ancestors assert symlink / directory / owner uid only (a service-user-owned directory that predates the `2775` contract must keep working), while the memory leaf keeps its exact gid/mode contract (embedded-agent-worker.md "Ownership and location"). Verification runs on every call — no readiness cache. Accepted residue: pre-planted links only; a link swapped in between the walker's `lstat` and a later use of the path (TOCTOU) is inside the team-of-trust model the `2775` contract already accepts, and no `O_NOFOLLOW` / `openat` chain is attempted.
- `scope === 'quick'` requires `slug === null`; `scope === 'repository'` requires a non-empty slug matching `^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$`.
- Throws `InvalidSessionDataScopeError` on any violation.

`SessionDataPathResolver` becomes a thin wrapper around a `baseDir: string` value plus the `trustedRoot` the inode walk starts from:

```ts
class SessionDataPathResolver {
  constructor(private readonly baseDir: string, private readonly trustedRoot: string) {}
  getOutputsDir(): string { return path.join(this.baseDir, 'outputs'); }
  /** The root `ensureTrustedDirChain` verifies every path under `baseDir` from. */
  getTrustedRoot(): string { return this.trustedRoot; }
  // ... etc.
}
```

No parameterless overload exists. No `repositoryName` argument exists. `trustedRoot` is required, with no default and no ambient `getConfigDir()` fallback (an ambient fallback would silently pass a base that is not under it). All call sites derive `baseDir` through `computeSessionDataBaseDir(configDir, session.dataScope, session.dataScopeSlug)` (or equivalent from a job payload) and pass that same `configDir` as `trustedRoot`.

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
  getRepositorySlug(repositoryId: string): Promise<string | undefined>;
}
```

`getRepositorySlug` is async because its production implementation
(`RepositoryManager.getRepositorySlug`) derives the slug from the
repository's git remote (`org/repo` when a remote resolves to a valid slug,
else `path.basename(repo.path)`) via the single-writer `deriveRepositorySlug`
helper in `lib/git.ts`. This is what makes both slug shapes from §1 actually
reachable: earlier, `getRepositorySlug` returned the repository's flat
display name unconditionally, so the `org/repo` shape was documented but
never produced by any code path.

`setRepositoryCallbacks()` and the `isInitialized()` check are deleted. Construction in `app-context.ts` is:

1. Build `RepositoryManager` (provides `RepositoryLookup`).
2. Pass `repositoryLookup` into `SessionManager.create({...})`.
3. `SessionManager` `initialize()` runs after construction, with dependencies guaranteed.

This makes "uninitialized state" unrepresentable. Scenario B is eliminated structurally.

### 6. Session creation: fail-fast for worktree sessions

At creation of a `type === 'worktree'` session:

1. Look up `slug = await repositoryLookup.getRepositorySlug(repositoryId)`.
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

### 9. The repository display name is not an address

A repository's `name` is a mutable display label. It is initialised from `path.basename(path)` at registration and can then be edited (REST `PATCH /api/repositories/:id`, MCP `update_repository`). Nothing may address a directory, a hook variable or a route by it.

**Unregister cleanup candidates.** `buildSessionDataCleanupTargets` removes each existing `repositories/<candidate>/` directory for exactly two candidates: the canonical slug (`deriveSlug`, the same derivation as session creation) and `path.basename(repoPath)` (the closed legacy-flat set, since migration v18 froze `data_scope_slug` from a name that was the basename at the time). The display name is not a candidate and the builder has no parameter for it, so it cannot reach a delete path by construction.

**Unregister removal set.** Worktrees are placed, and session data frozen, under the slug that was current when they were created; the slug derived at unregister can differ (a repository renamed on its git host and `origin` updated afterwards). `RepositoryManager.buildCleanupRepositoryPayload` therefore builds the `CLEANUP_REPOSITORY` payload from, before the row delete (the repository's `worktrees` rows cascade away with it):

- `repoDir`: `getRepositoryDir(<canonical slug>)`, as before. This is also the canonical session-data base directory, so one removal covers worktrees, templates and session data of that slug.
- `extraRepoDirs` (optional, additive): for each `worktrees` row of the repository whose path has the exact shape `<repositoriesDir>/<slug>/worktrees/<one segment>` with `isValidSlug(slug)`, the directory `getRepositoryDir(slug)` (`repositoryDirFromWorktreePath`, `services/repository-dir-claims.ts`). A row of any other shape (the main checkout, a path outside `repositoriesDir`, extra depth, a `..` segment, a relative path) contributes nothing, silently except for a placement-shaped path with an invalid slug, which logs a warning. A raw row path is never removed. Duplicates of `repoDir` or of each other are dropped, and these directories are not repeated in `sessionDataDirs`. The field is omitted when empty. The handler removes each entry through the same routine as `repoDir` (elevated when `requestUsername` elevates, because they hold user-owned worktrees), followed by the same best-effort org-parent tidy-up; an absent field means empty, so a job enqueued before this field existed behaves as before. No new elevated command shape.
- `sessionDataDirs`: the existing candidates (canonical slug, `path.basename(repoPath)`), existing directories only, minus claimed directories and minus anything already in `extraRepoDirs`.

**Claim guard.** A directory is skipped, with an info log, when another registered repository claims it by (a) its current canonical slug, (b) its path basename, (c) a worktree row of its own under it, or (d) its own checkout path (`findClaimedRepositoryDirs`). Claim (d) exists because a linked worktree checkout can itself be registered, so it can sit under a directory that another repository's rows record. It is `path.resolve`d, not realpath'd: every target is built from the never-realpath'd `getRepositoriesDir()` and the stored registration path is `path.resolve`d, so realpath on one side only would miss whenever the data root is reached through a symlink, and realpath fails for a checkout that is missing on disk. A checkout outside `repositories/` adds an entry no target can match. Two checkouts that share a basename, one of them without a remote, share the flat directory `repositories/<basename>`; that directory is ambiguous by construction, and deleting too little is the safe direction. A slug derivation that throws for another repository makes it claim its basename only; it never aborts the unregister. With no other registered repository the claim set is empty. The guard is applied to `sessionDataDirs` candidates and to `extraRepoDirs`; for the canonical directory it yields `repoDir: null` (see the residue below).

**What a claim protects.** One predicate, `isProtectedByClaim(dir, claimedDirs)` (`services/repository-dir-claims.ts`), is used at all three sites (the canonical directory, the worktree-derived loop, `buildSessionDataCleanupTargets`). A directory is protected when it equals a claimed directory or is an ANCESTOR of one, compared by path segment (`repositories/acme` is not protected by a claim on `repositories/acme-old`). The layout has two depths (flat `repo` and `org/repo`), so a flat or org-level directory that holds another repository's `org/repo` directory must be left alone: for example a checkout `/x/x` (slug `x/x`) has the basename candidate `repositories/x`, which contains the registered sibling `x/y`. Only the ancestor direction is protected. A target that lies INSIDE a claimed directory is not protected: basename claims are broad, and protecting descendants would skip `x/y` whenever any registered checkout is named `x`.

**Where the claims come from.** The claim input is every persisted registration (`repository.findAll()`), not the in-memory map. `initialize()` leaves a repository out of the map when its checkout path is missing but keeps its row and its worktree rows, so that repository is still a claimant: it claims its checkout path, its basename, the directories of its worktree rows, and its canonical slug when the derivation succeeds (a derivation that throws leaves its checkout path and basename claimed).

| target | claim set | action |
|---|---|---|
| canonical flat `acme` | other claims `acme/project` | `repoDir: null`, info log |
| basename candidate `x` (exists) | other claims `x/y` | not in `sessionDataDirs`, info log |
| worktree-derived flat `acme` | other claims `acme/service` | not in `extraRepoDirs`, info log |
| `acme` | other claims `acme-old` only | not protected (segment comparison) |
| `x/y` | other claims flat `x` (basename or slug) | not protected (descendant direction) |
| any | empty claim set | not protected |
| any | another repository persisted but not loaded (checkout missing) | it claims its checkout path, its basename, its worktree-row directories and its canonical slug (checkout path and basename only when derivation throws) |
| worktree-derived `org/old` | other's checkout at `repositories/org/old/worktrees/wt-a`, no worktree rows | not in `extraRepoDirs`, info log |
| canonical dir of R | other's checkout anywhere under it | `repoDir: null`, info log |
| basename candidate | other's checkout anywhere under it | not in `sessionDataDirs`, info log |
| any target | other's checkout outside `repositories/` | no effect |
| any target | other's checkout path equal to the target | protected (equality) |
| any target | other's checkout missing on disk (persisted, not loaded) | still claimed by its stored path |
| `repositories/acme` | other's checkout under `repositories/acme-old/...` | not protected (segment comparison) |

**Residue (decided, not fixed here).**

- A registration whose stored path reaches a directory under `repositories/` through a different spelling (for example a symlink) is not protected by claim (d), because the comparison is by `path.resolve`d string, not realpath.
- Session data left under an old slug that has no remaining worktree row is not removed: nothing records it. Closing that needs a persisted per-repository slug record, which is a database migration and an owner decision. The set is deliberately not approximated by scanning `repositories/`.
- If another registered repository claims the canonical directory of the repository being unregistered (for example the same remote registered twice), the payload carries `repoDir: null` and the handler removes nothing for it and does not tidy its org-parent directory; the manager logs the skip at info level naming the slug. Always removing the shared directory would delete the other repository's data, and refusing the unregister would leave neither removable. Residue (decided): in that claimed case the unregistered repository's own worktree directories under the shared directory are left. Removing them one by one from its worktree rows is a possible later step, not part of this change. The other payload fields (`extraDir`, `extraRepoDirs`, `sessionDataDirs`) are processed as usual.
- An org-level directory left in place by the ancestor rule keeps the unregistered repository's own subdirectory when that repository's canonical directory is itself removable; the subdirectory is still removed through `repoDir`. Nothing else changes.
- Rollback property: a job with `repoDir: null` run by a build that predates this change fails in the handler (its `repoDir` handling needs a string) before anything is removed, so nothing is deleted (fail-closed).

**Premise.** No session rows exist for the repository at unregister: the repository-in-use gate refuses unregister while any session (active or persisted) is attached. Session data is thus addressed by directories, not by session rows.

**`{{REPO}}`.** Setup, cleanup, pause and resume commands and repository `envVars` resolve `{{REPO}}` to `path.basename(repo.path)` through the single helper `resolveRepoTemplateName` (`lib/repository-hook-name.ts`). It is byte-identical to the pre-edit value for every repository the application registered (registration has always stored `path.basename(path)`, and nothing wrote the column afterwards until this change) and stays stable across a rename, so a per-worktree database or port prefix created under one value is cleaned up under the same one. The worktree-creation service derives it from `repoPath` itself (it takes no name parameter); the deletion service and `SessionManager` (envVars, pause, resume) call the helper with the repository path. Template-file copy (`worktree-service.ts`) is a different derivation and is deliberately untouched: its `repo` value is the repository component of the canonical slug from `deriveRepositorySlug(repoPath, path.basename(repoPath))`. When no valid remote slug is available (no origin remote, an unparseable URL, or a slug that fails validation), the whole fallback slug is used, which is the checkout directory name. So template-file copy and `{{REPO}}` coincide whenever the slug's repository part equals the checkout directory name (always so in the no-remote case, and also for a valid remote slug such as `org/repo` with a checkout at `/work/repo`), and differ otherwise (remote repository name versus checkout directory name).

**Validation (one rule, one writer).** `RepositoryDisplayNameSchema` (`packages/shared/src/schemas/repository.ts`): trimmed, 1..100 characters after the trim (counted as UTF-16 code units, i.e. `.length`: most characters count as one, emoji and some rare CJK characters as two), no control characters (U+0000-U+001F, U+007F), otherwise free text. The control-character check runs after the trim, so leading and trailing whitespace controls are removed first: `"\tRepo\n"` is accepted as `Repo`, while `"Re\tpo"` is rejected. Not nullable and no uniqueness check (names were already non-unique). REST uses it as `v.optional(...)` inside `UpdateRepositoryRequestSchema`; the MCP handler runs the same schema on its `name` argument before anything is written.

**Surfaces.**

| Operation | REST `PATCH /api/repositories/:id` | MCP `update_repository` | UI (`EditRepositoryForm`) |
|---|---|---|---|
| change the display name | do: `name` field | do: `name` argument | do: "Name" field (client slice) |
| clear the display name | not here: the column is NOT NULL, "clear" has no meaning | not here: same | not here: same |
| change `path` or the on-disk directory | not here: out of scope, no update path | not here: same | not here: same |

**Broadcast wiring.** `repository-updated` still fires for every successful update; only the rename-triggered `session-updated` is suppressed when the name is omitted or unchanged. Each wire session also carries a `repositoryName` computed at conversion time (the sidebar group label reads it), so `RepositoryManager.updateRepository` compares the persisted name before and after the write and, only when the value actually changed, calls the new `onRepositoryNameChanged` lifecycle callback AFTER `onRepositoryUpdated`. `websocket/routes.ts` wires that callback to `SessionManager.notifyRepositorySessionsUpdated(repositoryId)`, which sends the existing `session-updated` message for every live worktree session of that repository (none for other repositories; none when the repository has no live session). No new wire message. An omitted or same-value name fires neither. A paused session's label refreshes on the next `sessions-sync`; an in-flight worktree-creation task label keeps the name captured at start.

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
