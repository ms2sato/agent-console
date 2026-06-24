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
 * Accepted clone URL shapes -- mirror of the shared schema regex so the
 * service stays a self-contained validation boundary when called outside the
 * route handler (e.g., a future MCP tool). Keep in sync with the
 * `CloneRepositoryRequestSchema` in `packages/shared/src/schemas/repository.ts`.
 *
 * @internal Exported for testing.
 */
export const CLONE_URL_PATTERN =
  /^(?:https?:\/\/|git:\/\/|ssh:\/\/[^\s]+|[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9._-]+:[^\s]+)\S*$/;

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
      'URL must be https://, http://, git://, ssh://, or git@host:org/repo (no shell metacharacters or leading dashes)',
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
  private readonly jobs = new Map<string, CloneJobState>();

  constructor(options: CloneServiceOptions) {
    this.sourceReposDir = options.sourceReposDir;
    this.registrar = options.registrar;
    this.runAsUser = options.runAsUserImpl ?? defaultRunAsUser;
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  }

  /**
   * Validate the request, allocate a job, then run the clone-and-register
   * chain in the background. Returns the job id immediately so the route
   * handler can answer `202 Accepted`.
   *
   * Pre-flight failures (`CloneValidationError`, `CloneNameConflictError`)
   * are THROWN, not surfaced as a failed job, so the route can map them to
   * `400` / `409` synchronously.
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

    // Pre-flight conflict check. Using lstat so a dangling symlink at the
    // target also counts as conflict (do not silently re-purpose).
    try {
      await fsPromises.lstat(targetDir);
      throw new CloneNameConflictError(
        `Target directory already exists: ${targetDir}`,
      );
    } catch (err: unknown) {
      if (err instanceof CloneNameConflictError) throw err;
      // `ENOENT` is the happy path -- the directory should not exist yet.
      if (!isEnoent(err)) {
        // Other lstat errors (EACCES on parent, etc.) are not a conflict but
        // they ARE a pre-spawn failure. Treat as validation failure so the
        // route returns 400 with a precise message rather than 500.
        throw new CloneValidationError(
          `Could not check target directory: ${errorMessage(err)}`,
        );
      }
    }

    // Ensure parent exists before spawning. The bootstrap script creates
    // `${DATA_ROOT}/source-repos` with the right ownership; this is a safety
    // net for development environments / single-user installs where the
    // operator may not have run the bootstrap.
    await fsPromises.mkdir(this.sourceReposDir, { recursive: true });

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

    let result;
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
   * Best-effort `rm -rf <targetDir>` so a future retry can re-use the name.
   * Failures here are logged but do not change the job's final status -- the
   * underlying failure code is already the primary signal.
   */
  private async cleanupPartialClone(targetDir: string, jobId: string): Promise<void> {
    try {
      await fsPromises.rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, targetDir, jobId },
        'partial-clone cleanup failed; operator may need to rm -rf manually',
      );
    }
  }

  private transition(state: CloneJobState, status: CloneJobStatus): void {
    state.status = status;
    state.updatedAt = Date.now();
  }

  private fail(state: CloneJobState, code: CloneErrorCode, message: string): void {
    state.error = { code, message };
    this.transition(state, CLONE_JOB_STATUS.FAILED);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
