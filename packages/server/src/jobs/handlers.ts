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
  runAsUser as defaultRunAsUser,
  shellEscape,
  shouldElevateForUser,
  type RunAsUserOpts,
  type RunAsUserResult,
} from '../services/privilege-elevation.js';

const logger = createLogger('job-handlers');

/**
 * Type of the privilege-elevation helper, mirrored from
 * `repository-manager.ts` so tests can inject a fake without importing
 * `Bun.spawn`. Production callers use the real `runAsUser`.
 * @internal Exported for testing.
 */
export type RunAsUserFn = (opts: RunAsUserOpts) => Promise<RunAsUserResult>;

/**
 * Optional dependencies injected by tests. Defaults bind to the real
 * `runAsUser`; production callers omit this argument.
 */
export interface JobHandlerDeps {
  runAsUserImpl?: RunAsUserFn;
}

/**
 * Register all job handlers with the job queue.
 * @param jobQueue The JobQueue instance to register handlers with
 * @param workerOutputFileManager Manager used by output-cleanup handlers
 * @param deps Test-only dependency injection. Production callers omit.
 */
export function registerJobHandlers(
  jobQueue: JobQueue,
  workerOutputFileManager: WorkerOutputFileManager,
  deps: JobHandlerDeps = {},
): void {
  const runAsUserImpl: RunAsUserFn = deps.runAsUserImpl ?? defaultRunAsUser;
  // Handler for deleting all output files for a session
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

  // Handler for deleting output file for a single worker
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

  // Handler for removing repository data directory.
  //
  // Issue #884: in `AUTH_MODE=multi-user`, `repoDir` contains a `worktrees/*`
  // subtree owned by individual users (Issue #838 / PR #843). The historical
  // direct `fs.rm` here ran as the server process (`agentconsole`) and failed
  // with `EACCES` on the first user-owned descendant, surfacing as the
  // silent-unregister symptom reported in Issue #871. When `requestUsername`
  // is set AND elevation actually applies (`shouldElevateForUser`), route the
  // recursive removal through `runAsUser` so it executes as that user.
  // Single-user / null / same-user preserves the original direct `fs.rm` path.
  jobQueue.registerHandler<CleanupRepositoryPayload>(
    JOB_TYPES.CLEANUP_REPOSITORY,
    async ({ repoDir, requestUsername }) => {
      const elevate = shouldElevateForUser(requestUsername);
      logger.debug({ repoDir, requestUsername, elevate }, 'Executing cleanup:repository job');

      if (elevate) {
        // runAsUser pins the outer spawn to `/` via SUDO_NEUTRAL_CWD, so we
        // do NOT need to pass `cwd` here -- `rm -rf -- <repoDir>` operates on
        // an absolute path. `--` guards the rare case where repoDir starts
        // with `-`. `repoDir` is server-controlled (built from
        // `getRepositoryDir(orgRepo)`), but shellEscape is cheap insurance
        // against any future drift in how that path is composed.
        const command = `rm -rf -- ${shellEscape(repoDir)}`;
        let result: RunAsUserResult;
        try {
          result = await runAsUserImpl({
            username: requestUsername,
            command,
          });
        } catch (error) {
          // Spawn failure (e.g., sudo missing). Re-throw so the job queue
          // retries; we do NOT swallow this as ENOENT — the directory may
          // still exist.
          logger.error({ repoDir, requestUsername, err: error }, 'cleanup:repository elevated rm spawn failed');
          throw error;
        }

        if (result.timedOut || result.exitCode !== 0) {
          // `rm -rf` is idempotent on a missing path -- exit 0, no stderr.
          // Any non-zero exit therefore signals a real permission /
          // filesystem error; surface it so the job queue retries.
          const message = result.stderr.trim() || `exit code ${result.exitCode}`;
          logger.error(
            { repoDir, requestUsername, exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr },
            'cleanup:repository elevated rm returned non-zero',
          );
          throw new Error(`cleanup:repository elevated rm failed: ${message}`);
        }

        logger.info({ repoDir, requestUsername }, 'Repository data cleanup completed (elevated)');
        return;
      }

      try {
        await fs.rm(repoDir, { recursive: true });
        logger.info({ repoDir }, 'Repository data cleanup completed');
      } catch (error) {
        // Handle ENOENT (file not found) gracefully - directory already gone
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          logger.debug({ repoDir }, 'Repository directory does not exist, skipping cleanup');
          return;
        }
        // Let other errors propagate to trigger job retry
        throw error;
      }
    }
  );

  logger.info('Job handlers registered');
}
