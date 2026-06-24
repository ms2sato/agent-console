/**
 * Clone-and-register repository service (Issue #834).
 *
 * Performs `git clone` via `runAsUser` (so multi-user mode clones as the
 * requesting OS user with that user's SSH agent / git credential helpers
 * inherited), then registers the resulting path via `RepositoryManager`.
 * Returns a job handle so the route handler can respond `202 Accepted`
 * immediately while the clone runs in the background; the client polls
 * `GET /api/repositories/clone/:jobId` for the final status.
 *
 * Design choice -- in-memory job state (not the SQLite-backed JobQueue):
 *
 * - The existing `JobQueue` provides guaranteed delivery with exponential-
 *   backoff retry; that contract is wrong for clone operations because
 *   common failure modes (auth_failed, repo_not_found, name_conflict,
 *   permission_denied) will never succeed on retry without operator
 *   intervention, and a retry that re-runs the partial-clone cleanup on a
 *   fresh attempt risks deleting a target the operator manually fixed.
 * - Clone jobs are short-lived (seconds to minutes); losing in-flight state
 *   across a server restart is acceptable -- the user simply retries from
 *   the UI. The partial-clone target directory is cleaned up at the time of
 *   failure (see `cleanupPartialClone`) so a restart does not leak it
 *   either.
 *
 * Server-side defense-in-depth: even though the route uses the shared
 * `CloneRepositoryRequestSchema` for input validation, this service
 * re-validates the URL and name with the same rules before any subprocess
 * spawn. The schema is the primary boundary; the re-validation guards
 * against future internal callers (e.g., MCP) that might bypass the route.
 */
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Repository, CloneErrorCode, CloneJobStatus } from '@agent-console/shared';
import { CLONE_ERROR_CODES, CLONE_JOB_STATUS } from '@agent-console/shared';
import { runAsUser as defaultRunAsUser, shellEscape } from './privilege-elevation.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:repository-clone');

/**
 * Default clone timeout. Generous enough for a large repo over a slow link;
 * shorter than typical reverse-proxy idle limits would matter for, since the
 * clone runs out-of-band of the HTTP request that started it.
 */
const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long to keep a terminal (succeeded / failed) job's state in memory
 * before evicting it. Long enough to let a polling client observe the
 * terminal state at least a few times; short enough that a long-lived server
 * + many invalid clone attempts cannot grow the map unbounded. Per CodeRabbit
 * review on PR #862.
 */
const TERMINAL_JOB_TTL_MS = 10 * 60 * 1000;

/**
 * Accepted clone URL shapes -- mirror of the shared schema regex so the
 * service stays a self-contained validation boundary when called outside the
 * route handler (e.g., a future MCP tool). Keep in sync with the
 * `CloneRepositoryRequestSchema` in `packages/shared/src/schemas/repository.ts`.
 *
 * @internal Exported for testing.
 */
export const CLONE_URL_PATTERN =
  /^(?:https:\/\/|git:\/\/|ssh:\/\/[^\s]+|[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9._-]+:[^\s]+)\S*$/;

/**
 * Characters that must never appear in a clone URL accepted by this service.
 * Mirrors `cloneUrlDisallowedPattern` in
 * `packages/shared/src/schemas/repository.ts`. Covers POSIX shell
 * metacharacters, both quote shapes, the backslash escape, parentheses /
 * brackets / braces, C0/C1 control characters (0x00-0x1F + 0x7F), and any
 * whitespace.
 *
 * @internal Exported for testing.
 */
// eslint-disable-next-line no-control-regex
export const URL_DISALLOWED_PATTERN = /[\s\x00-\x1F\x7F;&|`$<>()[\]{}'"\\]/;

/**
 * Accepted repository name shape. Keep in sync with `repoNamePattern` in
 * `packages/shared/src/schemas/repository.ts`.
 * @internal Exported for testing.
 */
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$/;

/**
 * Minimal `RepositoryManager` surface the clone service needs. Narrowing the
 * dep here keeps the test mock small and prevents accidental coupling to
 * unrelated manager methods.
 */
export interface RepositoryRegistrar {
  registerRepository(
    repoPath: string,
    options?: { description?: string },
  ): Promise<Repository>;
}

/**
 * The privilege-elevation helper signature this service calls. Mirrors
 * `RunAsUserFn` in `repository-manager.ts`; redeclared here to avoid coupling
 * the service to the manager module.
 */
export type RunAsUserFn = typeof defaultRunAsUser;

/**
 * Request shape for `enqueueClone`. Mirrors the schema-validated body of
 * `POST /api/repositories/clone` plus the threaded auth context.
 */
export interface CloneRepositoryRequest {
  url: string;
  /** When omitted, derived from the URL's last path segment minus `.git`. */
  name?: string;
  description?: string;
  /**
   * OS username threaded from `authUser.username`. `null` (single-user mode,
   * or any path that has no authenticated user context) skips elevation; the
   * clone runs as the server process user.
   */
  requestUser: string | null;
}

export interface CloneJobError {
  code: CloneErrorCode;
  message: string;
}

/**
 * Internal job state retained in memory between enqueue and final polling.
 * The shape mirrors the `CloneJobStatusResponse` returned by the GET route
 * but additionally retains internal `repositoryId` / `error` fields so the
 * route handler can construct the public response without duplicating the
 * status -> field mapping.
 */
export interface CloneJobState {
  id: string;
  status: CloneJobStatus;
  /** Populated when `status === 'succeeded'`. */
  repositoryId?: string;
  /** Populated when `status === 'failed'`. */
  error?: CloneJobError;
  /** When the job entered the queue. */
  createdAt: number;
  /** When the job last transitioned (for diagnostics / TTL). */
  updatedAt: number;
}

export interface CloneServiceOptions {
  /** Absolute path to the parent directory under which clones land. */
  sourceReposDir: string;
  /** Repository registrar (typically `repositoryManager`). */
  registrar: RepositoryRegistrar;
  /** Privilege-elevation helper. Override in tests with a captured stub. */
  runAsUserImpl?: RunAsUserFn;
  /** Override per-clone timeout. Defaults to {@link DEFAULT_CLONE_TIMEOUT_MS}. */
  cloneTimeoutMs?: number;
  /**
   * Override the terminal-job TTL (ms) used by the eviction sweeper.
   * Defaults to {@link TERMINAL_JOB_TTL_MS}. Tests can lower this so the
   * eviction observable in a single test tick.
   */
  terminalJobTtlMs?: number;
  /**
   * Override the scheduler used to evict terminal jobs after their TTL.
   * Defaults to `setTimeout` / `clearTimeout`. Tests can substitute a
   * deterministic queue. Returns a cancel handle so the service can short-
   * circuit a pending eviction (e.g., when the job is observed by a poller).
   */
  scheduleEviction?: (
    cb: () => void,
    delayMs: number,
  ) => { cancel: () => void };
}

/**
 * Validation failure raised before any subprocess spawn. Distinct error type
 * so the route handler can map it to a `400 validation_error` response.
 */
export class CloneValidationError extends Error {
  readonly code: CloneErrorCode = CLONE_ERROR_CODES.VALIDATION_ERROR;
  constructor(message: string) {
    super(message);
    this.name = 'CloneValidationError';
  }
}

/**
 * Target-directory conflict raised before any subprocess spawn. Distinct so
 * the route handler can map it to `409 name_conflict`.
 */
export class CloneNameConflictError extends Error {
  readonly code: CloneErrorCode = CLONE_ERROR_CODES.NAME_CONFLICT;
  constructor(message: string) {
    super(message);
    this.name = 'CloneNameConflictError';
  }
}

/**
 * Derive a directory name from a clone URL when the caller did not provide
 * one. Strips a trailing `.git` and the path's leading separator. Returns
 * null when the URL does not have an extractable basename (the caller surfaces
 * a `validation_error` in that case).
 *
 * @internal Exported for testing.
 */
export function deriveNameFromUrl(url: string): string | null {
  // For SSH shortcut `git@host:org/repo.git` and `ssh://host/org/repo.git`
  // alike, the basename is what follows the last `/`. For SCP-style without
  // a path slash (`git@host:repo.git`), the basename follows the last `:`.
  let candidate = url;
  const lastSlash = candidate.lastIndexOf('/');
  if (lastSlash >= 0) {
    candidate = candidate.slice(lastSlash + 1);
  } else {
    const lastColon = candidate.lastIndexOf(':');
    if (lastColon >= 0) {
      candidate = candidate.slice(lastColon + 1);
    }
  }
  if (candidate.endsWith('.git')) {
    candidate = candidate.slice(0, -4);
  }
  candidate = candidate.trim();
  if (candidate.length === 0) {
    return null;
  }
  return candidate;
}

/**
 * Classify a `git clone` stderr (or timeout flag) into a structured
 * {@link CloneErrorCode}. Pattern list mirrors Issue #834 Failure modes; new
 * codes are added here as we observe further real-world failure shapes.
 *
 * @internal Exported for testing.
 */
export function classifyCloneError(
  stderr: string,
  exitCode: number,
  timedOut: boolean,
): CloneErrorCode {
  if (timedOut) return CLONE_ERROR_CODES.TIMEOUT;
  const text = stderr.toLowerCase();
  // Permission-denied checks come first because they may overlap with auth
  // patterns (e.g., `Permission denied (publickey)`). Distinguish:
  //   - "permission denied (publickey)" -> SSH auth failure -> auth_failed
  //   - bare "permission denied" -> local fs permission -> permission_denied
  // Order matters for `auth_failed` to catch the SSH shape first.
  if (
    text.includes('permission denied (publickey)') ||
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('terminal prompts disabled') ||
    text.includes('invalid credentials') ||
    text.includes('access denied')
  ) {
    return CLONE_ERROR_CODES.AUTH_FAILED;
  }
  if (
    text.includes('repository not found') ||
    text.includes('does not appear to be a git repository') ||
    text.includes('not found') ||
    text.includes('remote: not found')
  ) {
    return CLONE_ERROR_CODES.REPO_NOT_FOUND;
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('connection refused') ||
    text.includes('connection timed out') ||
    text.includes('network is unreachable') ||
    text.includes('ssl certificate') ||
    text.includes('unable to access')
  ) {
    return CLONE_ERROR_CODES.NETWORK_ERROR;
  }
  if (
    text.includes('permission denied') ||
    text.includes('operation not permitted') ||
    text.includes('eacces')
  ) {
    return CLONE_ERROR_CODES.PERMISSION_DENIED;
  }
  if (exitCode === 0) {
    // Non-zero classification was requested but exit code is 0 -- this is a
    // degenerate input to the classifier; surface as unknown so callers do
    // not silently treat success as a known failure.
    return CLONE_ERROR_CODES.UNKNOWN;
  }
  return CLONE_ERROR_CODES.UNKNOWN;
}

/**
 * Defense-in-depth re-validation of the inputs that will reach the spawn.
 * Throws `CloneValidationError` on any shape mismatch.
 *
 * @internal Exported for testing.
 */
export function validateCloneInputs(url: string, name: string): void {
  if (!CLONE_URL_PATTERN.test(url)) {
    throw new CloneValidationError(
      'URL must be https://, git://, ssh://, or git@host:org/repo (http:// rejected; no leading dashes)',
    );
  }
  if (URL_DISALLOWED_PATTERN.test(url)) {
    throw new CloneValidationError(
      'URL contains a disallowed character (whitespace, shell metacharacters, control characters, quotes, or backslash)',
    );
  }
  if (!REPO_NAME_PATTERN.test(name)) {
    throw new CloneValidationError(
      'Name must contain only [A-Za-z0-9._-], be 1-100 chars, and not start with `-`',
    );
  }
  if (name === '.' || name === '..' || name.includes('..') || name.includes('/')) {
    throw new CloneValidationError('Name cannot be `.`, `..`, or contain `..` / `/`');
  }
}

/**
 * Clone-and-register service. Maintains in-memory job state across the
 * request -> background-run -> poll lifecycle.
 *
 * The service does NOT itself trigger the `repositoryRegistered` broadcast --
 * that happens inside `RepositoryManager.registerRepository` via the
 * existing `lifecycleCallbacks.onRepositoryCreated` hook wired in
 * `websocket/routes.ts`. Calling `registrar.registerRepository` is sufficient
 * to emit the standard `repository-created` `/ws/app` event.
 */
export class RepositoryCloneService {
  private readonly sourceReposDir: string;
  private readonly registrar: RepositoryRegistrar;
  private readonly runAsUser: RunAsUserFn;
  private readonly cloneTimeoutMs: number;
  private readonly terminalJobTtlMs: number;
  private readonly jobs = new Map<string, CloneJobState>();
  /**
   * Pending eviction timers for terminal jobs, keyed by jobId. Tracked so
   * tests / shutdown can clear them and a manual `evictTerminalJobs()` call
   * can short-circuit them.
   */
  private readonly evictTimers = new Map<string, { cancel: () => void }>();
  /**
   * Sleep-then-evict shim. Defaults to `setTimeout` / `clearTimeout` from
   * the host runtime; tests can substitute deterministic timers via
   * `CloneServiceOptions.scheduleEviction`.
   */
  private readonly scheduleEviction: (
    cb: () => void,
    delayMs: number,
  ) => { cancel: () => void };

  constructor(options: CloneServiceOptions) {
    this.sourceReposDir = options.sourceReposDir;
    this.registrar = options.registrar;
    this.runAsUser = options.runAsUserImpl ?? defaultRunAsUser;
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    this.terminalJobTtlMs = options.terminalJobTtlMs ?? TERMINAL_JOB_TTL_MS;
    this.scheduleEviction =
      options.scheduleEviction ??
      ((cb, delayMs) => {
        const handle = setTimeout(cb, delayMs);
        return { cancel: () => clearTimeout(handle) };
      });
  }

  /**
   * Validate the request, allocate a job, then run the clone-and-register
   * chain in the background. Returns the job id immediately so the route
   * handler can answer `202 Accepted`.
   *
   * Pre-flight failures (`CloneValidationError`, `CloneNameConflictError`)
   * are THROWN, not surfaced as a failed job, so the route can map them to
   * `400` / `409` synchronously.
   *
   * Race safety -- the target directory is reserved atomically via
   * `fsPromises.mkdir(targetDir, { recursive: false })`. POSIX `mkdir(2)`
   * guarantees that exactly one of N concurrent same-target requests
   * succeeds; the rest receive `EEXIST` and are surfaced as
   * `CloneNameConflictError`. This closes the TOCTOU window CodeRabbit
   * flagged on PR #862 against the prior lstat-only check. The reservation
   * lives until the job's terminal-state cleanup (success: leave the dir
   * alone; failure: rm the dir so the name is reusable).
   */
  async enqueueClone(request: CloneRepositoryRequest): Promise<string> {
    const url = request.url.trim();
    const explicitName = request.name?.trim();
    const derived = explicitName && explicitName.length > 0 ? explicitName : deriveNameFromUrl(url);
    if (derived === null || derived.length === 0) {
      throw new CloneValidationError(
        'Could not derive a directory name from the URL; provide `name` explicitly',
      );
    }

    // Defense-in-depth: re-validate inputs even though the schema already did.
    validateCloneInputs(url, derived);

    const targetDir = path.join(this.sourceReposDir, derived);

    // Ensure parent exists before reserving. The bootstrap script creates
    // `${DATA_ROOT}/source-repos` with the right ownership; this is a safety
    // net for development environments / single-user installs where the
    // operator may not have run the bootstrap.
    try {
      await fsPromises.mkdir(this.sourceReposDir, { recursive: true });
    } catch (err: unknown) {
      throw new CloneValidationError(
        `Could not prepare source-repos directory: ${errorMessage(err)}`,
      );
    }

    // Atomic target reservation -- replaces the previous lstat conflict check
    // (TOCTOU-vulnerable). `mkdir` without `recursive` fails with `EEXIST`
    // when the target already exists, so we cannot accidentally re-purpose
    // an operator-cloned tree. `git clone` happily clones INTO a pre-
    // existing empty directory, so this reservation is compatible with the
    // subsequent `runAsUser` clone step.
    try {
      await fsPromises.mkdir(targetDir);
    } catch (err: unknown) {
      if (isEexist(err)) {
        throw new CloneNameConflictError(
          `Target directory already exists: ${targetDir}`,
        );
      }
      throw new CloneValidationError(
        `Could not reserve target directory: ${errorMessage(err)}`,
      );
    }

    const jobId = randomUUID();
    const now = Date.now();
    const state: CloneJobState = {
      id: jobId,
      status: CLONE_JOB_STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, state);

    // Fire-and-forget the background run. We deliberately do not `await`
    // here so the route returns 202 immediately. The internal handler logs
    // every transition and updates `state` in place; any unhandled rejection
    // would only land in the unhandledRejection logger because the chain
    // catches its own errors.
    void this.runCloneJob(jobId, url, derived, targetDir, request);

    return jobId;
  }

  /**
   * Look up a job's current state. Returns undefined for unknown ids so the
   * route can map to 404.
   */
  getJob(jobId: string): CloneJobState | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Internal: orchestrate clone + register + state transitions for one job.
   * Any thrown error is caught and converted to a `failed` transition so the
   * fire-and-forget caller does not need its own catch.
   */
  private async runCloneJob(
    jobId: string,
    url: string,
    name: string,
    targetDir: string,
    request: CloneRepositoryRequest,
  ): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) {
      logger.warn({ jobId }, 'runCloneJob: job state missing; aborting');
      return;
    }
    this.transition(state, CLONE_JOB_STATUS.CLONING);

    // Build `git clone --config core.sharedRepository=group <url> <targetDir>`
    // with both args shell-escaped. The outer `runAsUser` decides whether to
    // wrap the command in `sudo -i sh -c ...` based on AUTH_MODE +
    // requestUser. cwd is set to the parent so the clone has a writable
    // ambient directory even when the elevated shell could not chdir.
    const command =
      `git clone --config core.sharedRepository=group ` +
      `${shellEscape(url)} ${shellEscape(targetDir)}`;

    let result: Awaited<ReturnType<RunAsUserFn>>;
    try {
      result = await this.runAsUser({
        username: request.requestUser,
        command,
        cwd: this.sourceReposDir,
        timeoutMs: this.cloneTimeoutMs,
        // Inherit the user's auth env across the sudo barrier. FORCE_COLOR
        // is the runAsUser default; we add the standard git / ssh auth keys.
        preserveEnv: [
          'FORCE_COLOR',
          'SSH_AUTH_SOCK',
          'SSH_AGENT_PID',
          'GIT_ASKPASS',
        ],
      });
    } catch (err) {
      // Spawn-level failure (e.g., sudo missing). Treat as a clone failure
      // with `unknown` code so the user sees the underlying message.
      const message = errorMessage(err);
      logger.warn({ jobId, err }, 'clone spawn threw; marking job failed');
      await this.cleanupPartialClone(targetDir, jobId);
      this.fail(state, CLONE_ERROR_CODES.UNKNOWN, message);
      return;
    }

    if (result.timedOut || result.exitCode !== 0) {
      const code = classifyCloneError(result.stderr, result.exitCode, result.timedOut);
      const message = result.timedOut
        ? `git clone timed out after ${Math.floor(this.cloneTimeoutMs / 1000)}s`
        : result.stderr.trim() || `git clone exited ${result.exitCode}`;
      logger.warn(
        { jobId, code, exitCode: result.exitCode, timedOut: result.timedOut },
        'git clone failed; marking job failed',
      );
      await this.cleanupPartialClone(targetDir, jobId);
      this.fail(state, code, message);
      return;
    }

    // Clone succeeded -- hand off to RepositoryManager.registerRepository,
    // which auto-applies #845's group-writable bootstrap + #853's server-side
    // safe.directory entry as part of its standard flow.
    let repository: Repository;
    try {
      repository = await this.registrar.registerRepository(targetDir, {
        description: request.description,
      });
    } catch (err) {
      const message = errorMessage(err);
      logger.warn({ jobId, err }, 'registerRepository failed after clone');
      // Don't blow away the on-disk clone here -- it succeeded. The user
      // can retry registration manually via the existing
      // `POST /api/repositories` endpoint, or fix the underlying cause
      // (e.g., the path already registered) and re-clone with a new name.
      this.fail(state, CLONE_ERROR_CODES.UNKNOWN, `Registration failed: ${message}`);
      return;
    }

    state.repositoryId = repository.id;
    this.transition(state, CLONE_JOB_STATUS.SUCCEEDED);
    logger.info(
      { jobId, repositoryId: repository.id, name, requestUser: request.requestUser ?? null },
      'clone-and-register job succeeded',
    );
  }

  /**
   * Release the atomically-reserved target directory + any partial clone
   * git left behind. Only called on failure: a successful clone leaves the
   * directory in place because it now holds the registered repo. Safe to
   * call even when the directory was only the empty reservation -- `rm`
   * with `recursive: true` covers both shapes.
   */
  private async cleanupPartialClone(targetDir: string, jobId: string): Promise<void> {
    try {
      await fsPromises.rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, targetDir, jobId },
        'partial-clone cleanup failed; operator may need to remove the directory manually',
      );
    }
  }

  private transition(state: CloneJobState, status: CloneJobStatus): void {
    state.status = status;
    state.updatedAt = Date.now();
    if (status === CLONE_JOB_STATUS.SUCCEEDED || status === CLONE_JOB_STATUS.FAILED) {
      this.scheduleTerminalEviction(state.id);
    }
  }

  private fail(state: CloneJobState, code: CloneErrorCode, message: string): void {
    state.error = { code, message };
    this.transition(state, CLONE_JOB_STATUS.FAILED);
  }

  /**
   * Schedule eviction of a terminal job from the in-memory map after the
   * configured TTL. Replaces any prior timer for the same job. Per
   * CodeRabbit review on PR #862 (unbounded-growth guard).
   */
  private scheduleTerminalEviction(jobId: string): void {
    const existing = this.evictTimers.get(jobId);
    if (existing) {
      existing.cancel();
    }
    const handle = this.scheduleEviction(() => {
      this.jobs.delete(jobId);
      this.evictTimers.delete(jobId);
      logger.debug({ jobId }, 'evicted terminal clone job from in-memory map');
    }, this.terminalJobTtlMs);
    this.evictTimers.set(jobId, handle);
  }

  /**
   * Cancel all pending eviction timers. Used by tests + by the test app
   * context teardown so timers do not leak across cases.
   */
  dispose(): void {
    for (const handle of this.evictTimers.values()) {
      handle.cancel();
    }
    this.evictTimers.clear();
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
