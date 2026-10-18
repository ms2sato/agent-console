import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import type { Worktree } from '@agent-console/shared';
import type { WorktreeRepository, WorktreeRecord } from '../../repositories/worktree-repository.js';
import type { RunAsUserOpts, RunAsUserResult } from '../privilege-elevation.js';
import { WORKTREE_ADD_PERMISSION_HINT_HEADER } from '../../lib/git-error-hints.js';
import { rootLogger } from '../../lib/logger.js';

/**
 * Capture-and-respond fake for `runAsUser`. The worktree-service routes
 * `git worktree add` (and the per-user `safe.directory` bootstrap on the
 * elevated path) through `runAsUser`, so tests inject this fake via the
 * `runAsUserImpl` constructor option and assert on the captured opts.
 *
 * Default response: success (exitCode 0, empty stdout/stderr). Per-test
 * scenarios can replace the responder via `responder.fn = ...`.
 */
function createRunAsUserMock() {
  const calls: RunAsUserOpts[] = [];
  const responder = {
    fn: async (_opts: RunAsUserOpts): Promise<RunAsUserResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false, cwdFailed: false,
    }),
  };
  const runAsUserImpl = (opts: RunAsUserOpts) => {
    calls.push(opts);
    return responder.fn(opts);
  };
  return { calls, runAsUserImpl, responder };
}

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

let importCounter = 0;

// Mock Bun.spawn for executeHookCommand tests
let mockSpawnResult: {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

const originalBunSpawn = Bun.spawn;
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];

// Helper to set mock spawn result
function setMockSpawnResult(stdout: string, exitCode = 0, stderr = '') {
  mockSpawnResult = {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
  };
}

/**
 * Create an in-memory mock WorktreeRepository for testing.
 * Stores records in a plain array, avoiding any database dependency.
 */
function createMockWorktreeRepository(): WorktreeRepository & { records: WorktreeRecord[] } {
  const records: WorktreeRecord[] = [];
  return {
    records,
    async findByRepositoryId(repositoryId: string) {
      return records.filter(r => r.repositoryId === repositoryId);
    },
    async findByPath(path: string) {
      return records.find(r => r.path === path) ?? null;
    },
    async save(record: WorktreeRecord) {
      records.push(record);
    },
    async deleteByPath(path: string) {
      const idx = records.findIndex(r => r.path === path);
      if (idx >= 0) records.splice(idx, 1);
    },
  };
}

describe('WorktreeService', () => {
  let mockRepo: ReturnType<typeof createMockWorktreeRepository>;
  // Top-level capture mock for `runAsUser`. All sub-describes share the
  // same instance; the top-level beforeEach creates a fresh one per test.
  let runAsUserMock: ReturnType<typeof createRunAsUserMock>;

  beforeEach(() => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Create fresh mock repository for each test
    mockRepo = createMockWorktreeRepository();
    // Fresh runAsUser capture for each test (default: success response).
    runAsUserMock = createRunAsUserMock();

    // Reset mocks. `createWorktree` is no longer mocked at the lib/git layer
    // because the service now routes through `runAsUser` -- the
    // `runAsUserMock` defined above is the capture point for the create path.
    mockGit.deriveRepositorySlug.mockReset();
    mockGit.listWorktrees.mockReset();
    mockGit.removeWorktree.mockReset();
    mockGit.listLocalBranches.mockReset();
    mockGit.listRemoteBranches.mockReset();
    mockGit.getDefaultBranch.mockReset();

    // Default implementations
    mockGit.deriveRepositorySlug.mockImplementation(() => Promise.resolve('owner/repo-name'));
    mockGit.listWorktrees.mockImplementation(() => Promise.resolve(`worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /worktrees/feature-1
HEAD def456
branch refs/heads/feature-1
`));
    mockGit.removeWorktree.mockImplementation(() => Promise.resolve());
    mockGit.listLocalBranches.mockImplementation(() => Promise.resolve(['main', 'feature-1', 'feature-2']));
    mockGit.listRemoteBranches.mockImplementation(() => Promise.resolve(['origin/main', 'origin/develop']));
    mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
  });

  afterEach(() => {
    cleanupMemfs();
  });

  // Helper to get fresh module instance
  async function getWorktreeService() {
    const module = await import(`../worktree-service.js?v=${++importCounter}`);
    return module.WorktreeService;
  }

  describe('listWorktrees', () => {
    it('should only return main worktree and worktrees registered in DB', async () => {
      // Register one worktree in the mock repository
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const { worktrees, pathStatus } = await service.listWorktrees('/repo/main', 'repo-1');

      expect(pathStatus).toBe('ok');
      expect(worktrees.length).toBe(2);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].branch).toBe('main');
      expect(worktrees[0].isMain).toBe(true);
      expect(worktrees[0].index).toBeUndefined();

      expect(worktrees[1].path).toBe('/worktrees/feature-1');
      expect(worktrees[1].branch).toBe('feature-1');
      expect(worktrees[1].isMain).toBe(false);
      expect(worktrees[1].index).toBe(1);
    });

    it('should filter out worktrees not registered in DB', async () => {
      // No records in mock repository - only main worktree should be returned
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const { worktrees } = await service.listWorktrees('/repo/main', 'repo-1');

      // Only main worktree should be returned
      expect(worktrees.length).toBe(1);
      expect(worktrees[0].path).toBe('/repo/main');
      expect(worktrees[0].isMain).toBe(true);
    });

    it('should handle detached HEAD worktree', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(`worktree /repo/main
HEAD abc1234567890
detached
`));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const { worktrees } = await service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const { worktrees } = await service.listWorktrees('/repo', 'repo-1');
      expect(worktrees).toEqual([]);
    });

    it('should include orphaned worktrees (in DB but not in git)', async () => {
      // Add DB record for a worktree that will not appear in git output
      mockRepo.records.push({
        id: 'wt-orphaned',
        repositoryId: 'repo-1',
        path: '/worktrees/orphaned-1',
        indexNumber: 2,
        createdAt: new Date().toISOString(),
      });
      // Also add a normal registered worktree
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });
      const { worktrees } = await service.listWorktrees('/repo/main', 'repo-1');

      // Should include: main + feature-1 (from git) + orphaned-1 (from DB only)
      expect(worktrees.length).toBe(3);
      const orphaned = worktrees.find((wt: Worktree) => wt.path === '/worktrees/orphaned-1');
      expect(orphaned).toBeDefined();
      expect(orphaned!.branch).toBe('(orphaned)');
      expect(orphaned!.index).toBe(2);
    });
  });

  // A bare source repository: `git worktree list --porcelain` lists the bare
  // directory FIRST as a lone `bare` entry (no HEAD, no branch), then the linked
  // worktrees. The bare entry is not a worktree and must not count as the first
  // entry, so on a bare repository NO row is `isMain` (the main-worktree rule is
  // a later phase; promoting the first linked worktree would pre-empt it).
  // Mutation: drop the bare skip in `parsePorcelainOutput` -> the bare dir
  // surfaces as a branchless `isMain` row and the first test fails.
  describe('listWorktrees on a bare repository', () => {
    const bareHeader = (p: string) => `worktree ${p}\nbare\n`;
    const linked = (p: string, b: string) => `worktree ${p}\nHEAD abc123\nbranch refs/heads/${b}\n`;

    async function listWith(porcelain: string, records: Array<{ path: string; index: number }> = []) {
      for (const r of records) {
        mockRepo.records.push({
          id: `wt-${r.index}`,
          repositoryId: 'repo-1',
          path: r.path,
          indexNumber: r.index,
          createdAt: new Date().toISOString(),
        });
      }
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(porcelain));
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });
      return (await service.listWorktrees('/srv/source-repos/bare.git', 'repo-1')).worktrees;
    }

    it('skips the bare entry: two linked worktrees give two rows, both isMain=false, indexes from the DB records', async () => {
      fs.mkdirSync('/srv/source-repos/bare.git', { recursive: true });
      fs.mkdirSync('/srv/wt/a', { recursive: true });
      fs.mkdirSync('/srv/wt/b', { recursive: true });
      const output = [bareHeader('/srv/source-repos/bare.git'), linked('/srv/wt/a', 'feat-a'), linked('/srv/wt/b', 'feat-b')].join('\n');

      const worktrees = await listWith(output, [
        { path: '/srv/wt/a', index: 1 },
        { path: '/srv/wt/b', index: 2 },
      ]);

      expect(worktrees).toEqual([
        { path: '/srv/wt/a', branch: 'feat-a', isMain: false, repositoryId: 'repo-1', index: 1 },
        { path: '/srv/wt/b', branch: 'feat-b', isMain: false, repositoryId: 'repo-1', index: 2 },
      ]);
      expect(worktrees.some((wt: Worktree) => wt.path === '/srv/source-repos/bare.git')).toBe(false);
    });

    it('a bare repository with no linked worktrees lists nothing', async () => {
      const worktrees = await listWith(bareHeader('/srv/source-repos/bare.git'));
      expect(worktrees).toEqual([]);
    });

    it('control: a non-bare listing is unchanged -- the first entry is still the main worktree', async () => {
      fs.mkdirSync('/srv/repo', { recursive: true });
      const output = [linked('/srv/repo', 'main'), linked('/srv/wt/a', 'feat-a')].join('\n');
      fs.mkdirSync('/srv/wt/a', { recursive: true });

      const worktrees = await listWith(output, [{ path: '/srv/wt/a', index: 1 }]);

      expect(worktrees).toHaveLength(2);
      expect(worktrees[0]).toMatchObject({ path: '/srv/repo', isMain: true, branch: 'main' });
      expect(worktrees[1]).toMatchObject({ path: '/srv/wt/a', isMain: false, index: 1 });
    });
  });

  // Path identity: git prints realpaths while the repository path stored by
  // the app is only `path.resolve`d, so the two can differ by a symlinked
  // segment or a rename. The main worktree is the first porcelain entry, and
  // DB records are matched by canonical path.
  describe('listWorktrees path identity', () => {
    const porcelain = (...entries: Array<[string, string]>) =>
      entries.map(([p, b]) => `worktree ${p}\nHEAD abc123\nbranch refs/heads/${b}\n`).join('\n');

    function makeRealTree() {
      fs.mkdirSync('/real/repo/main', { recursive: true });
      fs.mkdirSync('/real/worktrees/feature-1', { recursive: true });
      fs.symlinkSync('/real', '/link');
    }

    async function listWith(repoPath: string) {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });
      return (await service.listWorktrees(repoPath, 'repo-1')).worktrees;
    }

    // (1) Measured reach: restoring `isMain = worktreePath === mainRepoPath`
    // drops the main worktree here (no DB record, not "main") and fails this.
    it('(1) surfaces the main worktree when the stored path is a symlink to what git printed', async () => {
      makeRealTree();
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(porcelain(['/real/repo/main', 'main'])));

      const worktrees = await listWith('/link/repo/main');

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toMatchObject({ path: '/real/repo/main', isMain: true, branch: 'main' });
    });

    // (2) Measured reach: keying the record map by the raw record path (no
    // canonicaliser) drops the registered worktree AND lists it again as an
    // orphan.
    it('(2) matches a DB record stored under a symlinked path: one entry with its index, not dropped and not also orphaned', async () => {
      makeRealTree();
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/link/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });
      mockGit.listWorktrees.mockImplementation(() =>
        Promise.resolve(porcelain(['/real/repo/main', 'main'], ['/real/worktrees/feature-1', 'feature-1'])),
      );

      const worktrees = await listWith('/link/repo/main');

      expect(worktrees).toHaveLength(2);
      const linked = worktrees.filter((wt: Worktree) => !wt.isMain);
      expect(linked).toEqual([
        { path: '/real/worktrees/feature-1', branch: 'feature-1', isMain: false, repositoryId: 'repo-1', index: 1 },
      ]);
      expect(worktrees.some((wt: Worktree) => wt.branch === '(orphaned)')).toBe(false);
    });

    it('still lists a record whose directory git no longer knows as an orphan, under its stored path', async () => {
      makeRealTree();
      mockRepo.records.push({
        id: 'wt-gone',
        repositoryId: 'repo-1',
        path: '/link/worktrees/gone',
        indexNumber: 3,
        createdAt: new Date().toISOString(),
      });
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(porcelain(['/real/repo/main', 'main'])));

      const worktrees = await listWith('/link/repo/main');

      expect(worktrees.find((wt: Worktree) => wt.branch === '(orphaned)')).toMatchObject({ path: '/link/worktrees/gone', index: 3 });
    });

    it('(4) treats the first entry as main when the stored path differs only by a trailing slash', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(porcelain(['/repo/main', 'main'])));

      const worktrees = await listWith('/repo/main/');

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toMatchObject({ path: '/repo/main', isMain: true });
    });

    it('treats the first entry as main even when the repository directory was renamed (stored path shares nothing with git\'s)', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.resolve(porcelain(['/new/name', 'main'])));

      const worktrees = await listWith('/old/name');

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toMatchObject({ path: '/new/name', isMain: true });
    });

    it('marks only the first entry as main', async () => {
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const worktrees = await listWith('/some/other/path');

      expect(worktrees.map((wt: Worktree) => wt.isMain)).toEqual([true, false]);
    });
  });

  describe('listWorktrees missing repository path', () => {
    // The service logger is a child created at import time, so the spy on
    // `rootLogger.child` is installed before the fresh module import and
    // returns a recording stand-in for the service's own logger only.
    async function listWithRecordingLogger(repoPath: string, gitError: Error) {
      const warns: unknown[][] = [];
      const errors: unknown[][] = [];
      const original = rootLogger.child.bind(rootLogger);
      const childSpy = spyOn(rootLogger, 'child').mockImplementation(((bindings: { service?: string }) => {
        if (bindings?.service !== 'worktree-service') return original(bindings);
        return new Proxy({} as Record<string, unknown>, {
          get: (_t, prop) => {
            if (prop === 'warn') return (...args: unknown[]) => warns.push(args);
            if (prop === 'error') return (...args: unknown[]) => errors.push(args);
            return () => {};
          },
        });
      }) as unknown as typeof rootLogger.child);
      try {
        mockGit.listWorktrees.mockImplementation(() => Promise.reject(gitError));
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });
        const result = await service.listWorktrees(repoPath, 'repo-1');
        return { result, warns, errors };
      } finally {
        childSpy.mockRestore();
      }
    }

    it('returns [] and warns "repository path missing" when the directory does not exist', async () => {
      const { result, warns, errors } = await listWithRecordingLogger('/gone/repo', new Error('not a git repository'));

      expect(result).toEqual({ worktrees: [], pathStatus: 'missing' });
      expect(errors).toHaveLength(0);
      expect(warns).toHaveLength(1);
      expect(warns[0]![0]).toMatchObject({ repoPath: '/gone/repo', reason: 'repository path missing' });
      expect(String(warns[0]![1])).toContain('repository path missing');
    });

    it('warns "repository path inaccessible" (not "missing") when the directory exists but cannot be read', async () => {
      fs.mkdirSync('/locked/repo', { recursive: true });
      const accessSpy = spyOn(fs.promises, 'access').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })));
      try {
        const { result, warns, errors } = await listWithRecordingLogger('/locked/repo', new Error('not a git repository'));

        expect(result).toEqual({ worktrees: [], pathStatus: 'inaccessible' });
        expect(errors).toHaveLength(0);
        expect(warns).toHaveLength(1);
        expect(warns[0]![0]).toMatchObject({ repoPath: '/locked/repo', reason: 'repository path inaccessible' });
        expect(String(warns[0]![1])).toContain('repository path inaccessible');
        expect(String(warns[0]![1])).not.toContain('repository path missing');
      } finally {
        accessSpy.mockRestore();
      }
    });

    it('still logs an error (not the missing-path warning) when the directory exists and git fails', async () => {
      fs.mkdirSync('/exists/repo', { recursive: true });

      const { result, warns, errors } = await listWithRecordingLogger('/exists/repo', new Error('git exploded'));

      // Listing failed on a readable directory: the notice must not claim the
      // path is the problem, so the status stays 'ok' with an empty list.
      expect(result).toEqual({ worktrees: [], pathStatus: 'ok' });
      expect(warns).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]![0]).toMatchObject({ repoPath: '/exists/repo' });
    });
  });

  describe('isWorktreeOf path identity', () => {
    async function makeService() {
      const WorktreeService = await getWorktreeService();
      return new WorktreeService({ worktreeRepository: mockRepo });
    }

    // Measured reach: restoring `worktreePath === repoPath` fails the first.
    it('treats the main worktree as valid across a symlinked stored path', async () => {
      fs.mkdirSync('/real/repo/main', { recursive: true });
      fs.symlinkSync('/real', '/link');
      const service = await makeService();

      expect(await service.isWorktreeOf('/link/repo/main', '/real/repo/main', 'repo-1')).toBe(true);
      expect(await service.isWorktreeOf('/real/repo/main', '/link/repo/main', 'repo-1')).toBe(true);
    });

    it('still rejects an unknown path', async () => {
      fs.mkdirSync('/real/repo/main', { recursive: true });
      const service = await makeService();

      expect(await service.isWorktreeOf('/real/repo/main', '/real/repo/elsewhere', 'repo-1')).toBe(false);
    });

    it('still accepts a DB-registered worktree of the same repository by exact stored path, and rejects another repository\'s', async () => {
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });
      const service = await makeService();

      expect(await service.isWorktreeOf('/repo/main', '/worktrees/feature-1', 'repo-1')).toBe(true);
      expect(await service.isWorktreeOf('/repo/main', '/worktrees/feature-1', 'repo-2')).toBe(false);
    });
  });

  describe('verifyRepoAccessible', () => {
    // Unlike `listWorktrees` (which swallows GitError and returns `[]` for
    // UI listing callers), `verifyRepoAccessible` must propagate the
    // underlying GitError so the pre-create probe in
    // `createWorktreeWithSession` can surface stderr to the operator
    // (Issue #854).
    it('propagates GitError instead of swallowing it', async () => {
      const cause = new GitError(
        'git worktree failed: fatal: detected dubious ownership in repository',
        128,
        "fatal: detected dubious ownership in repository at '/repo'",
      );
      mockGit.listWorktrees.mockImplementation(() => Promise.reject(cause));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.verifyRepoAccessible('/repo');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBe(cause);
      expect(caught).toBeInstanceOf(GitError);
    });

    it('resolves with no value when git accepts the repo', async () => {
      // The top-level beforeEach already wires `mockGit.listWorktrees` to a
      // resolving implementation; the probe should resolve to undefined.
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.verifyRepoAccessible('/repo/main');
      expect(result).toBeUndefined();
    });
  });

  describe('ensureRepoHasCommits (Issue #921)', () => {
    // Pre-check that surfaces an actionable domain error when the source
    // repo has no commits on ANY ref. Wraps `git rev-list --all --count`: a
    // count of 0 becomes an EmptyRepositoryError with a fixed user-facing
    // message; every git failure (e.g. dubious ownership) propagates
    // unchanged. A repo with an unborn HEAD but fetched remote refs counts
    // as non-empty.
    let originalAuthMode: string | undefined;

    beforeEach(() => {
      mockGit.git.mockReset();
      // Default: `rev-list --all --count` reports one reachable commit.
      // Individual tests override to exercise the empty-repo and failure
      // branches.
      mockGit.git.mockImplementation(() => Promise.resolve('1\n'));
      // Default single-user environment (no elevation, no safe.directory
      // bootstrap). The multi-user test opts in explicitly.
      originalAuthMode = process.env.AUTH_MODE;
      delete process.env.AUTH_MODE;
    });

    afterEach(() => {
      if (originalAuthMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalAuthMode;
      }
    });

    it('throws EmptyRepositoryError with the exact user-facing message when no ref has a commit ("0\\n")', async () => {
      // Bare `git init`: `git rev-list --all --count` prints 0.
      mockGit.git.mockImplementation(() => Promise.resolve('0\n'));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const { EmptyRepositoryError, EMPTY_REPOSITORY_ERROR_MESSAGE } =
        await import(`../worktree-service.js?v=${importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.ensureRepoHasCommits('/repo/empty');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(EmptyRepositoryError);
      expect((caught as Error).message).toBe(EMPTY_REPOSITORY_ERROR_MESSAGE);
      // The exact string must not drift silently -- the user-facing contract.
      expect((caught as Error).message).toBe(
        'The source repository has no commits yet. Create at least one commit (an empty commit is fine: git commit --allow-empty -m "initial commit") in the source repo before creating a worktree.',
      );
    });

    it('resolves for a repo with an unborn HEAD but fetched remote refs (rev-list --all counts them)', async () => {
      // The case the HEAD-only check wrongly rejected: `git init` +
      // `git fetch origin` leaves HEAD unborn, yet `git worktree add -b x
      // <path> origin/main` works. `--all` sees the fetched refs.
      mockGit.git.mockImplementation(() => Promise.resolve('3\n'));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await expect(service.ensureRepoHasCommits('/repo/fetched-only')).resolves.toBeUndefined();
    });

    it.each([
      ['"1" (no trailing newline)', '1'],
      ['"1\\n"', '1\n'],
    ])('resolves for the single-commit boundary %s', async (_label, stdout) => {
      mockGit.git.mockImplementation(() => Promise.resolve(stdout));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await expect(service.ensureRepoHasCommits('/repo/one')).resolves.toBeUndefined();
    });

    it('throws EmptyRepositoryError for "0" without a trailing newline', async () => {
      mockGit.git.mockImplementation(() => Promise.resolve('0'));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const { EmptyRepositoryError } = await import(`../worktree-service.js?v=${importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await expect(service.ensureRepoHasCommits('/repo/empty')).rejects.toBeInstanceOf(EmptyRepositoryError);
    });

    it.each([
      ['empty stdout', ''],
      ['garbage stdout', 'not-a-number\n'],
      ['negative number', '-1\n'],
      ['multi-line stdout', '3\n4\n'],
    ])('propagates an unparsable count (%s) as a plain Error, never EmptyRepositoryError', async (_label, stdout) => {
      mockGit.git.mockImplementation(() => Promise.resolve(stdout));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const { EmptyRepositoryError } = await import(`../worktree-service.js?v=${importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.ensureRepoHasCommits('/repo');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(EmptyRepositoryError);
      expect((caught as Error).message).toContain('rev-list --all --count');
    });

    it('propagates a non-zero-exit GitError unchanged (not EmptyRepositoryError)', async () => {
      const gitErr = new GitError('git rev-list failed: fatal: not a git repository', 128, 'fatal: not a git repository');
      mockGit.git.mockImplementation(() => Promise.reject(gitErr));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const { EmptyRepositoryError } = await import(`../worktree-service.js?v=${importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.ensureRepoHasCommits('/repo');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBe(gitErr);
      expect(caught).not.toBeInstanceOf(EmptyRepositoryError);
    });

    it('propagates non-GitError unchanged', async () => {
      // Only GitError is translated to EmptyRepositoryError; other errors
      // (e.g. spawn failure) surface verbatim so operators see the real
      // cause.
      const cause = new Error('spawn crashed');
      mockGit.git.mockImplementation(() => Promise.reject(cause));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.ensureRepoHasCommits('/repo');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBe(cause);
    });

    it('forwards null requestUsername to git() (single-user branch)', async () => {
      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.ensureRepoHasCommits('/repo/main');

      // 4th positional arg (`requestUser`) should be undefined when the
      // caller does not provide it. This is the single-user code path --
      // `git()` uses its direct-spawn branch.
      expect(mockGit.git).toHaveBeenCalledWith(
        ['rev-list', '--all', '--count'],
        '/repo/main',
        undefined,
        undefined,
      );
    });

    it('forwards non-null requestUsername to git() (multi-user branch)', async () => {
      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.ensureRepoHasCommits('/repo/main', 'alice');

      // 4th positional arg is the request username, routed through
      // `git()` -> `runAsUser` so the pre-check observes the same repo
      // state as the subsequent `git worktree add`.
      expect(mockGit.git).toHaveBeenCalledWith(
        ['rev-list', '--all', '--count'],
        '/repo/main',
        undefined,
        'alice',
      );
    });

    it('re-throws a GitError (dubious ownership) unchanged instead of masking it as EmptyRepositoryError', async () => {
      // Single-user path (no requestUsername -> no bootstrap). A dubious
      // ownership failure is NOT an unborn HEAD; the caller must see the real
      // cause, not the empty-repository message.
      const gitErr = new GitError(
        "git rev-list failed: fatal: detected dubious ownership in repository at '/repo'",
        128,
        "fatal: detected dubious ownership in repository at '/repo'",
      );
      mockGit.git.mockImplementation(() => Promise.reject(gitErr));

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const { EmptyRepositoryError, EMPTY_REPOSITORY_ERROR_MESSAGE } =
        await import(`../worktree-service.js?v=${importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.ensureRepoHasCommits('/repo');
      } catch (err) {
        caught = err;
      }

      // The original GitError propagates: same instance, GitError (not
      // EmptyRepositoryError), and the empty-repository message never appears.
      expect(caught).toBe(gitErr);
      expect(caught).toBeInstanceOf(GitError);
      expect(caught).not.toBeInstanceOf(EmptyRepositoryError);
      expect((caught as Error).message).toContain('dubious ownership');
      expect((caught as Error).message).not.toBe(EMPTY_REPOSITORY_ERROR_MESSAGE);
    });

    it('bootstraps safe.directory BEFORE the rev-list pre-check on the multi-user first-time flow', async () => {
      // First-time multi-user user: the server-owned source repo has no
      // safe.directory entry yet, so a rev-list as that user fails with
      // dubious ownership UNTIL the bootstrap runs. The pre-check must run the
      // bootstrap first, after which rev-list succeeds and no error surfaces.
      process.env.AUTH_MODE = 'multi-user';

      const events: string[] = [];
      let bootstrapped = false;

      runAsUserMock.responder.fn = async (opts) => {
        if (opts.command.includes('safe.directory')) {
          bootstrapped = true;
          events.push('bootstrap');
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
      };

      mockGit.git.mockImplementation(() => {
        events.push('rev-list');
        if (!bootstrapped) {
          return Promise.reject(
            new GitError(
              "git rev-list failed: fatal: detected dubious ownership in repository at '/repo'",
              128,
              "fatal: detected dubious ownership in repository at '/repo'",
            ),
          );
        }
        return Promise.resolve('1\n');
      });

      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      // Resolves without throwing because the bootstrap fixes the ownership
      // check before the rev-list runs.
      const result = await service.ensureRepoHasCommits('/repo', 'alice-multiuser-test');
      expect(result).toBeUndefined();

      // Ordering: the bootstrap MUST precede the rev-list pre-check.
      expect(events).toEqual(['bootstrap', 'rev-list']);

      // The captured bootstrap call ran as the requesting user with the
      // repo path in the safe.directory command.
      const bootstrapCall = runAsUserMock.calls.find((c) => c.command.includes('safe.directory'));
      expect(bootstrapCall).toBeDefined();
      expect(bootstrapCall!.username).toBe('alice-multiuser-test');
      expect(bootstrapCall!.command).toContain("'/repo'");
    });

    it('does not run the safe.directory bootstrap on the single-user path', async () => {
      // No AUTH_MODE=multi-user, no requestUsername -> elevation is bypassed,
      // so the bootstrap must not fire and the happy path resolves normally.
      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.ensureRepoHasCommits('/repo/main');

      expect(result).toBeUndefined();
      // No elevated bootstrap call was made.
      expect(runAsUserMock.calls.length).toBe(0);
    });
  });

  describe('createWorktree', () => {
    // `runAsUser` is now the single execution point for `git worktree add`,
    // so the tests inject a capture mock via `runAsUserImpl` rather than
    // relying on the lib/git module mock for the create path. The lib/git
    // mock is still used for sibling operations (list, listBranches, etc.).
    let originalAuthMode: string | undefined;

    beforeEach(() => {
      // Default tests run as a single-user environment (no elevation, no
      // safe.directory bootstrap). Multi-user behaviour is exercised by its
      // own describe block below.
      originalAuthMode = process.env.AUTH_MODE;
      delete process.env.AUTH_MODE;
    });

    afterEach(() => {
      if (originalAuthMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalAuthMode;
      }
    });

    it('should create worktree with existing branch (single-user: no elevation)', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

      expect(result.error).toBeUndefined();
      // Directory name is wt-XXX-xxxx format, independent of branch name
      expect(result.worktreePath).toMatch(/wt-\d{3}-[a-z0-9]{4}$/);
      expect(result.index).toBeDefined();
      // Verify runAsUser was invoked with the correct git command, cwd, and
      // a null username (no elevation in single-user mode).
      expect(runAsUserMock.calls.length).toBe(1);
      const call = runAsUserMock.calls[0];
      expect(call.username).toBeNull();
      expect(call.cwd).toBe('/repo');
      // Command is `'git' 'worktree' 'add' '<path>' 'feature-branch'` with
      // each value single-quote escaped. No `-b` flag when no baseBranch.
      expect(call.command).toMatch(/^'git' 'worktree' 'add' '.*wt-\d{3}-[a-z0-9]{4}' 'feature-branch'$/);
      // Verify record was saved to mock repository
      expect(mockRepo.records.length).toBe(1);
      expect(mockRepo.records[0].repositoryId).toBe('repo-1');
      expect(mockRepo.records[0].path).toBe(result.worktreePath);
      // Positive control for the two pre-planted-symlink cases below: the
      // trusted-root walk created `repositories/<org>/<repo>/worktrees` as a
      // real directory in this fixture, so those rejections are attributable
      // to the plant and not to a fixture the walker cannot pass.
      const repoWorktreeDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/worktrees`;
      expect(fs.lstatSync(repoWorktreeDir).isSymbolicLink()).toBe(false);
      expect(fs.statSync(repoWorktreeDir).isDirectory()).toBe(true);
    });

    // The walk from `configDir` to `repositories/<org>/<repo>/worktrees`
    // rejects a pre-planted symlink at any segment, BEFORE the index is
    // allocated and BEFORE `git worktree add` runs, so a planted link can
    // never redirect the checkout. Both cases plant the link at a segment a
    // group member can create under the `2775` `repositories/` ancestor in
    // multi-user mode (the fixture is single-user, but the walk is the same
    // code on both paths).
    //
    // Polarity, measured by restoring `fsPromises.mkdir(repoWorktreeDir,
    // { recursive: true })` at the call site: memfs's recursive mkdir
    // follows the link and `createWorktree` RESOLVES with a `wt-001-*` path
    // under the link in both cases, so the `rejects` assertion fails first
    // in both. Measured with the `rejects` lines removed, to see what the
    // remaining pins each catch on their own: (a) `readdir(elsewhere)` is
    // `['worktrees']` (the recursive mkdir created it through the link),
    // `runAsUser` was called once and one record was saved -- all three
    // fail; (b) `readdir(elsewhere)` is `[]` in both worlds, because the
    // fake `runAsUser` never creates the `wt-*` directory, so that pin
    // carries no polarity in (b) -- the `runAsUser` (1 call, path under the
    // link) and `save` (1 record) pins are what fail there. With the
    // walker restored: both pass.
    describe('pre-planted symlink on the worktrees ancestor chain (#1749)', () => {
      const REPO_SEGMENT = `${TEST_CONFIG_DIR}/repositories/owner/repo-name`;
      const WORKTREES_SEGMENT = `${REPO_SEGMENT}/worktrees`;
      const ELSEWHERE = `${TEST_CONFIG_DIR}/elsewhere`;

      async function expectCheckoutNotRedirected(plantedAt: string) {
        const { TrustedDirVerificationError } = await import('../../lib/trusted-dir.js');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const promise = service.createWorktree('/repo', 'feature-branch', 'repo-1');
        await expect(promise).rejects.toBeInstanceOf(TrustedDirVerificationError);
        await expect(promise).rejects.toThrow(`Trusted directory segment is a symlink: ${plantedAt}`);
        // The link's target received nothing: no `worktrees` directory, no
        // `wt-*` entry.
        expect(fs.readdirSync(ELSEWHERE)).toEqual([]);
        // "Checkout not redirected": git never ran at all, so nothing was
        // checked out anywhere -- neither under the link nor elsewhere.
        expect(runAsUserMock.calls).toEqual([]);
        // No index was allocated / persisted for a worktree that does not exist.
        expect(mockRepo.records).toEqual([]);
      }

      it('rejects when repositories/<org>/<repo> is a symlink and never runs git', async () => {
        fs.mkdirSync(ELSEWHERE, { recursive: true });
        fs.mkdirSync(`${TEST_CONFIG_DIR}/repositories/owner`, { recursive: true });
        fs.symlinkSync(ELSEWHERE, REPO_SEGMENT);

        await expectCheckoutNotRedirected(REPO_SEGMENT);
      });

      it('rejects when .../worktrees itself is a symlink and never runs git', async () => {
        fs.mkdirSync(ELSEWHERE, { recursive: true });
        fs.mkdirSync(REPO_SEGMENT, { recursive: true });
        fs.symlinkSync(ELSEWHERE, WORKTREES_SEGMENT);

        await expectCheckoutNotRedirected(WORKTREES_SEGMENT);
      });
    });

    it('should create worktree with new branch from base (uses -b flag)', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      await service.createWorktree('/repo', 'new-feature', 'repo-1', 'main');

      expect(runAsUserMock.calls.length).toBe(1);
      const call = runAsUserMock.calls[0];
      // With baseBranch, command is `git worktree add -b <branch> <path> <baseBranch>`
      expect(call.command).toMatch(
        /^'git' 'worktree' 'add' '-b' 'new-feature' '.*wt-\d{3}-[a-z0-9]{4}' 'main'$/,
      );
    });

    it('should return error on failure (non-zero exit code from runAsUser)', async () => {
      runAsUserMock.responder.fn = async () => ({
        stdout: '',
        stderr: 'fatal: branch already exists',
        exitCode: 128,
        timedOut: false, cwdFailed: false,
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.createWorktree('/repo', 'existing-branch', 'repo-1');

      expect(result.error).toBeDefined();
      expect(result.error).toContain('branch already exists');
      expect(result.worktreePath).toBe('');
      // Verify no DB record was saved on failure
      expect(mockRepo.records.length).toBe(0);
    });

    describe('cannot-lock-ref permission hint', () => {
      const PERMISSION_STDERR =
        "fatal: cannot lock ref 'refs/heads/x': Unable to create\n" +
        "'/var/lib/agent-console/source-repos/r/.git/refs/heads/x.lock': Permission denied";

      async function createWithPermissionFailure(): Promise<{ error?: string }> {
        runAsUserMock.responder.fn = async () => ({
          stdout: '',
          stderr: PERMISSION_STDERR,
          exitCode: 128,
          timedOut: false, cwdFailed: false,
        });
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });
        return service.createWorktree('/repo', 'feature-x', 'repo-1');
      }

      it('appends the multi-user hint after the verbatim stderr when AUTH_MODE is multi-user', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const result = await createWithPermissionFailure();
        expect(result.error!.startsWith(PERMISSION_STDERR)).toBe(true);
        expect(result.error).toContain(WORKTREE_ADD_PERMISSION_HINT_HEADER);
        expect(result.error).toContain("ls -ld '/repo/.git'");
      });

      it('does not attach the hint to a failure after a successful git worktree add', async () => {
        process.env.AUTH_MODE = 'multi-user';
        // A GitError on purpose: only the add step's own error type may be augmented.
        mockRepo.save = async () => {
          throw new GitError('post-add failure', 128, PERMISSION_STDERR);
        };
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });
        const result = await service.createWorktree('/repo', 'feature-x', 'repo-1');
        expect(result.error).toBe(PERMISSION_STDERR);
      });

      it('surfaces the stderr exactly when AUTH_MODE is not multi-user', async () => {
        delete process.env.AUTH_MODE;
        const result = await createWithPermissionFailure();
        expect(result.error).toBe(PERMISSION_STDERR);
      });
    });

    describe('multi-user mode (Issue #838)', () => {
      beforeEach(() => {
        process.env.AUTH_MODE = 'multi-user';
      });

      it('routes git worktree add through runAsUser with requestUsername', async () => {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        // Use a non-server username so elevation actually engages. Hardcoding
        // an unlikely-collision value avoids dependence on the host's user.
        const result = await service.createWorktree(
          '/repo',
          'feature-x',
          'repo-1',
          undefined,
          'alice-multiuser-test',
        );

        expect(result.error).toBeUndefined();
        // Two calls: safe.directory bootstrap, then git worktree add.
        expect(runAsUserMock.calls.length).toBe(2);

        // Call ordering: bootstrap MUST precede the worktree add so the
        // user's gitconfig has the safe.directory entry before git runs.
        const bootstrap = runAsUserMock.calls[0];
        expect(bootstrap.username).toBe('alice-multiuser-test');
        expect(bootstrap.command).toContain('safe.directory');
        expect(bootstrap.command).toContain("'/repo'");

        const worktreeAdd = runAsUserMock.calls[1];
        expect(worktreeAdd.username).toBe('alice-multiuser-test');
        expect(worktreeAdd.cwd).toBe('/repo');
        expect(worktreeAdd.command).toMatch(
          /^'git' 'worktree' 'add' '.*wt-\d{3}-[a-z0-9]{4}' 'feature-x'$/,
        );
      });

      it('skips safe.directory bootstrap when no requestUsername is supplied (backward compat)', async () => {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        // No requestUsername -> no elevation -> only one call (worktree add
        // with username=null, which the helper bypasses).
        const result = await service.createWorktree('/repo', 'feature-y', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(runAsUserMock.calls.length).toBe(1);
        expect(runAsUserMock.calls[0].username).toBeNull();
        // The DB record is saved with the server-user-owned worktree path.
        expect(mockRepo.records.length).toBe(1);
      });

      it('materializes template files as the requesting user (Issue #838 ownership-consistency)', async () => {
        // Templates live under <repo>/.agent-console/ ; create one. Without
        // the user-owned-sink behaviour, the template would be written by
        // the server process. With it, the sink shells out to `mkdir -p`
        // and `cat > <dst>` as the user, so both ownership and the writes
        // are routed through runAsUser.
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync(
          '/repo/.agent-console/CLAUDE.md',
          'branch={{BRANCH}} num={{WORKTREE_NUM}}',
        );

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree(
          '/repo',
          'feature-templates',
          'repo-1',
          undefined,
          'alice-multiuser-test',
        );

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('CLAUDE.md');

        // Expected runAsUser calls (order matters):
        //   [0] safe.directory bootstrap
        //   [1] git worktree add
        //   [2] mkdir -p <worktreePath>  (the file's parent dir)
        //   [3] cat > <worktreePath>/CLAUDE.md (with substituted content as stdin)
        expect(runAsUserMock.calls.length).toBe(4);

        const mkdirCall = runAsUserMock.calls[2];
        expect(mkdirCall.username).toBe('alice-multiuser-test');
        expect(mkdirCall.command).toMatch(/^mkdir -p '.*wt-\d{3}-[a-z0-9]{4}'$/);

        const writeCall = runAsUserMock.calls[3];
        expect(writeCall.username).toBe('alice-multiuser-test');
        expect(writeCall.command).toMatch(
          /^cat > '.*wt-\d{3}-[a-z0-9]{4}\/CLAUDE\.md'$/,
        );
        // Stdin carries the substituted content. WORKTREE_NUM is the
        // allocated index (1 for a fresh DB).
        expect(writeCall.stdin).toBe('branch=feature-templates num=1');
      });

      it('uses direct fs writes for templates when worktree is server-owned (no requestUsername)', async () => {
        // No requestUsername -> sink falls back to direct fs writes.
        // This preserves the original pre-#838 single-user behaviour.
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync('/repo/.agent-console/hello.txt', 'hi');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree('/repo', 'feature-no-user', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('hello.txt');
        // Only one runAsUser call: the `git worktree add` invocation with
        // username=null. The template write went through fsPromises, not
        // runAsUser.
        expect(runAsUserMock.calls.length).toBe(1);
        expect(runAsUserMock.calls[0].username).toBeNull();
      });

      it('does not abort worktree creation when the safe.directory bootstrap returns non-zero', async () => {
        let callCount = 0;
        runAsUserMock.responder.fn = async () => {
          callCount += 1;
          // First call is the bootstrap; simulate a non-zero exit. Second
          // call is `git worktree add`; respond success so creation proceeds.
          if (callCount === 1) {
            return {
              stdout: '',
              stderr: 'unable to write config',
              exitCode: 1,
              timedOut: false, cwdFailed: false,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
        };

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree(
          '/repo',
          'feature-z',
          'repo-1',
          undefined,
          'alice-multiuser-test',
        );

        // Bootstrap failure is logged but not fatal; the worktree add still
        // ran and DB record was saved. If `git worktree add` itself fails
        // because of the missing safe.directory entry, the error from THAT
        // call surfaces to the caller (covered by the "non-zero exit" test).
        expect(result.error).toBeUndefined();
        expect(runAsUserMock.calls.length).toBe(2);
      });
    });

    describe('template copying', () => {
      it('should copy template files from repo-local .agent-console/ directory', async () => {
        // Setup: create /repo/.agent-console/ with a template file
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync('/repo/.agent-console/CLAUDE.md', 'hello world');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('CLAUDE.md');
        // Verify the file was actually written to the worktree
        const content = fs.readFileSync(`${result.worktreePath}/CLAUDE.md`, 'utf-8');
        expect(content).toBe('hello world');
      });

      it('should fall back to global templates when .agent-console/ does not exist', async () => {
        // Setup: create global templates dir (no /repo/.agent-console/)
        // /repo must exist as a directory but without .agent-console
        fs.mkdirSync('/repo', { recursive: true });
        const globalTemplatesDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/templates`;
        fs.mkdirSync(globalTemplatesDir, { recursive: true });
        fs.writeFileSync(`${globalTemplatesDir}/setup.sh`, '#!/bin/bash\necho setup');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('setup.sh');
        const content = fs.readFileSync(`${result.worktreePath}/setup.sh`, 'utf-8');
        expect(content).toBe('#!/bin/bash\necho setup');
      });

      it('should substitute template variables in copied files', async () => {
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync(
          '/repo/.agent-console/config.txt',
          'branch={{BRANCH}} num={{WORKTREE_NUM}}'
        );

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree('/repo', 'my-feature', 'repo-1');

        expect(result.error).toBeUndefined();
        const content = fs.readFileSync(`${result.worktreePath}/config.txt`, 'utf-8');
        expect(content).toContain('branch=my-feature');
        expect(content).toMatch(/num=\d+/);
      });

      it('should copy nested directory structure', async () => {
        fs.mkdirSync('/repo/.agent-console/.claude', { recursive: true });
        fs.writeFileSync(
          '/repo/.agent-console/.claude/settings.local.json',
          '{"key": "value"}'
        );
        fs.writeFileSync('/repo/.agent-console/root-file.txt', 'root');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('.claude/settings.local.json');
        expect(result.copiedFiles).toContain('root-file.txt');
        // Verify nested file content
        const nested = fs.readFileSync(
          `${result.worktreePath}/.claude/settings.local.json`,
          'utf-8'
        );
        expect(nested).toBe('{"key": "value"}');
      });

      describe('symlink entries', () => {
        // The service logger is a child created at import time, so the spy on
        // `rootLogger.child` must be installed before the fresh module import.
        async function createWithRecordingLogger() {
          const warns: unknown[][] = [];
          const original = rootLogger.child.bind(rootLogger);
          const childSpy = spyOn(rootLogger, 'child').mockImplementation(((bindings: { service?: string }) => {
            if (bindings?.service !== 'worktree-service') return original(bindings);
            return new Proxy({} as Record<string, unknown>, {
              get: (_t, prop) => {
                if (prop === 'warn') return (...args: unknown[]) => warns.push(args);
                return () => {};
              },
            });
          }) as unknown as typeof rootLogger.child);
          try {
            const WorktreeService = await getWorktreeService();
            const service = new WorktreeService({
              worktreeRepository: mockRepo,
              runAsUserImpl: runAsUserMock.runAsUserImpl,
            });
            const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');
            return { result, warns };
          } finally {
            childSpy.mockRestore();
          }
        }

        it('does not copy a symlinked file, copies the sibling regular file, and warns', async () => {
          fs.mkdirSync('/repo/.agent-console', { recursive: true });
          fs.writeFileSync('/secret.txt', 'server secret');
          fs.writeFileSync('/repo/.agent-console/regular.txt', 'regular');
          fs.symlinkSync('/secret.txt', '/repo/.agent-console/link.txt');

          const { result, warns } = await createWithRecordingLogger();

          expect(result.error).toBeUndefined();
          expect(result.copiedFiles).toEqual(['regular.txt']);
          expect(fs.readFileSync(`${result.worktreePath}/regular.txt`, 'utf-8')).toBe('regular');
          expect(fs.existsSync(`${result.worktreePath}/link.txt`)).toBe(false);
          expect(warns.some(args => (args[1] as string) === 'template entry is a symlink; skipped')).toBe(true);
        });

        it('does not follow a symlinked directory, copies the sibling regular file, and warns', async () => {
          fs.mkdirSync('/repo/.agent-console', { recursive: true });
          fs.mkdirSync('/outside', { recursive: true });
          fs.writeFileSync('/outside/secret.txt', 'server secret');
          fs.writeFileSync('/repo/.agent-console/regular.txt', 'regular');
          fs.symlinkSync('/outside', '/repo/.agent-console/linkdir');

          const { result, warns } = await createWithRecordingLogger();

          expect(result.error).toBeUndefined();
          expect(result.copiedFiles).toEqual(['regular.txt']);
          expect(fs.existsSync(`${result.worktreePath}/linkdir`)).toBe(false);
          expect(warns.some(args => (args[1] as string) === 'template entry is a symlink; skipped')).toBe(true);
        });
      });
    });

    describe('template copying on a bare source repository', () => {
      const TMP_PREFIX = 'agent-console-templates-';

      function makeBare() {
        mockGit.resolveGitDir.mockImplementation(async (repoPath: string) => ({ gitDir: repoPath, bare: true }));
        mockGit.resolveSourceReadRef.mockImplementation(async () => 'origin/main');
      }

      /** Export stub: writes `files` (relative to the exported dir) into `destDir/.agent-console`. */
      function scriptExport(files: Record<string, string>) {
        mockGit.exportRepoTreeAtRef.mockImplementation(
          async (_repo: string, _ref: string, relPath: string, destDir: string) => {
            const root = `${destDir}/${relPath}`;
            for (const [name, content] of Object.entries(files)) {
              const full = `${root}/${name}`;
              fs.mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
              fs.writeFileSync(full, content);
            }
            return root;
          },
        );
      }

      function leftoverTemplateTempDirs(): string[] {
        return fs.existsSync(os.tmpdir()) ? fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(TMP_PREFIX)) : [];
      }

      beforeEach(() => {
        fs.mkdirSync(os.tmpdir(), { recursive: true });
        fs.mkdirSync('/repo', { recursive: true });
      });

      afterEach(() => {
        resetGitMocks();
      });

      it('exports .agent-console at the source read ref, copies with substitution, and removes the temp dir', async () => {
        makeBare();
        scriptExport({ 'config.txt': 'branch={{BRANCH}}', '.claude/settings.json': '{"k":1}' });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'my-feature', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(mockGit.exportRepoTreeAtRef.mock.calls[0].slice(0, 3)).toEqual(['/repo', 'origin/main', '.agent-console']);
        expect(result.copiedFiles).toContain('config.txt');
        expect(result.copiedFiles).toContain('.claude/settings.json');
        expect(fs.readFileSync(`${result.worktreePath}/config.txt`, 'utf-8')).toBe('branch=my-feature');
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });

      it('no .agent-console at the ref (null export): falls through to the global templates and removes the temp dir', async () => {
        makeBare();
        const globalTemplatesDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/templates`;
        fs.mkdirSync(globalTemplatesDir, { recursive: true });
        fs.writeFileSync(`${globalTemplatesDir}/setup.sh`, 'echo global');
        mockGit.exportRepoTreeAtRef.mockImplementation(async () => null);

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toEqual(['setup.sh']);
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });

      it('the repository templates win over the global ones (priority unchanged)', async () => {
        makeBare();
        const globalTemplatesDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/templates`;
        fs.mkdirSync(globalTemplatesDir, { recursive: true });
        fs.writeFileSync(`${globalTemplatesDir}/global-only.txt`, 'g');
        scriptExport({ 'repo-only.txt': 'r' });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.copiedFiles).toEqual(['repo-only.txt']);
      });

      it('an empty .agent-console directory at the ref copies nothing and still cleans up', async () => {
        makeBare();
        mockGit.exportRepoTreeAtRef.mockImplementation(async (_r: string, _f: string, relPath: string, destDir: string) => {
          fs.mkdirSync(`${destDir}/${relPath}`, { recursive: true });
          return `${destDir}/${relPath}`;
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toEqual([]);
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });

      it('an export GitError makes createWorktree fail loudly (no silent skip of the repository settings) and leaves no temp dir', async () => {
        makeBare();
        const globalTemplatesDir = `${TEST_CONFIG_DIR}/repositories/owner/repo-name/templates`;
        fs.mkdirSync(globalTemplatesDir, { recursive: true });
        fs.writeFileSync(`${globalTemplatesDir}/setup.sh`, 'echo global');
        mockGit.exportRepoTreeAtRef.mockImplementation(async () => {
          throw new GitError('git archive failed: boom', 128, 'boom');
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.worktreePath).toBe('');
        expect(result.error).toBe('boom');
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });

      it('a failure while copying (a template file cannot be read) still removes the temp dir', async () => {
        makeBare();
        scriptExport({ 'a.txt': 'a' });
        const spy = spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('read failed'));

        try {
          const WorktreeService = await getWorktreeService();
          const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
          const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

          expect(result.error).toContain('read failed');
        } finally {
          spy.mockRestore();
        }
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });

      it('a template file that turns into a symlink between listing and open (ELOOP) is skipped: not created, not reported, the rest still copied', async () => {
        makeBare();
        scriptExport({ 'a.txt': 'swapped', 'b.txt': 'kept' });
        const realOpen = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
        const spy = spyOn(fs.promises, 'open').mockImplementation(((...args: unknown[]) => {
          if (String(args[0]).endsWith('/a.txt')) {
            return Promise.reject(Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' }));
          }
          return realOpen(...args);
        }) as unknown as typeof fs.promises.open);

        let result;
        try {
          const WorktreeService = await getWorktreeService();
          const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
          result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');
        } finally {
          spy.mockRestore();
        }

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toEqual(['b.txt']);
        expect(fs.existsSync(`${result.worktreePath}/a.txt`)).toBe(false);
        expect(fs.readFileSync(`${result.worktreePath}/b.txt`, 'utf-8')).toBe('kept');
      });

      it('non-bare control: reads <repo>/.agent-console directly and never exports', async () => {
        fs.mkdirSync('/repo/.agent-console', { recursive: true });
        fs.writeFileSync('/repo/.agent-console/CLAUDE.md', 'hello world');

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo, runAsUserImpl: runAsUserMock.runAsUserImpl });
        const result = await service.createWorktree('/repo', 'feature-branch', 'repo-1');

        expect(result.error).toBeUndefined();
        expect(result.copiedFiles).toContain('CLAUDE.md');
        expect(mockGit.exportRepoTreeAtRef).not.toHaveBeenCalled();
        expect(leftoverTemplateTempDirs()).toEqual([]);
      });
    });
  });

  describe('removeWorktree', () => {
    // ① Primary repo dir exists + clean: behavior unchanged (normal git path).
    it('should remove worktree successfully', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      // Pre-populate DB record for the worktree being removed
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // Normal git path runs because the primary exists
      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/feature',
        '/repo',
        { force: false }
      );
      // Verify record was deleted from mock repository
      expect(mockRepo.records.length).toBe(0);
    });

    it('should use force flag when specified', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      // Pre-populate DB record
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.removeWorktree('/repo', '/worktrees/feature', true);

      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/feature',
        '/repo',
        { force: true }
      );
    });

    it('should return error on failure', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockGit.removeWorktree.mockImplementation(() =>
        Promise.reject(new GitError('worktree has changes', 128, 'fatal: worktree has uncommitted changes'))
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    // ② Primary repo dir MISSING + worktree dir present: git-independent recovery.
    it('should recover orphaned worktree when primary repo dir is missing', async () => {
      // Primary repo dir does NOT exist (deleted out-of-band).
      // Worktree dir exists on disk and has a DB record.
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo-missing', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // DB record removed even though no git ran
      expect(mockRepo.records.length).toBe(0);
      // Worktree directory is gone
      expect(fs.existsSync('/worktrees/feature')).toBe(false);
      // git was NOT invoked (recovery skips git entirely)
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
    });

    // ③ Primary MISSING + worktree dir ALSO already deleted: idempotent recovery.
    it('should be idempotent when primary missing and worktree dir already gone', async () => {
      // Neither the primary nor the worktree dir exists.
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/already-gone',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo-missing', '/worktrees/already-gone');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // deleteByPath still ran, record removed
      expect(mockRepo.records.length).toBe(0);
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
    });

    // ④ Orphaned existing row is recoverable when primary missing.
    it('should remove the orphaned DB row when primary missing', async () => {
      fs.mkdirSync('/worktrees/orphaned', { recursive: true });
      mockRepo.records.push({
        id: 'wt-orphan',
        repositoryId: 'repo-1',
        path: '/worktrees/orphaned',
        indexNumber: 2,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.removeWorktree('/repo-missing', '/worktrees/orphaned');

      expect(mockRepo.records.find((r) => r.path === '/worktrees/orphaned')).toBeUndefined();
    });

    // ⑤ Non-ENOENT stat error (EACCES/EPERM/IO) on the primary repo dir must NOT
    //    route to destructive recovery. It should surface as { success: false }
    //    without running git or deleting the DB row.
    it('should fail without destructive recovery when stat(repoPath) rejects with EACCES', async () => {
      // DB record present; must remain present after the failed call.
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      // Force stat() to reject with a coded permission error (not ENOENT/ENOTDIR).
      const statSpy = spyOn(fs.promises, 'stat').mockImplementation((() =>
        Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      ) as typeof fs.promises.stat);

      try {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.removeWorktree('/repo', '/worktrees/feature');

        // Surfaced as a failure, not a silent destructive recovery.
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        // Git removal was NOT attempted.
        expect(mockGit.removeWorktree).not.toHaveBeenCalled();
        // DB row was NOT deleted (record still present).
        expect(mockRepo.records.find((r) => r.path === '/worktrees/feature')).toBeDefined();
      } finally {
        statSpy.mockRestore();
      }
    });

    // ⑤b Non-errno-shaped stat rejection (no `code` property at all) on the
    //    primary repo dir must also NOT route to destructive recovery — the
    //    errno type-guard must not mistake "no code" for ENOENT/ENOTDIR.
    it('should fail without destructive recovery when stat(repoPath) rejects with a plain Error (no code)', async () => {
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const statSpy = spyOn(fs.promises, 'stat').mockImplementation((() =>
        Promise.reject(new Error('unexpected stat failure'))
      ) as typeof fs.promises.stat);

      try {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.removeWorktree('/repo', '/worktrees/feature');

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(mockGit.removeWorktree).not.toHaveBeenCalled();
        expect(mockRepo.records.find((r) => r.path === '/worktrees/feature')).toBeDefined();
      } finally {
        statSpy.mockRestore();
      }
    });

    // ⑥ Primary repo dir present + worktree dir MISSING: upgrade `force=true`
    //    internally and route through the existing fallback (#895).
    it('should upgrade force=true internally when worktree path is missing (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo', '/worktrees/feature');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/feature',
        '/repo',
        { force: true },
      );
      expect(mockRepo.records.length).toBe(0);
    });

    // ⑦ Idempotent: second orphan-recovery call (no DB row, no dir) still succeeds.
    it('should be idempotent on the second orphan worktree-dir recovery call (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo', '/worktrees/already-pruned');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/already-pruned',
        '/repo',
        { force: true },
      );
    });

    // Single-user EACCES: carve-out does NOT engage; failure surfaces. This
    // locks the narrow scope of the multi-user EACCES carve-out (#895).
    it('still surfaces { success: false } on EACCES in single-user mode (no elevation) (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const realStat = fs.promises.stat;
      const statSpy = spyOn(fs.promises, 'stat').mockImplementation(((p: fs.PathLike) => {
        if (typeof p === 'string' && p === '/worktrees/feature') {
          return Promise.reject(
            Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' }),
          );
        }
        return realStat(p as fs.PathLike);
      }) as typeof fs.promises.stat);

      try {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.removeWorktree(
          '/repo',
          '/worktrees/feature',
          false,
          null,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(mockGit.removeWorktree).not.toHaveBeenCalled();
        expect(runAsUserMock.calls.length).toBe(0);
        expect(mockRepo.records.length).toBe(1);
      } finally {
        statSpy.mockRestore();
      }
    });

    // ⑧ Non-directory at worktreePath MUST NOT route to destructive recovery (#895).
    it('should fail without recovery when worktreePath exists as a non-directory (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees', { recursive: true });
      fs.writeFileSync('/worktrees/feature-file', 'stale leftover');
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-file',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.removeWorktree('/repo', '/worktrees/feature-file');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
      expect(mockRepo.records.length).toBe(1);
    });
  });

  describe('removeWorktree (multi-user, Issue #882)', () => {
    let originalAuthMode: string | undefined;

    beforeEach(() => {
      originalAuthMode = process.env.AUTH_MODE;
      process.env.AUTH_MODE = 'multi-user';
    });

    afterEach(() => {
      if (originalAuthMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalAuthMode;
      }
    });

    it('routes git worktree remove through runAsUser when requestUsername is provided', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        false,
        'alice-multiuser-test',
      );

      expect(result.success).toBe(true);
      // lib/git.ts removeWorktree must NOT have been called — the elevated
      // branch bypasses it.
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
      // Two runAsUser calls in order: safe.directory bootstrap, then
      // `git worktree remove`. Bootstrap MUST precede the remove so the
      // user's gitconfig has the safe.directory entry before git runs
      // against the server-owned repo (CodeRabbit, mirrors create-side).
      expect(runAsUserMock.calls.length).toBe(2);
      const bootstrap = runAsUserMock.calls[0];
      expect(bootstrap.username).toBe('alice-multiuser-test');
      expect(bootstrap.command).toContain('safe.directory');
      expect(bootstrap.command).toContain("'/repo'");
      const removeCall = runAsUserMock.calls[1];
      expect(removeCall.username).toBe('alice-multiuser-test');
      expect(removeCall.cwd).toBe('/repo');
      expect(removeCall.command).toBe(`'git' 'worktree' 'remove' '/worktrees/feature'`);
      // DB record removed.
      expect(mockRepo.records.length).toBe(0);
    });

    it('emits --force --force in the elevated command when force=true', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      await service.removeWorktree('/repo', '/worktrees/feature', true, 'alice-multiuser-test');

      // Bootstrap call [0], then `git worktree remove --force --force` [1].
      expect(runAsUserMock.calls.length).toBe(2);
      expect(runAsUserMock.calls[1].command).toBe(
        `'git' 'worktree' 'remove' '/worktrees/feature' '--force' '--force'`,
      );
    });

    it('returns { success: false } with actionable error when elevated git remove fails', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      // Bootstrap [0] succeeds; `git worktree remove` [1] fails.
      let callIdx = 0;
      runAsUserMock.responder.fn = async () => {
        callIdx += 1;
        if (callIdx === 1) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
        }
        return {
          stdout: '',
          stderr: 'fatal: worktree has uncommitted changes',
          exitCode: 128,
          timedOut: false, cwdFailed: false,
        };
      };

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        false,
        'alice-multiuser-test',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('uncommitted changes');
      // DB record preserved on failure.
      expect(mockRepo.records.length).toBe(1);
    });

    it('does not trigger destructive fallback for "not a git repository" errors (CodeRabbit, 2026-06-25)', async () => {
      // Regression: the broad `stderr.includes('.git')` matcher would have
      // taken the fallback `rm -rf -- <path>` + `git worktree prune` chain
      // even though the error is not a stale-worktree case. Narrowed matcher
      // must NOT match `fatal: not a git repository ... .git`.
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      let callIdx = 0;
      runAsUserMock.responder.fn = async () => {
        callIdx += 1;
        if (callIdx === 1) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
        }
        return {
          stdout: '',
          stderr: 'fatal: not a git repository (or any of the parent directories): .git',
          exitCode: 128,
          timedOut: false, cwdFailed: false,
        };
      };

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        true,
        'alice-multiuser-test',
      );

      // Must surface as failure — NOT a destructive recovery.
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a git repository');
      // Only two runAsUser calls — bootstrap + remove. No rm, no prune.
      expect(runAsUserMock.calls.length).toBe(2);
      // DB record preserved.
      expect(mockRepo.records.length).toBe(1);
    });

    it('falls back to elevated rm + prune when force=true and stderr matches a stale-worktree pattern', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      // 1st call: safe.directory bootstrap (added per CodeRabbit feedback).
      // 2nd call: `git worktree remove --force --force` fails with the
      //           stale-`.git` pattern that triggers the fallback.
      // 3rd call: `rm -rf -- <path>` succeeds.
      // 4th call: `git worktree prune` succeeds.
      let callIdx = 0;
      runAsUserMock.responder.fn = async () => {
        callIdx += 1;
        if (callIdx === 2) {
          return {
            stdout: '',
            stderr: "fatal: '/worktrees/feature' is not a working tree",
            exitCode: 128,
            timedOut: false, cwdFailed: false,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
      };

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        true,
        'alice-multiuser-test',
      );

      expect(result.success).toBe(true);
      expect(runAsUserMock.calls.length).toBe(4);
      expect(runAsUserMock.calls[2].command).toBe(`rm -rf -- '/worktrees/feature'`);
      expect(runAsUserMock.calls[2].cwd).toBe('/');
      expect(runAsUserMock.calls[3].command).toBe(
        `'git' 'worktree' 'prune' '--expire=now'`,
      );
      expect(runAsUserMock.calls[3].cwd).toBe('/repo');
    });

    it('skips runAsUser when requestUsername is null (single-user path preserved)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      fs.mkdirSync('/worktrees/feature', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree('/repo', '/worktrees/feature', false, null);

      expect(result.success).toBe(true);
      // null username → no elevation gate; the lib/git.ts path runs.
      expect(runAsUserMock.calls.length).toBe(0);
      expect(mockGit.removeWorktree).toHaveBeenCalledWith(
        '/worktrees/feature',
        '/repo',
        { force: false },
      );
    });

    it('routes force=true through runAsUser when worktree-dir is missing (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        false,
        'alice-multiuser-test',
      );

      expect(result.success).toBe(true);
      expect(runAsUserMock.calls.length).toBe(2);
      const bootstrap = runAsUserMock.calls[0];
      expect(bootstrap.username).toBe('alice-multiuser-test');
      expect(bootstrap.command).toContain('safe.directory');
      expect(bootstrap.command).toContain("'/repo'");
      expect(runAsUserMock.calls[1].command).toBe(
        `'git' 'worktree' 'remove' '/worktrees/feature' '--force' '--force'`,
      );
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
      expect(mockRepo.records.length).toBe(0);
    });

    it('uses --expire=now in fallback prune when worktree-dir is missing and force=true triggers fallback (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      // Call sequence: 1 bootstrap, 2 `git worktree remove` (returns the
      // is-not-a-working-tree error to trigger the fallback), 3 `rm -rf`,
      // 4 `git worktree prune --expire=now`.
      let callIdx = 0;
      runAsUserMock.responder.fn = async () => {
        callIdx += 1;
        if (callIdx === 2) {
          return {
            stdout: '',
            stderr: "fatal: '/worktrees/feature' is not a working tree",
            exitCode: 128,
            timedOut: false, cwdFailed: false,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
      };

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.removeWorktree(
        '/repo',
        '/worktrees/feature',
        false,
        'alice-multiuser-test',
      );

      expect(result.success).toBe(true);
      expect(runAsUserMock.calls.length).toBe(4);
      expect(runAsUserMock.calls[3].command).toBe(
        `'git' 'worktree' 'prune' '--expire=now'`,
      );
      expect(runAsUserMock.calls[3].cwd).toBe('/repo');
      expect(mockRepo.records.length).toBe(0);
    });

    // EACCES/EPERM carve-out: only multi-user mode skips the throw and
    // defers the existence check to the elevated remove. `effectiveForce`
    // stays at the caller's value (no upgrade) — see worktree-service.ts.
    it('proceeds to elevated remove path when stat(worktreePath) rejects with EACCES (#895)', async () => {
      fs.mkdirSync('/repo', { recursive: true });
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const realStat = fs.promises.stat;
      const statSpy = spyOn(fs.promises, 'stat').mockImplementation(((p: fs.PathLike) => {
        if (typeof p === 'string' && p === '/worktrees/feature') {
          return Promise.reject(
            Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' }),
          );
        }
        return realStat(p as fs.PathLike);
      }) as typeof fs.promises.stat);

      try {
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.removeWorktree(
          '/repo',
          '/worktrees/feature',
          false,
          'alice-multiuser-test',
        );

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(runAsUserMock.calls.length).toBe(2);
        const removeCall = runAsUserMock.calls[1];
        expect(removeCall.command).toBe(
          `'git' 'worktree' 'remove' '/worktrees/feature'`,
        );
        expect(mockRepo.records.length).toBe(0);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  describe('removeOrphanedWorktree', () => {
    // Refs #815. The named helper is called directly by the deletion
    // service when the repository row itself is unregistered. The helper
    // must be pure best-effort (no git, idempotent).

    it('should remove both the worktree directory and the DB row', async () => {
      fs.mkdirSync('/worktrees/orphan-direct', { recursive: true });
      mockRepo.records.push({
        id: 'wt-direct',
        repositoryId: 'repo-unregistered',
        path: '/worktrees/orphan-direct',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.removeOrphanedWorktree('/worktrees/orphan-direct');

      expect(fs.existsSync('/worktrees/orphan-direct')).toBe(false);
      expect(mockRepo.records.find((r) => r.path === '/worktrees/orphan-direct')).toBeUndefined();
      expect(mockGit.removeWorktree).not.toHaveBeenCalled();
    });

    it('should be idempotent when the directory is already missing', async () => {
      // No fs.mkdirSync — the directory does not exist on disk.
      mockRepo.records.push({
        id: 'wt-missing-dir',
        repositoryId: 'repo-unregistered',
        path: '/worktrees/no-dir',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      // Must not throw — fs.rm with force is a no-op on missing paths.
      await service.removeOrphanedWorktree('/worktrees/no-dir');

      expect(mockRepo.records.find((r) => r.path === '/worktrees/no-dir')).toBeUndefined();
    });

    it('should be idempotent when the DB row is already missing', async () => {
      fs.mkdirSync('/worktrees/no-row', { recursive: true });
      // No mockRepo.records.push — the row does not exist.

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      // Must not throw — deleteByPath is a no-op on missing rows.
      await service.removeOrphanedWorktree('/worktrees/no-row');

      expect(fs.existsSync('/worktrees/no-row')).toBe(false);
    });

    it('should be idempotent when both the directory and the DB row are already missing', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      // Pure no-op call: nothing to remove.
      await service.removeOrphanedWorktree('/worktrees/all-gone');

      expect(mockRepo.records.length).toBe(0);
    });

    // Issue #882: multi-user mode must elevate the `rm` to the worktree-owning
    // user. The non-elevated branch above continues to use in-process
    // `fsPromises.rm`; the elevated branch routes through `runAsUser` so the
    // shelled `rm -rf` runs as the requesting user.
    describe('multi-user mode (Issue #882)', () => {
      let originalAuthMode: string | undefined;

      beforeEach(() => {
        originalAuthMode = process.env.AUTH_MODE;
        process.env.AUTH_MODE = 'multi-user';
      });

      afterEach(() => {
        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
      });

      it('routes rm through runAsUser when requestUsername is provided', async () => {
        mockRepo.records.push({
          id: 'wt-elevated',
          repositoryId: 'repo-1',
          path: '/worktrees/elevated-orphan',
          indexNumber: 1,
          createdAt: new Date().toISOString(),
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.removeOrphanedWorktree(
          '/worktrees/elevated-orphan',
          'alice-multiuser-test',
        );

        expect(runAsUserMock.calls.length).toBe(1);
        const call = runAsUserMock.calls[0];
        expect(call.username).toBe('alice-multiuser-test');
        // `rm -rf -- '<path>'` with the path single-quote escaped.
        expect(call.command).toBe(`rm -rf -- '/worktrees/elevated-orphan'`);
        // cwd pinned to '/' because the worktree dir itself may not exist.
        expect(call.cwd).toBe('/');
        // DB row was still deleted (in-process, not OS-coupled).
        expect(mockRepo.records.find((r) => r.path === '/worktrees/elevated-orphan')).toBeUndefined();
      });

      it('falls back to fsPromises.rm when requestUsername is null', async () => {
        fs.mkdirSync('/worktrees/non-elevated', { recursive: true });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.removeOrphanedWorktree('/worktrees/non-elevated', null);

        // No runAsUser invocation; the in-process fs.rm path ran.
        expect(runAsUserMock.calls.length).toBe(0);
        expect(fs.existsSync('/worktrees/non-elevated')).toBe(false);
      });

      it('throws when elevated rm exits non-zero (EACCES surfaces to caller)', async () => {
        runAsUserMock.responder.fn = async () => ({
          stdout: '',
          stderr: "rm: cannot remove '/worktrees/elevated-orphan/locked': Permission denied",
          exitCode: 1,
          timedOut: false, cwdFailed: false,
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await expect(
          service.removeOrphanedWorktree('/worktrees/elevated-orphan', 'alice-multiuser-test'),
        ).rejects.toThrow(/Permission denied/);
      });
    });
  });

  describe('listBranches', () => {
    it('should list local and remote branches', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.listBranches('/repo');

      expect(result.local).toContain('main');
      expect(result.local).toContain('feature-1');
      expect(result.remote).toContain('origin/main');
      expect(result.defaultBranch).toBe('main');
    });

    it('should return empty arrays on error', async () => {
      mockGit.listLocalBranches.mockImplementation(() => Promise.reject(new Error('git error')));
      mockGit.listRemoteBranches.mockImplementation(() => Promise.reject(new Error('git error')));
      mockGit.getDefaultBranch.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.listBranches('/repo');

      expect(result.local).toEqual([]);
      expect(result.remote).toEqual([]);
      expect(result.defaultBranch).toBeNull();
    });

    // Issue #870: listBranches now forwards an optional `requestUsername`
    // through to lib/git.ts so multi-user mode runs git as that user
    // (picking up their SSH credentials / gitconfig).
    it('forwards requestUsername=null to lib/git.ts when no argument is passed', async () => {
      mockGit.listLocalBranches.mockClear();
      mockGit.listRemoteBranches.mockClear();
      mockGit.getDefaultBranch.mockClear();

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.listBranches('/repo');

      expect(mockGit.listLocalBranches).toHaveBeenCalledWith('/repo', null);
      expect(mockGit.listRemoteBranches).toHaveBeenCalledWith('/repo', null);
      expect(mockGit.getDefaultBranch).toHaveBeenCalledWith('/repo', null);
    });

    it('forwards a non-null requestUsername through to every lib/git.ts call (Issue #870)', async () => {
      mockGit.listLocalBranches.mockClear();
      mockGit.listRemoteBranches.mockClear();
      mockGit.getDefaultBranch.mockClear();

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.listBranches('/repo', 'alice');

      expect(mockGit.listLocalBranches).toHaveBeenCalledWith('/repo', 'alice');
      expect(mockGit.listRemoteBranches).toHaveBeenCalledWith('/repo', 'alice');
      expect(mockGit.getDefaultBranch).toHaveBeenCalledWith('/repo', 'alice');
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch from git', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBe('main');
    });

    it('should return null if no default branch found', async () => {
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.getDefaultBranch('/repo');
      expect(result).toBeNull();
    });

    it('forwards requestUsername to lib/git.ts (Issue #870)', async () => {
      mockGit.getDefaultBranch.mockClear();

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.getDefaultBranch('/repo', 'alice');

      expect(mockGit.getDefaultBranch).toHaveBeenCalledWith('/repo', 'alice');
    });
  });

  describe('refreshDefaultBranch', () => {
    it('forwards requestUsername=null when no argument is passed', async () => {
      mockGit.refreshDefaultBranch.mockClear();
      mockGit.refreshDefaultBranch.mockImplementation(() => Promise.resolve('main'));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.refreshDefaultBranch('/repo');

      expect(result).toBe('main');
      expect(mockGit.refreshDefaultBranch).toHaveBeenCalledWith('/repo', null);
    });

    it('forwards a non-null requestUsername to lib/git.ts (Issue #870)', async () => {
      mockGit.refreshDefaultBranch.mockClear();
      mockGit.refreshDefaultBranch.mockImplementation(() => Promise.resolve('develop'));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.refreshDefaultBranch('/repo', 'alice');

      expect(result).toBe('develop');
      expect(mockGit.refreshDefaultBranch).toHaveBeenCalledWith('/repo', 'alice');
    });

    it('propagates GitError from the underlying lib/git.ts helper', async () => {
      mockGit.refreshDefaultBranch.mockClear();
      mockGit.refreshDefaultBranch.mockImplementation(() =>
        Promise.reject(new GitError('git remote set-head failed: network unreachable', 128, 'fatal: network unreachable')),
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      let caught: unknown;
      try {
        await service.refreshDefaultBranch('/repo', 'alice');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitError);
      expect((caught as Error).message).toContain('network unreachable');
    });
  });

  describe('isWorktreeOf', () => {
    it('should return true for valid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      // Main worktree path equals repo path, always valid
      const result = await service.isWorktreeOf('/repo/main', '/repo/main', 'repo-1');
      expect(result).toBe(true);
    });

    it('should return true for secondary worktree path', async () => {
      // Register worktree in mock repository
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/feature-1',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.isWorktreeOf('/repo/main', '/worktrees/feature-1', 'repo-1');
      expect(result).toBe(true);
    });

    it('should return false for invalid worktree path', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.isWorktreeOf('/repo/main', '/other/path', 'repo-1');
      expect(result).toBe(false);
    });

    describe('repository path vs bareness', () => {
      afterEach(() => {
        resetGitMocks();
      });

      function markBare(bare: boolean) {
        mockGit.resolveGitDir.mockImplementation(async (repoPath: string) => ({
          gitDir: bare ? repoPath : `${repoPath}/.git`,
          bare,
        }));
      }

      it('bare: the bare directory is never a worktree of itself', async () => {
        markBare(true);
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        expect(await service.isWorktreeOf('/repos/bare', '/repos/bare', 'repo-1')).toBe(false);
      });

      it('bare: a registered linked worktree is still a worktree of it', async () => {
        markBare(true);
        mockRepo.records.push({
          id: 'wt-1',
          repositoryId: 'repo-1',
          path: '/worktrees/feature-1',
          indexNumber: 1,
          createdAt: new Date().toISOString(),
        });
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        expect(await service.isWorktreeOf('/repos/bare', '/worktrees/feature-1', 'repo-1')).toBe(true);
      });

      it('bare: an unregistered path is not a worktree of it', async () => {
        markBare(true);
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        expect(await service.isWorktreeOf('/repos/bare', '/other/path', 'repo-1')).toBe(false);
      });

      it('non-bare control: the repository path itself is the main worktree and stays valid', async () => {
        markBare(false);
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        expect(await service.isWorktreeOf('/repos/plain', '/repos/plain', 'repo-1')).toBe(true);
      });

      it('non-bare control: a path other than the repository path never asks git about bareness', async () => {
        markBare(false);
        mockGit.resolveGitDir.mockClear();
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.isWorktreeOf('/repos/plain', '/other/path', 'repo-1');

        expect(mockGit.resolveGitDir).not.toHaveBeenCalled();
      });
    });
  });

  describe('generateNextBranchName', () => {
    it('should return wt-001-XXXX format when no worktrees exist', async () => {
      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-001-[a-z0-9]{4}$/);
    });

    it('should return wt-002-XXXX format when index 1 is used', async () => {
      mockRepo.records.push({
        id: 'wt-1',
        repositoryId: 'repo-1',
        path: '/worktrees/existing',
        indexNumber: 1,
        createdAt: new Date().toISOString(),
      });

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-002-[a-z0-9]{4}$/);
    });

    it('should match format /^wt-\\d{3}-[a-z0-9]{4}$/', async () => {
      // Add several records to push the index higher
      for (let i = 1; i <= 5; i++) {
        mockRepo.records.push({
          id: `wt-${i}`,
          repositoryId: 'repo-1',
          path: `/worktrees/wt-${i}`,
          indexNumber: i,
          createdAt: new Date().toISOString(),
        });
      }

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const branchName = await service.generateNextBranchName('repo-1');

      expect(branchName).toMatch(/^wt-\d{3}-[a-z0-9]{4}$/);
      // Should be wt-006-xxxx since indexes 1-5 are taken
      expect(branchName).toMatch(/^wt-006-/);
    });
  });

  describe('allocateNextIndex (tested indirectly via createWorktree)', () => {
    it('should fill gaps: indexes [1, 3] exist -> next is 2', async () => {
      mockRepo.records.push(
        {
          id: 'wt-1',
          repositoryId: 'repo-1',
          path: '/worktrees/wt-1',
          indexNumber: 1,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'wt-3',
          repositoryId: 'repo-1',
          path: '/worktrees/wt-3',
          indexNumber: 3,
          createdAt: new Date().toISOString(),
        }
      );

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.createWorktree('/repo', 'feature-gap', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(2);
    });

    it('should allocate sequentially: indexes [1, 2, 3] exist -> next is 4', async () => {
      for (let i = 1; i <= 3; i++) {
        mockRepo.records.push({
          id: `wt-${i}`,
          repositoryId: 'repo-1',
          path: `/worktrees/wt-${i}`,
          indexNumber: i,
          createdAt: new Date().toISOString(),
        });
      }

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.createWorktree('/repo', 'feature-next', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(4);
    });

    it('should allocate index 1 when no indexes exist', async () => {
      // mockRepo.records is empty

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({
        worktreeRepository: mockRepo,
        runAsUserImpl: runAsUserMock.runAsUserImpl,
      });

      const result = await service.createWorktree('/repo', 'first-worktree', 'repo-1');

      expect(result.error).toBeUndefined();
      expect(result.index).toBe(1);
    });
  });

  describe('executeHookCommand', () => {
    beforeEach(() => {
      // Reset spawn tracking
      spawnCalls = [];

      // Default mock result (successful command)
      setMockSpawnResult('');

      // Mock Bun.spawn
      (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
        spawnCalls.push({ args, options: options || {} });
        return mockSpawnResult;
      }) as typeof Bun.spawn;
    });

    afterAll(() => {
      // Restore original Bun.spawn
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
    });

    describe('template variable substitution', () => {
      it('should substitute {{WORKTREE_NUM}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo {{WORKTREE_NUM}}',
          '/test/worktree',
          { worktreeNum: 5, branch: 'feature-1', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 5');
      });

      it('should substitute {{BRANCH}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'git checkout {{BRANCH}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'feature/my-branch', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('git checkout feature/my-branch');
      });

      it('should substitute {{REPO}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo Working on {{REPO}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'awesome-project' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo Working on awesome-project');
      });

      it('should substitute {{WORKTREE_PATH}} variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'cd {{WORKTREE_PATH}} && ls',
          '/home/user/worktrees/wt-001',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('cd /home/user/worktrees/wt-001 && ls');
      });

      it('should substitute multiple variables in a single command', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo "WT {{WORKTREE_NUM}} for {{REPO}} on {{BRANCH}} at {{WORKTREE_PATH}}"',
          '/worktrees/wt-003',
          { worktreeNum: 3, branch: 'fix/bug-123', repo: 'test-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo "WT 3 for test-repo on fix/bug-123 at /worktrees/wt-003"');
      });
    });

    describe('arithmetic expressions', () => {
      it('should evaluate {{WORKTREE_NUM + N}} addition', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'export PORT={{WORKTREE_NUM + 3000}}',
          '/test/worktree',
          { worktreeNum: 5, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('export PORT=3005');
      });

      it('should evaluate {{WORKTREE_NUM - N}} subtraction', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo {{WORKTREE_NUM - 2}}',
          '/test/worktree',
          { worktreeNum: 10, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 8');
      });

      it('should evaluate {{WORKTREE_NUM * N}} multiplication', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo {{WORKTREE_NUM * 100}}',
          '/test/worktree',
          { worktreeNum: 3, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('echo 300');
      });

      it('should evaluate {{WORKTREE_NUM / N}} division (floor)', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo {{WORKTREE_NUM / 3}}',
          '/test/worktree',
          { worktreeNum: 10, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        // 10 / 3 = 3 (floor)
        expect(spawnCalls[0].args[2]).toBe('echo 3');
      });

      it('should handle arithmetic with spaces around operator', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'export PORT={{WORKTREE_NUM   +   8080}}',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[2]).toBe('export PORT=8081');
      });
    });

    describe('successful command execution', () => {
      it('should return success true and stdout output on exit code 0', async () => {
        setMockSpawnResult('command output here\nsecond line');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.executeHookCommand(
          'echo "hello"',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(true);
        expect(result.output).toBe('command output here\nsecond line');
        expect(result.error).toBeUndefined();
      });

      it('should return undefined output when stdout is empty', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.executeHookCommand(
          'silent-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(true);
        expect(result.output).toBeUndefined();
        expect(result.error).toBeUndefined();
      });
    });

    describe('failed command execution', () => {
      it('should return success false and stderr on non-zero exit code', async () => {
        setMockSpawnResult('partial output', 1, 'command not found');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.executeHookCommand(
          'invalid-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.output).toBe('partial output');
        expect(result.error).toBe('command not found');
      });

      it('should include exit code in error when stderr is empty', async () => {
        setMockSpawnResult('', 127, '');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.executeHookCommand(
          'nonexistent-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('127');
      });

      it('should handle various non-zero exit codes', async () => {
        setMockSpawnResult('', 2, 'permission denied');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const result = await service.executeHookCommand(
          'protected-command',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('permission denied');
      });
    });

    describe('environment variable injection', () => {
      it('should inject WORKTREE_NUM environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo $WORKTREE_NUM',
          '/test/worktree',
          { worktreeNum: 42, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.WORKTREE_NUM).toBe('42');
      });

      it('should inject BRANCH environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo $BRANCH',
          '/test/worktree',
          { worktreeNum: 1, branch: 'feature/new-feature', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.BRANCH).toBe('feature/new-feature');
      });

      it('should inject REPO environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo $REPO',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'test-repository' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.REPO).toBe('test-repository');
      });

      it('should inject WORKTREE_PATH environment variable', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo $WORKTREE_PATH',
          '/home/user/worktrees/wt-005',
          { worktreeNum: 5, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        expect(env.WORKTREE_PATH).toBe('/home/user/worktrees/wt-005');
      });

      it('should preserve existing process environment variables', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'echo $PATH',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        const env = spawnCalls[0].options.env as Record<string, string>;
        // Should still have PATH from process.env
        expect(env.PATH).toBeDefined();
      });
    });

    describe('command execution context', () => {
      it('should execute command in worktree directory (cwd)', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'pwd',
          '/home/user/worktrees/wt-001',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].options.cwd).toBe('/home/user/worktrees/wt-001');
      });

      it('should execute command via sh -c', async () => {
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        await service.executeHookCommand(
          'npm install && npm run build',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' }
        );

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args[0]).toBe('sh');
        expect(spawnCalls[0].args[1]).toBe('-c');
        expect(spawnCalls[0].args[2]).toBe('npm install && npm run build');
      });
    });

    // Issue #883 — executeHookCommand routes through runAsUser when elevation
    // would engage (AUTH_MODE=multi-user AND requestUsername differs from the
    // server-process user). Otherwise the historical direct-spawn behaviour
    // is preserved verbatim, including the getCleanChildProcessEnv() env
    // filter — see services/env-filter.ts.
    describe('privilege elevation (Issue #883)', () => {
      let originalAuthMode: string | undefined;

      beforeEach(() => {
        originalAuthMode = process.env.AUTH_MODE;
      });

      afterEach(() => {
        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
      });

      it('omitted requestUsername preserves direct Bun.spawn (legacy single-user)', async () => {
        delete process.env.AUTH_MODE;
        setMockSpawnResult('hello');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
        );

        expect(result.success).toBe(true);
        expect(spawnCalls.length).toBe(1);
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('null requestUsername preserves direct Bun.spawn (explicit single-user)', async () => {
        delete process.env.AUTH_MODE;
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
          null,
        );

        expect(spawnCalls.length).toBe(1);
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('non-null requestUsername with AUTH_MODE unset bypasses elevation', async () => {
        // shouldElevateForUser gates on BOTH AUTH_MODE=multi-user AND a
        // non-server username. With AUTH_MODE unset, even a non-null
        // username must NOT elevate — this preserves the single-user
        // env-filter path verbatim.
        delete process.env.AUTH_MODE;
        setMockSpawnResult('');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
          'alice-multiuser-test',
        );

        expect(spawnCalls.length).toBe(1);
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('multi-user mode with non-server username routes through runAsUser', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: 'hook output',
          stderr: '',
          exitCode: 0,
          timedOut: false, cwdFailed: false,
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 7, branch: 'feature/x', repo: 'my-repo' },
          'alice-multiuser-test',
        );

        expect(result.success).toBe(true);
        expect(result.output).toBe('hook output');
        // Bun.spawn must NOT have been called — the elevated branch routes
        // exclusively through runAsUser.
        expect(spawnCalls.length).toBe(0);

        expect(runAsUserMock.calls.length).toBe(1);
        const call = runAsUserMock.calls[0];
        expect(call.username).toBe('alice-multiuser-test');
        expect(call.cwd).toBe('/test/worktree');
        expect(call.command).toBe('echo hello');
        // The four hook variables are threaded through opts.env so
        // runAsUser embeds them via `export K=v` inside the elevated shell.
        expect(call.env).toEqual({
          WORKTREE_NUM: '7',
          BRANCH: 'feature/x',
          REPO: 'my-repo',
          WORKTREE_PATH: '/test/worktree',
        });
      });

      it('multi-user mode substitutes template variables before runAsUser', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.executeHookCommand(
          'export PORT={{WORKTREE_NUM + 3000}} && echo {{REPO}}',
          '/wt',
          { worktreeNum: 5, branch: 'feature/a', repo: 'my-repo' },
          'alice-multiuser-test',
        );

        expect(runAsUserMock.calls.length).toBe(1);
        expect(runAsUserMock.calls[0].command).toBe(
          'export PORT=3005 && echo my-repo',
        );
      });

      it('multi-user mode surfaces non-zero exit from runAsUser as failed result', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: 'partial',
          stderr: 'permission denied',
          exitCode: 1,
          timedOut: false, cwdFailed: false,
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'cmd',
          '/wt',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
        );

        expect(result.success).toBe(false);
        expect(result.output).toBe('partial');
        expect(result.error).toBe('permission denied');
      });

      it('multi-user mode falls back to exit-code message when stderr is empty', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: '',
          stderr: '',
          exitCode: 127,
          timedOut: false, cwdFailed: false,
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'cmd',
          '/wt',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('127');
      });

      it('multi-user mode reports an unusable worktree directory as "working directory not available"', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: '',
          stderr: "agent-console: working directory /wt is not available\n",
          exitCode: 125,
          timedOut: false,
          cwdFailed: true,
        });

        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'cmd',
          '/wt',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('working directory not available');
      });
    });

    describe('timeoutMs', () => {
      let originalAuthMode: string | undefined;

      beforeEach(() => {
        originalAuthMode = process.env.AUTH_MODE;
      });

      afterEach(() => {
        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
      });

      it('kills a slow real command at the deadline and reports a timeout', async () => {
        delete process.env.AUTH_MODE;
        // The surrounding describe replaces Bun.spawn with a stub; this case
        // needs a real shell.
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        const startedAt = Date.now();
        const result = await service.executeHookCommand(
          'sleep 5',
          '/tmp',
          { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
          null,
          100,
        );
        const elapsedMs = Date.now() - startedAt;

        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out');
        expect(elapsedMs).toBeLessThan(1000);
      });

      it('returns at the deadline even when the pipes never close, and signals the child', async () => {
        delete process.env.AUTH_MODE;
        // A pid far above any kernel pid_max, so a stray real signal is ESRCH.
        const fakePid = 2_147_483_000;
        // The process-table read (`ps`) goes through Bun.spawn too, so it must
        // reach the real one; only the hook shell is faked.
        const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((
          cmd: string[],
          options?: Record<string, unknown>,
        ) => {
          if (cmd[0] === 'ps') {
            return originalBunSpawn(cmd, options as Parameters<typeof originalBunSpawn>[1]);
          }
          return {
            pid: fakePid,
            exited: new Promise<number>(() => {}),
            stdout: new ReadableStream<Uint8Array>({ start() {} }),
            stderr: new ReadableStream<Uint8Array>({ start() {} }),
          } as ReturnType<typeof Bun.spawn>;
        }) as typeof Bun.spawn);
        const signalled: Array<[number, string | number | undefined]> = [];
        const killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
          signalled.push([pid, signal]);
          return true;
        }) as typeof process.kill);
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        try {
          const result = await service.executeHookCommand(
            'hang',
            '/test/worktree',
            { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
            null,
            50,
          );

          expect(result.success).toBe(false);
          expect(result.error).toBe('Command timed out after 50 ms');
          // The tree kill runs in the background after the request returned.
          const deadline = Date.now() + 2000;
          while (!signalled.some(([pid, sig]) => pid === fakePid && sig === 'SIGTERM') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(signalled).toContainEqual([fakePid, 'SIGTERM']);
        } finally {
          killSpy.mockRestore();
          spawnSpy.mockRestore();
        }
      });

      // Real-spawn coverage of the process-tree kill. The hook shell backgrounds
      // a `sleep` (a grandchild) whose duration token is unique per run, so
      // `ps` can tell it from every other sleep on the host. Killing only the
      // shell (the old `proc.kill()`) leaves that grandchild running, the same
      // residue process-tree.test.ts reproduces at its 'reproduces the leak'
      // case.
      //
      // Measured polarity (reach recorded as test names that failed):
      //  - new kill logic replaced by `proc.kill()` only: 'kills a grandchild of
      //    the hook shell at the deadline', 'kills a grandchild that ignores
      //    SIGTERM, via the SIGKILL after the grace' and 'returns at the
      //    deadline even when the pipes never close, and signals the child'
      //    all fail (the grandchildren survive).
      //  - only the SIGKILL-after-grace step removed: 'kills a grandchild of
      //    the hook shell at the deadline' still PASSES (a plain `sleep` dies
      //    on SIGTERM, so it does not pin the SIGKILL step); only 'kills a
      //    grandchild that ignores SIGTERM, via the SIGKILL after the grace'
      //    FAILS, and it is the case that pins it.
      const psLinesContaining = async (token: string): Promise<string[]> => {
        const ps = originalBunSpawn(['ps', '-eo', 'pid,args'], { stdout: 'pipe', stderr: 'ignore' });
        const text = await new Response(ps.stdout).text();
        await ps.exited;
        return text.split('\n').filter((line) => line.includes(token));
      };
      const killByToken = async (token: string): Promise<void> => {
        for (const line of await psLinesContaining(token)) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      };
      const waitForTokenGone = async (token: string, withinMs: number): Promise<boolean> => {
        const deadline = Date.now() + withinMs;
        while (Date.now() < deadline) {
          if ((await psLinesContaining(token)).length === 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return (await psLinesContaining(token)).length === 0;
      };
      const waitForTokenVisible = async (token: string): Promise<boolean> => {
        const deadline = Date.now() + 150;
        while (Date.now() < deadline) {
          if ((await psLinesContaining(token)).length > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return (await psLinesContaining(token)).length > 0;
      };
      const uniqueSleepToken = (): string =>
        `30.${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`;

      it('kills a grandchild of the hook shell at the deadline', async () => {
        delete process.env.AUTH_MODE;
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
        const token = uniqueSleepToken();
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        try {
          const startedAt = Date.now();
          const call = service.executeHookCommand(
            `sh -c 'sleep ${token} & sleep ${token}; true # hook-grandchild-${crypto.randomUUID()}'`,
            '/tmp',
            { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
            null,
            200,
          );
          // Positive control: the instrument can see the grandchild while it runs.
          expect(await waitForTokenVisible(token)).toBe(true);
          const result = await call;
          const elapsedMs = Date.now() - startedAt;

          expect(result.success).toBe(false);
          expect(result.error).toBe('Command timed out after 200 ms');
          expect(elapsedMs).toBeLessThan(1500);
          expect(await waitForTokenGone(token, 3000)).toBe(true);
        } finally {
          await killByToken(token);
        }
      }, 15000);

      it('kills a grandchild that ignores SIGTERM, via the SIGKILL after the grace', async () => {
        delete process.env.AUTH_MODE;
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
        const token = uniqueSleepToken();
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });

        try {
          const call = service.executeHookCommand(
            `sh -c 'trap "" TERM; sleep ${token} # hook-grandchild-${crypto.randomUUID()}'`,
            '/tmp',
            { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
            null,
            200,
          );
          expect(await waitForTokenVisible(token)).toBe(true);
          const result = await call;
          expect(result.error).toBe('Command timed out after 200 ms');

          // Still alive just after the deadline plus most of the grace: it
          // ignores SIGTERM. Then gone once the SIGKILL lands (200 ms + 2 s).
          await new Promise((resolve) => setTimeout(resolve, 1000));
          expect((await psLinesContaining(token)).length).toBeGreaterThan(0);
          expect(await waitForTokenGone(token, 4000)).toBe(true);
        } finally {
          await killByToken(token);
        }
      }, 15000);

      it('arms no timer when timeoutMs is absent', async () => {
        delete process.env.AUTH_MODE;
        setMockSpawnResult('done');
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({ worktreeRepository: mockRepo });
        const originalSetTimeout = globalThis.setTimeout;
        let timersArmed = 0;
        globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          timersArmed++;
          return originalSetTimeout(...args);
        }) as typeof setTimeout;

        try {
          const result = await service.executeHookCommand(
            'echo done',
            '/test/worktree',
            { worktreeNum: 1, branch: 'main', repo: 'my-repo' },
          );
          expect(result.success).toBe(true);
        } finally {
          globalThis.setTimeout = originalSetTimeout;
        }

        expect(timersArmed).toBe(0);
      });

      it('elevated branch forwards timeoutMs to runAsUser', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
          1234,
        );

        expect(runAsUserMock.calls.length).toBe(1);
        expect(runAsUserMock.calls[0].timeoutMs).toBe(1234);
      });

      it('elevated branch passes no timeoutMs when the parameter is absent', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        await service.executeHookCommand(
          'echo hello',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
        );

        expect(runAsUserMock.calls.length).toBe(1);
        expect('timeoutMs' in runAsUserMock.calls[0]).toBe(false);
      });

      it('elevated branch reports a timed-out run as a failed result', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: 'partial',
          stderr: '',
          exitCode: 137,
          timedOut: true,
          cwdFailed: false,
        });
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'sleep 100',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
          500,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Command timed out after 500 ms');
        expect(result.output).toBe('partial');
      });

      it('elevated branch returns at the deadline even when runAsUser never settles', async () => {
        process.env.AUTH_MODE = 'multi-user';
        // A grandchild holding a pipe open keeps runAsUser pending past its own
        // timeout; model that with a promise that never resolves.
        runAsUserMock.responder.fn = () => new Promise<RunAsUserResult>(() => {});
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const startedAt = Date.now();
        const result = await service.executeHookCommand(
          'sleep 300 &',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
          200,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Command timed out after 200 ms');
        expect(Date.now() - startedAt).toBeLessThan(1000);
      }, 3000);

      it('elevated branch maps a cwdFailed result that settles inside the deadline', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => ({
          stdout: '',
          stderr: '',
          exitCode: 1,
          timedOut: false,
          cwdFailed: true,
        });
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'echo hi',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
          5000,
        );

        expect(result).toEqual({ success: false, error: 'working directory not available' });
      });

      it('elevated branch without a time box still waits for runAsUser', async () => {
        process.env.AUTH_MODE = 'multi-user';
        runAsUserMock.responder.fn = async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { stdout: 'late', stderr: '', exitCode: 0, timedOut: false, cwdFailed: false };
        };
        const WorktreeService = await getWorktreeService();
        const service = new WorktreeService({
          worktreeRepository: mockRepo,
          runAsUserImpl: runAsUserMock.runAsUserImpl,
        });

        const result = await service.executeHookCommand(
          'echo late',
          '/test/worktree',
          { worktreeNum: 1, branch: 'main', repo: 'r' },
          'alice-multiuser-test',
        );

        expect(result).toEqual({ success: true, output: 'late' });
      });
    });
  });
});
