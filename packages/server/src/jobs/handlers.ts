/**
 * Job handlers for the local job queue.
 *
 * Registers handlers for background cleanup operations.
 * See job-types.ts for available job types and their payloads.
 */
import * as fs from 'fs/promises';
import type { JobQueue } from './job-queue.js';
import {
  JOB_TYPES,
  type CleanupSessionOutputsPayload,
  type CleanupWorkerOutputPayload,
  type CleanupRepositoryPayload,
} from './job-types.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import {
  computeSessionDataBaseDir,
  InvalidSessionDataScopeError,
} from '../lib/session-data-path.js';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import {
  rmRecursiveAsUser as defaultRmRecursiveAsUser,
  shouldElevateForUser,
  type RunAsUserResult,
} from '../services/privilege-elevation.js';

const logger = createLogger('job-handlers');

/**
 * Timeout for the elevated `rm -rf` of an entire repository data directory.
 * The dir may contain multiple per-user worktrees plus templates, so this is
 * generous relative to `WORKTREE_REMOVE_TIMEOUT_MS` in `worktree-service.ts`.
 * If the helper times out, the result surfaces as `timedOut: true` and the
 * handler throws so the job queue retries.
 */
const CLEANUP_REPOSITORY_TIMEOUT_MS = 300000;

/**
 * Signature of the elevated recursive-removal helper. Mirrored from
 * `privilege-elevation.ts` so tests can inject a fake without touching the
 * module export.
 * @internal Exported for testing.
 */
export type RmRecursiveAsUserFn = (
  path: string,
  username: string | null | undefined,
  opts?: { timeoutMs?: number },
) => Promise<RunAsUserResult>;

/**
 * Optional dependencies injected by tests. Defaults bind to the real
 * `rmRecursiveAsUser`; production callers omit this argument.
 */
export interface JobHandlerDeps {
  rmRecursiveAsUserImpl?: RmRecursiveAsUserFn;
}

export function registerJobHandlers(
  jobQueue: JobQueue,
  workerOutputFileManager: WorkerOutputFileManager,
  deps: JobHandlerDeps = {},
): void {
  const rmRecursiveAsUserImpl: RmRecursiveAsUserFn =
    deps.rmRecursiveAsUserImpl ?? defaultRmRecursiveAsUser;
  jobQueue.registerHandler<CleanupSessionOutputsPayload>(
    JOB_TYPES.CLEANUP_SESSION_OUTPUTS,
    async (payload) => {
      const { sessionId, scope, slug } = payload;
      let baseDir: string;
      try {
        baseDir = computeSessionDataBaseDir(getConfigDir(), scope, slug);
      } catch (err) {
        if (err instanceof InvalidSessionDataScopeError) {
          logger.error({ sessionId, scope, slug, err: err.message }, 'Invalid cleanup payload; skipping');
          return;
        }
        throw err;
      }
      const resolver = new SessionDataPathResolver(baseDir);
      logger.debug({ sessionId, scope, slug }, 'Executing cleanup:session-outputs job');
      await workerOutputFileManager.deleteSessionOutputs(sessionId, resolver);
      logger.info({ sessionId }, 'Session outputs cleanup completed');
    }
  );

  jobQueue.registerHandler<CleanupWorkerOutputPayload>(
    JOB_TYPES.CLEANUP_WORKER_OUTPUT,
    async (payload) => {
      const { sessionId, workerId, scope, slug } = payload;
      let baseDir: string;
      try {
        baseDir = computeSessionDataBaseDir(getConfigDir(), scope, slug);
      } catch (err) {
        if (err instanceof InvalidSessionDataScopeError) {
          logger.error(
            { sessionId, workerId, scope, slug, err: err.message },
            'Invalid cleanup payload; skipping'
          );
          return;
        }
        throw err;
      }
      const resolver = new SessionDataPathResolver(baseDir);
      logger.debug({ sessionId, workerId, scope, slug }, 'Executing cleanup:worker-output job');
      await workerOutputFileManager.deleteWorkerOutput(sessionId, workerId, resolver);
      logger.info({ sessionId, workerId }, 'Worker output cleanup completed');
    }
  );

  // In multi-user mode, `repoDir` may contain a `worktrees/*` subtree owned
  // by individual users; running `fs.rm` as the server process fails with
  // EACCES on the first user-owned descendant. When `requestUsername` is set
  // AND elevation applies (`shouldElevateForUser`), route the recursive
  // removal through `rmRecursiveAsUser` so it executes as that user. The
  // single-user / null / same-user path keeps the original direct `fs.rm`
  // (and its ENOENT idempotency).
  //
  // When `extraDir` is set (by the manager, only when the registered repo's
  // `path` lives under `getSourceReposDir()`), it is removed AFTER `repoDir`
  // succeeds -- if the main removal throws, `extraDir` is not attempted, so
  // a retry reprocesses both.
  //
  // The elevated branch routes through `rmRecursiveAsUser` rather than
  // inlining a `rm -rf` command here, mirroring how `lib/git.ts`
  // encapsulates git command construction.
  jobQueue.registerHandler<CleanupRepositoryPayload>(
    JOB_TYPES.CLEANUP_REPOSITORY,
    async ({ repoDir, requestUsername, extraDir }) => {
      const elevate = shouldElevateForUser(requestUsername);
      logger.debug(
        { repoDir, requestUsername, elevate, extraDir },
        'Executing cleanup:repository job',
      );

      /**
       * Remove one target with the elevation + ENOENT-idempotent contract
       * shared by both `repoDir` and `extraDir`. Closure captures `elevate`
       * and the elevated helper so both removals make the same decision and
       * surface the same shape of error to the job queue. Strict-thin-wrapper
       * contract is preserved: semantic interpretation (ENOENT-swallow on the
       * direct path, throw on elevated non-zero exit) lives here in the
       * handler, not in the privilege-elevation helper.
       */
      const removeOne = async (target: string): Promise<void> => {
        if (elevate) {
          let result: RunAsUserResult;
          try {
            result = await rmRecursiveAsUserImpl(target, requestUsername, {
              timeoutMs: CLEANUP_REPOSITORY_TIMEOUT_MS,
            });
          } catch (error) {
            // Spawn failure (e.g., sudo missing). Re-throw so the job queue
            // retries; we do NOT swallow this as ENOENT — the directory may
            // still exist.
            logger.error(
              { target, requestUsername, err: error },
              'cleanup:repository elevated rm spawn failed',
            );
            throw error;
          }

          if (result.timedOut || result.exitCode !== 0) {
            // `rm -rf` is idempotent on a missing path (POSIX contract: exit 0,
            // no stderr). Any non-zero exit therefore signals a real permission
            // / filesystem error; surface it so the job queue retries. The
            // helper itself stays strict — semantic interpretation is the
            // handler's job.
            const message = result.stderr.trim() || `exit code ${result.exitCode}`;
            logger.error(
              {
                target,
                requestUsername,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                stderr: result.stderr,
              },
              'cleanup:repository elevated rm returned non-zero',
            );
            throw new Error(`cleanup:repository elevated rm failed: ${message}`);
          }

          logger.info(
            { target, requestUsername },
            'Repository data cleanup completed (elevated)',
          );
          return;
        }

        try {
          await fs.rm(target, { recursive: true });
          logger.info({ target }, 'Repository data cleanup completed');
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            logger.debug(
              { target },
              'Repository directory does not exist, skipping cleanup',
            );
            return;
          }
          // Let other errors propagate to trigger job retry
          throw error;
        }
      };

      await removeOne(repoDir);
      if (extraDir != null) {
        await removeOne(extraDir);
      }
    }
  );

  logger.info('Job handlers registered');
}
