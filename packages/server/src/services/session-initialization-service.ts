import * as fsPromises from 'fs/promises';
import * as path from 'path';
import type { PersistedSession } from './persistence-service.js';
import type { SessionRepository } from '../repositories/index.js';
import type { WorkerOutputFileManager } from '../lib/worker-output-file.js';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { InvalidSessionDataScopeError } from '../lib/session-data-path.js';
import type { JobQueue } from '../jobs/index.js';
import { JOB_TYPES } from '../jobs/index.js';
import { getConfigDir } from '../lib/config.js';
import { isProcessAlive, processKill } from '../lib/process-utils.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('session-initialization');

/** Callback to check if a session is already loaded in memory. */
type SessionInMemoryChecker = (id: string) => boolean;

/** Callback to check if a filesystem path exists. */
type PathExistsChecker = (path: string) => Promise<boolean>;

/** Callback to resolve a SessionDataPathResolver for a persisted session. */
type PersistedSessionPathResolverFactory = (persisted: PersistedSession) => SessionDataPathResolver;

/** Callback to compute a session's base directory; throws `InvalidSessionDataScopeError` on invalid metadata. */
type PersistedSessionBaseDirFactory = (persisted: PersistedSession) => string;

interface SessionInitializationDeps {
  sessionRepository: SessionRepository;
  pathExists: PathExistsChecker;
  isSessionInMemory: SessionInMemoryChecker;
  workerOutputFileManager: WorkerOutputFileManager;
  jobQueue: JobQueue | null;
  getPathResolverForPersistedSession: PersistedSessionPathResolverFactory;
  /** Pure base-dir computation. Used by the orphan detector — throws on invalid metadata. */
  baseDirForPersistedSession: PersistedSessionBaseDirFactory;
  getServerPid: () => number;
}

export class SessionInitializationService {
  constructor(private readonly deps: SessionInitializationDeps) {}

  /**
   * Initialize sessions from persistence and clean up orphan processes.
   *
   * Order of operations:
   *   1. Detect sessions with invalid/missing data-path metadata and mark them
   *      as `recoveryState='orphaned'`.
   *   2. Emit a one-time fragmentation report (informational only).
   *   3. Run the existing session initialization (kill dead-server workers,
   *      remove sessions whose locationPath is gone, prepare auto-resume).
   *   4. Clean up orphan processes from other dead servers.
   *
   * @returns Session IDs that were previously active and should be auto-resumed.
   *          Sessions with `recoveryState='orphaned'` are excluded.
   */
  async initialize(): Promise<string[]> {
    await this.detectOrphans();
    await this.fragmentationReport();
    const autoResumeSessionIds = await this.initializeSessions();
    await this.cleanupOrphanProcesses();
    return autoResumeSessionIds;
  }

  /**
   * Mark sessions whose persisted (scope, slug) pair cannot be resolved as
   * orphaned. Only durable metadata problems trigger marking — transient FS
   * errors do not (the helper is pure string manipulation).
   * See docs/design/session-data-path.md §8.
   */
  private async detectOrphans(): Promise<void> {
    const persistedSessions = await this.deps.sessionRepository.findAll();
    let healthy = 0;
    let orphaned = 0;
    const reasonsHistogram: Record<string, number> = {};

    for (const session of persistedSessions) {
      // Already marked orphan — count but don't re-mark.
      if (session.recoveryState === 'orphaned') {
        orphaned++;
        const reason = session.orphanedReason ?? 'unknown';
        reasonsHistogram[reason] = (reasonsHistogram[reason] ?? 0) + 1;
        continue;
      }

      try {
        this.deps.baseDirForPersistedSession(session);
        healthy++;
      } catch (err) {
        if (!(err instanceof InvalidSessionDataScopeError)) {
          // Unexpected error type — re-throw. Pure helper shouldn't raise anything else.
          throw err;
        }
        const reason = 'path_resolution_failed';
        try {
          await this.deps.sessionRepository.update(session.id, {
            recoveryState: 'orphaned',
            orphanedAt: Date.now(),
            orphanedReason: reason,
          });
        } catch (updateErr) {
          logger.error(
            { sessionId: session.id, err: updateErr },
            'Failed to mark session as orphaned'
          );
          continue;
        }
        orphaned++;
        reasonsHistogram[reason] = (reasonsHistogram[reason] ?? 0) + 1;
        logger.warn({ sessionId: session.id, reason, err: err.message }, 'Marked session orphaned');
      }
    }

    logger.info({ healthy, orphaned, reasonsHistogram }, 'Orphan detection completed');
  }

  /**
   * One-time informational scan for fragmented session-data directories.
   * Scans `<configDir>/_quick/outputs/` and `<configDir>/outputs/` (flat);
   * for each `sid` directory that corresponds to a DB session of type
   * 'worktree', logs a warn with `{ sessionId, path, size, mtime }`.
   * Never deletes or moves anything.
   * See docs/design/session-data-path.md §"One-time fragmentation report".
   */
  private async fragmentationReport(): Promise<void> {
    try {
      const configDir = getConfigDir();
      const persisted = await this.deps.sessionRepository.findAll();
      const worktreeIds = new Set(
        persisted.filter((s) => s.type === 'worktree').map((s) => s.id)
      );

      const candidates = [
        path.join(configDir, '_quick', 'outputs'),
        path.join(configDir, 'outputs'),
      ];

      for (const dir of candidates) {
        let entries: string[];
        try {
          entries = await fsPromises.readdir(dir);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') continue;
          logger.warn({ dir, err: e }, 'Failed to read fragmentation-report directory');
          continue;
        }
        for (const sid of entries) {
          if (!worktreeIds.has(sid)) continue;
          const full = path.join(dir, sid);
          try {
            const stat = await fsPromises.stat(full);
            logger.warn(
              { sessionId: sid, path: full, size: stat.size, mtime: stat.mtimeMs },
              'Fragmented worktree-session data directory detected'
            );
          } catch {
            // Ignore stat failures — this is informational only.
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Fragmentation report failed; continuing startup');
    }
  }

  /**
   * Process persisted sessions on startup.
   * Sessions whose serverPid is dead (or missing) are prepared for auto-resume:
   * orphan worker processes are killed, and the session is saved with serverPid=null
   * but pausedAt=null so it can be auto-resumed.
   * Sessions that were explicitly paused (pausedAt is set) remain paused.
   * Sessions owned by other live servers are left untouched.
   * Sessions whose locationPath no longer exists are removed as orphans.
   *
   * @returns Session IDs that should be auto-resumed (were active before server died).
   */
  private async initializeSessions(): Promise<string[]> {
    const persistedSessions = await this.deps.sessionRepository.findAll();
    const currentServerPid = this.deps.getServerPid();
    const sessionsToSave: PersistedSession[] = [];
    const orphanSessions: PersistedSession[] = [];
    const autoResumeSessionIds: string[] = [];
    let killedWorkerCount = 0;
    let pathNotFoundCount = 0;

    for (const session of persistedSessions) {
      // Skip if already in memory (shouldn't happen, but safety check)
      if (this.deps.isSessionInMemory(session.id)) continue;

      // Orphaned sessions: preserve in DB but never auto-resume.
      // They remain visible in the UI for manual deletion.
      if (session.recoveryState === 'orphaned') {
        sessionsToSave.push(session);
        continue;
      }

      // Paused sessions should remain paused until explicitly resumed.
      // Check pausedAt (definitive pause indicator) rather than serverPid === null,
      // because the DB mapper may convert null to undefined (#615).
      if (session.pausedAt) {
        sessionsToSave.push(session);
        continue;
      }

      // If serverPid is alive AND belongs to a different server, this session belongs to another active server
      // Keep it in persistence unchanged
      // Note: We must check serverPid !== currentServerPid to handle PID reuse by the OS.
      // If a previous server died and the OS reused its PID for this server, we should inherit the sessions.
      if (session.serverPid && session.serverPid !== currentServerPid && isProcessAlive(session.serverPid)) {
        sessionsToSave.push(session);
        continue;
      }

      // serverPid is dead or missing - validate path before inheriting
      // Validate that locationPath still exists before inheriting session
      const pathExistsResult = await this.deps.pathExists(session.locationPath);
      if (!pathExistsResult) {
        logger.warn({ sessionId: session.id, locationPath: session.locationPath },
          'Session path no longer exists, marking as orphan');
        orphanSessions.push(session);
        pathNotFoundCount++;
        continue;
      }

      // Kill any orphan worker processes first
      killedWorkerCount += SessionInitializationService.killOrphanWorkers(session);

      // Save with serverPid=null but pausedAt=undefined to indicate auto-resume target
      const { pausedAt: _removed, ...sessionWithoutPausedAt } = session;
      sessionsToSave.push({
        ...sessionWithoutPausedAt,
        serverPid: null,
      });
      autoResumeSessionIds.push(session.id);
    }

    // Delete orphan sessions (path no longer exists).
    // Note: the "orphan" term here refers to sessions whose locationPath is
    // gone — NOT the `recoveryState='orphaned'` lifecycle state (which is
    // preserved above, not deleted).
    for (const orphan of orphanSessions) {
      // Output-file cleanup requires a valid scope. Skip silently when missing.
      let resolver: SessionDataPathResolver | null = null;
      try {
        resolver = this.deps.getPathResolverForPersistedSession(orphan);
      } catch {
        resolver = null;
      }
      if (resolver) {
        try {
          await this.deps.workerOutputFileManager.deleteSessionOutputs(orphan.id, resolver);
        } catch (error) {
          logger.error({ sessionId: orphan.id, err: error }, 'Failed to delete worker output files for orphan session');
        }
      } else {
        logger.warn({ sessionId: orphan.id }, 'No resolver for orphan session; skipping output-file cleanup');
      }
      // Delete from database
      try {
        await this.deps.sessionRepository.delete(orphan.id);
        logger.info({ sessionId: orphan.id }, 'Removed orphan session with non-existent path');
      } catch (error) {
        logger.error({ sessionId: orphan.id, err: error }, 'Failed to delete orphan session from database');
      }
    }

    // Save all sessions (dead-server sessions prepared for auto-resume, others unchanged)
    if (sessionsToSave.length > 0 || persistedSessions.length > 0) {
      await this.deps.sessionRepository.saveAll(sessionsToSave);
    }

    logger.info({
      autoResumeSessions: autoResumeSessionIds.length,
      killedWorkerProcesses: killedWorkerCount,
      removedOrphanSessions: pathNotFoundCount,
      serverPid: currentServerPid,
    }, 'Initialized sessions from persistence');

    return autoResumeSessionIds;
  }

  /**
   * Kill orphan processes from previous server run and remove orphan sessions.
   * Sessions that have been loaded into memory are preserved.
   * Only sessions from OTHER dead servers are considered orphans.
   */
  private async cleanupOrphanProcesses(): Promise<void> {
    const persistedSessions = await this.deps.sessionRepository.findAll();
    const currentServerPid = this.deps.getServerPid();
    let killedCount = 0;
    let preservedCount = 0;
    const orphanSessions: PersistedSession[] = [];

    for (const session of persistedSessions) {
      // Skip sessions that this server has inherited (already in memory)
      if (this.deps.isSessionInMemory(session.id)) {
        preservedCount++;
        continue;
      }

      if (!session.serverPid) {
        logger.warn({ sessionId: session.id }, 'Session has no serverPid (legacy session), skipping cleanup');
        preservedCount++;
        continue;
      }

      if (isProcessAlive(session.serverPid)) {
        preservedCount++;
        continue;
      }

      // This session's server is dead AND not inherited by this server - mark for removal
      orphanSessions.push(session);

      // Kill all workers in this session (only PTY workers have pid)
      killedCount += SessionInitializationService.killOrphanWorkers(session);
    }

    // Remove orphan sessions from persistence and delete output files
    if (orphanSessions.length > 0) {
      // Verify jobQueue is available for cleanup operations
      if (!this.deps.jobQueue) {
        throw new Error('JobQueue not available for orphan session cleanup. Ensure jobQueue is passed to SessionManager.create().');
      }
      for (const orphan of orphanSessions) {
        await this.deps.sessionRepository.delete(orphan.id);
        // Delete output files for orphan session via job queue; skip if scope missing.
        const scope = orphan.type === 'quick'
          ? { scope: 'quick' as const, slug: null }
          : (orphan.dataScope
            ? { scope: orphan.dataScope, slug: orphan.dataScopeSlug ?? null }
            : null);
        if (scope) {
          await this.deps.jobQueue.enqueue(JOB_TYPES.CLEANUP_SESSION_OUTPUTS, {
            sessionId: orphan.id,
            scope: scope.scope,
            slug: scope.slug,
          });
        } else {
          logger.warn({ sessionId: orphan.id }, 'No valid scope for orphan session; skipping output cleanup');
        }
        logger.info({ sessionId: orphan.id }, 'Removed orphan session from persistence');
      }
    }

    logger.info({
      killedProcesses: killedCount,
      removedSessions: orphanSessions.length,
      preservedSessions: preservedCount,
      serverPid: currentServerPid,
    }, 'Orphan cleanup completed');
  }

  /**
   * Kill orphan worker processes for a session.
   * Returns the number of workers successfully killed.
   */
  static killOrphanWorkers(session: PersistedSession): number {
    let killedCount = 0;
    for (const worker of session.workers) {
      // Skip git-diff workers (no process) and workers with no pid (not yet activated)
      if (worker.type === 'git-diff' || worker.pid === null) continue;

      if (isProcessAlive(worker.pid)) {
        try {
          processKill(worker.pid, 'SIGTERM');
          logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker process');
          killedCount++;
        } catch (error) {
          logger.error({ pid: worker.pid, workerId: worker.id, sessionId: session.id, err: error }, 'Failed to kill orphan worker with SIGTERM');
          // Try SIGKILL as fallback for stubborn processes
          try {
            processKill(worker.pid, 'SIGKILL');
            logger.info({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Killed orphan worker with SIGKILL');
            killedCount++;
          } catch {
            // Process may have exited between checks, log but continue
            logger.warn({ pid: worker.pid, workerId: worker.id, sessionId: session.id }, 'Failed to kill orphan worker (process may have already exited)');
          }
        }
      }
    }
    return killedCount;
  }
}
