/**
 * Issue #1301 (T0b): the repository-in-use gate must protect a REAL paused
 * session, not merely exist as a mocked-callback assertion. This test uses
 * real cross-service wiring (`createTestContext`, the same pattern as
 * `__tests__/app-context.test.ts`) -- a real `RepositoryManager` and a real
 * `SessionManager` backed by a real (in-memory) SQLite database, wired
 * together via the production `setDependencyCallbacks` call.
 *
 * Flow: register a repo -> persist a paused worktree session for it (direct
 * DB write, mirroring what `SessionPauseResumeService.pauseSession` produces)
 * -> attempt unregister (expect refusal) -> resume the session and confirm
 * it comes back intact (no exception, still type 'worktree', its on-disk
 * location untouched). This proves the refusal actually protects something,
 * not just that it exists.
 *
 * Uses `setupMemfs`/`cleanupMemfs` (the same central mock registry
 * `repository-manager.test.ts` uses) rather than the real OS filesystem --
 * `fs` / `fs/promises` become process-globally mocked once any other server
 * test file in the same `bun test src/` run imports that helper, so relying
 * on the real filesystem here would be backing-store-dependent on file
 * execution order. See `.claude/rules/testing.md` Anti-Pattern #2.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';
import {
  createTestContext,
  shutdownAppContext,
  type AppContext,
} from '../../app-context.js';
import { RepositoryInUseError } from '../repository-manager.js';

const TEST_CONFIG_DIR = '/test/config';
const REPO_PATH = '/test/source-repo';
const WORKTREE_PATH = '/test/worktree';

describe('unregisterRepository refuses a repository with a paused session, and resume still works (Issue #1301, T0b)', () => {
  let appContext: AppContext | null = null;

  beforeEach(() => {
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      [`${WORKTREE_PATH}/.keep`]: '',
      ...createMockGitRepoFiles(REPO_PATH),
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
  });

  afterEach(async () => {
    if (appContext) {
      await shutdownAppContext(appContext);
      appContext = null;
    }
    cleanupMemfs();
  });

  it('refuses to unregister while a paused session is attached, and the session resumes cleanly afterward', async () => {
    appContext = await createTestContext();

    const repo = await appContext.repositoryManager.registerRepository(REPO_PATH);

    // Directly persist a paused worktree session for this repository --
    // mirrors the DB row `SessionPauseResumeService.pauseSession` produces
    // (serverPid: null, pausedAt set, not in memory). No workers, so
    // resume below never needs to spawn a real PTY.
    const sessionId = 'paused-worktree-session-1';
    await appContext.sessionRepository.save({
      id: sessionId,
      type: 'worktree',
      locationPath: WORKTREE_PATH,
      repositoryId: repo.id,
      worktreeId: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      workers: [],
      serverPid: null,
      pausedAt: '2026-01-01T00:05:00.000Z',
      dataScope: 'repository',
      dataScopeSlug: repo.name,
    });

    // The session is not active in memory (never went through
    // sessionManager.createSession / resumeSession), so only the
    // "inactive" callback should report it.
    expect(appContext.sessionManager.getSession(sessionId)).toBeUndefined();

    await expect(
      appContext.repositoryManager.unregisterRepository(repo.id),
    ).rejects.toBeInstanceOf(RepositoryInUseError);

    // Repository is still registered; nothing was destructively cleaned up.
    expect(appContext.repositoryManager.getRepository(repo.id)).toBeDefined();
    expect(fs.existsSync(WORKTREE_PATH)).toBe(true);

    // The session resumes cleanly -- proving the refusal protected a real,
    // usable session rather than just existing as a gate.
    const resumed = await appContext.sessionManager.resumeSession(sessionId);
    expect(resumed).not.toBeNull();
    expect(resumed!.id).toBe(sessionId);
    expect(resumed!.type).toBe('worktree');

    // The session's on-disk location is untouched throughout.
    expect(fs.existsSync(WORKTREE_PATH)).toBe(true);

    // Persisted state now reflects the active (resumed) session -- pausedAt
    // is cleared (the repository maps a NULL column to `undefined`).
    const persisted = await appContext.sessionRepository.findById(sessionId);
    expect(persisted).not.toBeNull();
    expect(persisted!.pausedAt).toBeUndefined();
  });
});
