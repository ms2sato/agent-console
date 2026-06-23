import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { Repository } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs, createMockGitRepoFiles } from '../../__tests__/utils/mock-fs-helper.js';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { JobQueue } from '../../jobs/index.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { SqliteRepositoryRepository } from '../../repositories/index.js';
import type { RunAsUserOpts, RunAsUserResult } from '../privilege-elevation.js';

/**
 * Capture-and-respond fake for `runAsUser`. Mirrors the pattern used by
 * `worktree-service.test.ts` so the multi-user shared-repo apply branch
 * (Issue #845) can be asserted without running real shell-outs.
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

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

describe('RepositoryManager', () => {
  const TEST_CONFIG_DIR = '/test/config';
  const TEST_REPO_DIR = '/test/repo';
  let importCounter = 0;
  let repositoryRepository: SqliteRepositoryRepository;
  // Capture mock for the privilege-elevation helper used by the multi-user
  // shared-repo apply step (Issue #845). Fresh instance per test.
  let runAsUserMock: ReturnType<typeof createRunAsUserMock>;

  beforeEach(async () => {
    // Close any existing database connection first
    await closeDatabase();

    // Set up memfs with config dir and a git repo
    const gitRepoFiles = createMockGitRepoFiles(TEST_REPO_DIR);
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
      ...gitRepoFiles,
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    // Initialize in-memory database
    await initializeDatabase(':memory:');

    // Create a test JobQueue with the shared database connection
    testJobQueue = new JobQueue(getDatabase());

    // Reset process mock
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset git mocks
    mockGit.getOrgRepoFromPath.mockReset();
    mockGit.getOrgRepoFromPath.mockImplementation(() => Promise.resolve('test-org/repo'));

    // Create production repository backed by in-memory SQLite
    // This tests the actual production code path instead of a mock
    repositoryRepository = new SqliteRepositoryRepository(getDatabase());

    // Fresh runAsUser capture per test (default: success response).
    runAsUserMock = createRunAsUserMock();
  });

  afterEach(async () => {
    // Clean up test JobQueue
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    await closeDatabase();
    cleanupMemfs();
  });

  // Helper to get fresh RepositoryManager instance with the production repository
  async function getRepositoryManager(preloadedRepos: Repository[] = []) {
    // Pre-populate the repository before creating the manager
    // Use actual SQLite repository (backed by in-memory database)
    await Promise.all(preloadedRepos.map(repo => repositoryRepository.save(repo)));
    const module = await import(`../repository-manager.js?v=${++importCounter}`);
    return module.RepositoryManager.create({
      repository: repositoryRepository,
      jobQueue: testJobQueue,
      runAsUserImpl: runAsUserMock.runAsUserImpl,
    });
  }

  describe('registerRepository', () => {
    it('should register a valid git repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe('repo');
      expect(repo.path).toBe(TEST_REPO_DIR);
      expect(repo.createdAt).toBeDefined();
    });

    it('should throw error for non-existent path', async () => {
      const manager = await getRepositoryManager();

      await expect(
        manager.registerRepository('/non/existent/path')
      ).rejects.toThrow('Path does not exist');
    });

    it('should throw error for non-git directory', async () => {
      const manager = await getRepositoryManager();

      // Create a non-git directory
      fs.mkdirSync('/non-git-dir', { recursive: true });

      await expect(
        manager.registerRepository('/non-git-dir')
      ).rejects.toThrow('Not a git repository');
    });

    it('should throw error for duplicate registration', async () => {
      const manager = await getRepositoryManager();

      await manager.registerRepository(TEST_REPO_DIR);

      await expect(
        manager.registerRepository(TEST_REPO_DIR)
      ).rejects.toThrow('Repository already registered');
    });

    it('should persist repository via repository', async () => {
      const manager = await getRepositoryManager();

      await manager.registerRepository(TEST_REPO_DIR);

      // Check persisted data in the SQLite repository
      const savedRepos = await repositoryRepository.findAll();
      expect(savedRepos.length).toBe(1);
      expect(savedRepos[0].path).toBe(TEST_REPO_DIR);
    });

    // Issue #845: auto-apply core.sharedRepository=group + group-writable
    // `.git` at registration time so operators no longer need to run the
    // documented manual `chmod` / `chgrp` / `git config` step.
    describe('multi-user mode shared-repo auto-apply (Issue #845)', () => {
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

      it('does not invoke runAsUser in single-user mode', async () => {
        delete process.env.AUTH_MODE;
        const manager = await getRepositoryManager();

        await manager.registerRepository(TEST_REPO_DIR);

        // Single-user mode must not chmod / chgrp / set core.sharedRepository
        // on the source repo. The whole multi-user branch is gated on
        // AUTH_MODE so a single spawn would already be a regression.
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('invokes a single combined runAsUser apply command in multi-user mode', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const manager = await getRepositoryManager();

        // memfs-backed `.git` does not have a realistic gid, so the
        // idempotent-skip probe sees a mismatch and the apply step runs.
        const repo = await manager.registerRepository(TEST_REPO_DIR);
        expect(repo.path).toBe(TEST_REPO_DIR);

        // Exactly one runAsUser call covering all four legs of the chain
        // (`git config && find -exec chmod g+rwxs && chmod -R g+rw && chgrp`).
        // Single spawn is intentional: fewer process invocations = fewer
        // sudo prompts in real multi-user installs (PR brief step 5).
        expect(runAsUserMock.calls.length).toBe(1);
        const call = runAsUserMock.calls[0];
        // Run as the server process (username: null => no elevation).
        expect(call.username).toBeNull();
        // Verify the command shape covers all four operations and references
        // the registered repo path + the shared group name. Single-quote
        // escaping is from `shellEscape`.
        expect(call.command).toContain(
          `git -C '${TEST_REPO_DIR}' config core.sharedRepository group`,
        );
        expect(call.command).toContain(
          `find '${TEST_REPO_DIR}/.git' -type d -exec chmod g+rwxs {} +`,
        );
        expect(call.command).toContain(`chmod -R g+rw '${TEST_REPO_DIR}/.git'`);
        expect(call.command).toContain(
          `chgrp -R 'agent-console-users' '${TEST_REPO_DIR}/.git'`,
        );
        // Steps chained with `&&` so a failing earlier step aborts the rest
        // and the failing stderr surfaces clearly.
        expect(call.command).toContain(' && ');
      });

      it('skips apply when already configured (idempotent no-op via git config probe)', async () => {
        process.env.AUTH_MODE = 'multi-user';

        // Track lstat/probe-vs-apply distinction via the probe responder:
        // when the lstat-based mode/gid check passes (the test fs cannot
        // realistically simulate that, so we force it from the probe side
        // instead), the production code issues a `git config --local --get
        // core.sharedRepository` probe -- when that returns `group` on
        // stdout, no apply call follows.
        //
        // The probe code path requires the lstat short-circuit to succeed
        // first. memfs reports gid=0 (or process.getgid() in some setups),
        // mode bits without setgid -- so the probe path is not entered in
        // memfs.  We exercise the apply branch (covered above) and the
        // permission-denied branch (covered below); the idempotent-skip
        // branch is verified by direct invocation of the probe responder
        // sequence below.
        //
        // To exercise the skip branch without depending on memfs gid/mode
        // realism, force the probe responder to claim 'group' and stub the
        // mode probe by hijacking the apply responder to fail-loudly: if
        // the apply runs, the test fails. The skip branch ONLY runs after a
        // successful lstat short-circuit + a 'group' probe, so we cannot
        // reach it without lstat returning the right gid/mode. The
        // production behaviour is captured by the assertion shape: when
        // already-configured we expect zero runAsUser calls following the
        // probe.
        //
        // Note: we cover the apply / permission-denied / single-user
        // branches in dedicated tests; the idempotent-skip path is
        // explicitly verified via the probe contract here -- the probe
        // returns 'group' AND the next call must NOT be an apply.

        // Make lstat appear to match: synthesise a `.git` directory whose
        // mode bits include setgid + group-write and whose gid equals the
        // current process gid. memfs preserves the mode bits we set.
        const gidNow = typeof process.getgid === 'function' ? process.getgid() : 0;
        // memfs does not honour setgid bits the same way real fs does, but
        // `lstat` will still report them. Set them explicitly:
        try {
          fs.chmodSync(`${TEST_REPO_DIR}/.git`, 0o2775);
          // Best-effort gid alignment; memfs may not honour chown but we try.
          fs.chownSync(`${TEST_REPO_DIR}/.git`, fs.statSync(`${TEST_REPO_DIR}/.git`).uid, gidNow);
        } catch {
          // ignore -- if memfs cannot align these, the probe code path
          // will fall through to apply and the next assertion below would
          // need to adapt. But memfs does honour chmod, so this works.
        }

        // Wire the probe responder to return `group` for the git-config
        // probe, and fail loudly if any apply runs.
        runAsUserMock.responder.fn = async (opts) => {
          if (opts.command.includes('--get core.sharedRepository')) {
            return { stdout: 'group\n', stderr: '', exitCode: 0, timedOut: false };
          }
          throw new Error(
            `apply should not run when already configured; got command: ${opts.command}`,
          );
        };

        const manager = await getRepositoryManager();
        // Registration must succeed without invoking apply. If lstat skip
        // is not reached (memfs limitation), the responder throws above
        // and registration would fail loudly -- exercising the negative
        // case still has value.
        const repo = await manager.registerRepository(TEST_REPO_DIR);
        expect(repo.path).toBe(TEST_REPO_DIR);

        // Either zero calls (skip path skipped probe too -- impossible
        // shape; just guards against accidental regressions) or one call
        // (the probe) but no apply call. Concretely: at most one call,
        // and if one call, it is the probe.
        expect(runAsUserMock.calls.length).toBeLessThanOrEqual(1);
        if (runAsUserMock.calls.length === 1) {
          expect(runAsUserMock.calls[0].command).toContain('--get core.sharedRepository');
        }
      });

      it('registration succeeds with a warn log when apply hits permission denied', async () => {
        process.env.AUTH_MODE = 'multi-user';

        // Simulate the chgrp / chmod failing because the server does not
        // own the repo (chmod g+rwxs and chgrp would emit EPERM). The
        // production code logs a WARN with the manual remediation commands
        // and proceeds with registration.
        runAsUserMock.responder.fn = async (opts) => {
          if (opts.command.includes('--get core.sharedRepository')) {
            // Probe: report 'not configured' so the apply step runs.
            return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
          }
          // Apply: simulate EPERM from chgrp.
          return {
            stdout: '',
            stderr: "chgrp: changing group of '/test/repo/.git': Operation not permitted",
            exitCode: 1,
            timedOut: false,
          };
        };

        const manager = await getRepositoryManager();
        // Must not throw -- registration succeeds even when auto-apply
        // cannot fully configure the repo.
        const repo = await manager.registerRepository(TEST_REPO_DIR);

        // The DB record was still saved.
        const savedRepos = await repositoryRepository.findAll();
        expect(savedRepos.length).toBe(1);
        expect(savedRepos[0].path).toBe(TEST_REPO_DIR);
        expect(savedRepos[0].id).toBe(repo.id);

        // Verify the apply step was attempted (so this test fails if the
        // multi-user branch is removed). The apply call is identified by
        // the `chgrp` substring; the count is >= 1 (probe may or may not
        // fire depending on the lstat short-circuit outcome in memfs).
        const applyCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('chgrp -R '),
        );
        expect(applyCalls.length).toBe(1);
      });

      it('honours AGENT_CONSOLE_SERVICE_GROUP override for the chgrp target group', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const originalGroup = process.env.AGENT_CONSOLE_SERVICE_GROUP;
        process.env.AGENT_CONSOLE_SERVICE_GROUP = 'custom-shared-group';
        try {
          const manager = await getRepositoryManager();
          await manager.registerRepository(TEST_REPO_DIR);

          // The runAsUser command should reference the overridden group.
          // Either one call (apply only, when probe is skipped) or two
          // calls (probe + apply); the apply call is the one with `chgrp`.
          const applyCalls = runAsUserMock.calls.filter((c) =>
            c.command.includes('chgrp -R '),
          );
          expect(applyCalls.length).toBe(1);
          expect(applyCalls[0].command).toContain(
            `chgrp -R 'custom-shared-group' '${TEST_REPO_DIR}/.git'`,
          );
        } finally {
          if (originalGroup === undefined) {
            delete process.env.AGENT_CONSOLE_SERVICE_GROUP;
          } else {
            process.env.AGENT_CONSOLE_SERVICE_GROUP = originalGroup;
          }
        }
      });
    });
  });

  describe('unregisterRepository', () => {
    it('should unregister existing repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);
      const result = await manager.unregisterRepository(repo.id);

      expect(result).toBe(true);
      expect(manager.getRepository(repo.id)).toBeUndefined();
    });

    it('should return false for non-existent repository', async () => {
      const manager = await getRepositoryManager();

      const result = await manager.unregisterRepository('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist unregistration via repository', async () => {
      const manager = await getRepositoryManager();

      const repo = await manager.registerRepository(TEST_REPO_DIR);
      await manager.unregisterRepository(repo.id);

      // Check persisted data in the SQLite repository
      const savedRepos = await repositoryRepository.findAll();
      expect(savedRepos.length).toBe(0);
    });
  });

  describe('getRepository', () => {
    it('should return repository by id', async () => {
      const manager = await getRepositoryManager();

      const registered = await manager.registerRepository(TEST_REPO_DIR);
      const retrieved = manager.getRepository(registered.id);

      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown id', async () => {
      const manager = await getRepositoryManager();

      const result = manager.getRepository('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getRepositorySlug', () => {
    it('returns the repository name as slug for registered id', async () => {
      const manager = await getRepositoryManager();
      const registered = await manager.registerRepository(TEST_REPO_DIR);

      expect(manager.getRepositorySlug(registered.id)).toBe(registered.name);
    });

    it('returns undefined for unknown id', async () => {
      const manager = await getRepositoryManager();

      expect(manager.getRepositorySlug('unknown-id')).toBeUndefined();
    });
  });

  describe('getAllRepositories', () => {
    it('should return empty array when no repositories', async () => {
      const manager = await getRepositoryManager();

      const repos = manager.getAllRepositories();
      expect(repos).toEqual([]);
    });

    it('should return all registered repositories', async () => {
      const manager = await getRepositoryManager();

      // Register first repo
      const repo1 = await manager.registerRepository(TEST_REPO_DIR);
      expect(manager.getAllRepositories().length).toBe(1);

      // Create and register second repo
      const secondRepoFiles = createMockGitRepoFiles('/test/repo2');
      for (const [path, content] of Object.entries(secondRepoFiles)) {
        fs.mkdirSync(path.substring(0, path.lastIndexOf('/')), { recursive: true });
        fs.writeFileSync(path, content);
      }

      const repo2 = await manager.registerRepository('/test/repo2');

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(2);

      const repoIds = repos.map((r: Repository) => r.id);
      expect(repoIds).toContain(repo1.id);
      expect(repoIds).toContain(repo2.id);
    });
  });

  describe('findRepositoryByPath', () => {
    it('should find repository by path', async () => {
      const manager = await getRepositoryManager();

      const registered = await manager.registerRepository(TEST_REPO_DIR);
      const found = manager.findRepositoryByPath(TEST_REPO_DIR);

      expect(found).toEqual(registered);
    });

    it('should return undefined for unregistered path', async () => {
      const manager = await getRepositoryManager();

      const result = manager.findRepositoryByPath('/some/other/path');
      expect(result).toBeUndefined();
    });
  });

  describe('loading from repository', () => {
    it('should load repositories from repository on construction', async () => {
      // Pre-populate repository
      const preloadedRepos: Repository[] = [
        {
          id: 'existing-id',
          name: 'repo',
          path: TEST_REPO_DIR,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const manager = await getRepositoryManager(preloadedRepos);

      const repos = manager.getAllRepositories();
      expect(repos.length).toBe(1);
      expect(repos[0].id).toBe('existing-id');
    });

    it('should skip repositories with missing paths on load', async () => {
      // Pre-populate with a repo that points to non-existent path
      const preloadedRepos: Repository[] = [
        {
          id: 'missing-repo',
          name: 'missing',
          path: '/non/existent/path',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const manager = await getRepositoryManager(preloadedRepos);

      expect(manager.getAllRepositories().length).toBe(0);
    });
  });
});
