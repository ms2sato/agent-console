import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import * as fs from 'fs';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit, GitError } from '../../__tests__/utils/mock-git-helper.js';
import type { Worktree } from '@agent-console/shared';
import type { WorktreeRepository, WorktreeRecord } from '../../repositories/worktree-repository.js';
import type { RunAsUserOpts, RunAsUserResult } from '../privilege-elevation.js';

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
      timedOut: false,
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
    mockGit.getRemoteUrl.mockReset();
    mockGit.parseOrgRepo.mockReset();
    mockGit.listWorktrees.mockReset();
    mockGit.removeWorktree.mockReset();
    mockGit.listLocalBranches.mockReset();
    mockGit.listRemoteBranches.mockReset();
    mockGit.getDefaultBranch.mockReset();

    // Default implementations
    mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo-name.git'));
    mockGit.parseOrgRepo.mockImplementation(() => 'owner/repo-name');
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

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

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

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

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

      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      expect(worktrees[0].branch).toBe('(detached at abc1234)');
    });

    it('should return empty array on error', async () => {
      mockGit.listWorktrees.mockImplementation(() => Promise.reject(new Error('git error')));

      const WorktreeService = await getWorktreeService();
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const worktrees = await service.listWorktrees('/repo', 'repo-1');
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
      const worktrees = await service.listWorktrees('/repo/main', 'repo-1');

      // Should include: main + feature-1 (from git) + orphaned-1 (from DB only)
      expect(worktrees.length).toBe(3);
      const orphaned = worktrees.find((wt: Worktree) => wt.path === '/worktrees/orphaned-1');
      expect(orphaned).toBeDefined();
      expect(orphaned!.branch).toBe('(orphaned)');
      expect(orphaned!.index).toBe(2);
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
    // repo has no commits (unborn HEAD). Wraps `git rev-parse --verify
    // HEAD^{commit}` -- any GitError becomes an EmptyRepositoryError with a
    // fixed user-facing message; other errors propagate as-is.
    beforeEach(() => {
      mockGit.git.mockReset();
      // Default: git resolves (repo has commits). Individual tests override
      // to reject when they need to exercise the empty-repo branch.
      mockGit.git.mockImplementation(() => Promise.resolve(''));
    });

    it('throws EmptyRepositoryError with the exact user-facing message when git rev-parse fails', async () => {
      // Simulate `git rev-parse --verify HEAD^{commit}` failing because the
      // repo has no commits yet.
      mockGit.git.mockImplementation(() =>
        Promise.reject(
          new GitError(
            "git rev-parse failed: fatal: Needed a single revision",
            128,
            'fatal: Needed a single revision',
          ),
        ),
      );

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
      // The exact string must not drift silently -- Issue #921's user-facing
      // contract.
      expect((caught as Error).message).toBe(
        'The source repository has no commits yet. Create at least one commit (an empty commit is fine: git commit --allow-empty -m "initial commit") in the source repo before creating a worktree.',
      );
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

    it('resolves when git accepts the rev-parse', async () => {
      // Default beforeEach already wires git() to resolve; happy path just
      // returns undefined without throwing.
      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      const result = await service.ensureRepoHasCommits('/repo/main');
      expect(result).toBeUndefined();
    });

    it('forwards null requestUsername to git() (single-user branch)', async () => {
      const { WorktreeService } = await import(`../worktree-service.js?v=${++importCounter}`);
      const service = new WorktreeService({ worktreeRepository: mockRepo });

      await service.ensureRepoHasCommits('/repo/main');

      // 4th positional arg (`requestUser`) should be undefined when the
      // caller does not provide it. This is the single-user code path --
      // `git()` uses its direct-spawn branch.
      expect(mockGit.git).toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
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
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        '/repo/main',
        undefined,
        'alice',
      );
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
        timedOut: false,
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
              timedOut: false,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
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
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return {
          stdout: '',
          stderr: 'fatal: worktree has uncommitted changes',
          exitCode: 128,
          timedOut: false,
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
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return {
          stdout: '',
          stderr: 'fatal: not a git repository (or any of the parent directories): .git',
          exitCode: 128,
          timedOut: false,
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
            timedOut: false,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
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
            timedOut: false,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
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
          timedOut: false,
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
          timedOut: false,
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
          timedOut: false,
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
          timedOut: false,
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
    });
  });
});
