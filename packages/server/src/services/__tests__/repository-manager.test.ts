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
import { buildManualFallbackCommands } from '../repository-manager.js';

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

      // Synthetic shared-group gid used by tests to drive the `getent group`
      // resolution. Real production reads this from /etc/group; tests stub
      // the responder to return this value via the `getent group <name>`
      // wire format `name:x:<gid>:members`.
      const FAKE_SHARED_GID = 9876;

      /**
       * Default multi-user responder: simulates a freshly-cloned source
       * repo whose `.git/` does NOT yet have the shared-group gid /
       * core.sharedRepository setting, so the apply step runs. `getent`
       * resolves the shared group's gid to `FAKE_SHARED_GID`; the lstat
       * probe sees a mismatch (memfs gid != FAKE_SHARED_GID), so the
       * `git config --get` probe is never attempted. The apply call
       * succeeds.
       */
      function defaultFreshRepoResponder(opts: RunAsUserOpts): Promise<RunAsUserResult> {
        if (opts.command.startsWith('getent group ')) {
          // Wire format: `name:x:gid:members`. Extract name from the
          // shell-escaped second token.
          return Promise.resolve({
            stdout: `agent-console-users:x:${FAKE_SHARED_GID}:agentconsole\n`,
            stderr: '',
            exitCode: 0,
            timedOut: false,
          });
        }
        // Apply / git config probe / anything else: success.
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        });
      }

      beforeEach(() => {
        originalAuthMode = process.env.AUTH_MODE;
        runAsUserMock.responder.fn = defaultFreshRepoResponder;
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

        // Single-user mode must not resolve the shared group, chmod, chgrp,
        // or set core.sharedRepository on the source repo. The whole
        // multi-user branch is gated on AUTH_MODE so even a single spawn
        // would already be a regression.
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('invokes a single combined runAsUser apply command in multi-user mode', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const manager = await getRepositoryManager();

        // memfs-backed `.git`'s gid does not match FAKE_SHARED_GID, so the
        // lstat short-circuit fails and the apply step runs.
        const repo = await manager.registerRepository(TEST_REPO_DIR);
        expect(repo.path).toBe(TEST_REPO_DIR);

        // Two runAsUser calls: (1) `getent group` to resolve the shared
        // group's gid, (2) the combined apply command. The git-config
        // probe is NOT attempted because the lstat short-circuit fails on
        // gid mismatch in memfs. Apply remains a single spawn covering
        // all four legs.
        const applyCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('chgrp -R '),
        );
        expect(applyCalls.length).toBe(1);
        const apply = applyCalls[0];
        // Run as the server process (username: null => no elevation).
        expect(apply.username).toBeNull();
        // Verify the command shape covers all four operations and references
        // the registered repo path + the shared group name. Single-quote
        // escaping is from `shellEscape`.
        expect(apply.command).toContain(
          `git -C '${TEST_REPO_DIR}' config core.sharedRepository group`,
        );
        expect(apply.command).toContain(
          `find '${TEST_REPO_DIR}/.git' -type d -exec chmod g+rwxs {} +`,
        );
        expect(apply.command).toContain(`chmod -R g+rw '${TEST_REPO_DIR}/.git'`);
        expect(apply.command).toContain(
          `chgrp -R 'agent-console-users' '${TEST_REPO_DIR}/.git'`,
        );
        // Steps chained with `&&` so a failing earlier step aborts the rest
        // and the failing stderr surfaces clearly.
        expect(apply.command).toContain(' && ');

        // Confirm `getent group` was invoked to resolve the shared gid.
        const getentCalls = runAsUserMock.calls.filter((c) =>
          c.command.startsWith('getent group '),
        );
        expect(getentCalls.length).toBe(1);
        expect(getentCalls[0].command).toContain(`'agent-console-users'`);
      });

      it('skips apply when already configured (idempotent no-op via git config probe)', async () => {
        process.env.AUTH_MODE = 'multi-user';

        // Align memfs `.git/` mode bits + gid to what the apply step would
        // produce: setgid + group-rwx (octal 2775), gid = FAKE_SHARED_GID.
        // memfs honours both `chmod` and `chown` for owned files / dirs,
        // so `lstat` will report these values.
        const gitDirAbs = `${TEST_REPO_DIR}/.git`;
        const beforeStat = fs.statSync(gitDirAbs);
        fs.chmodSync(gitDirAbs, 0o2775);
        fs.chownSync(gitDirAbs, beforeStat.uid, FAKE_SHARED_GID);

        // Replace the responder so `getent group` returns FAKE_SHARED_GID
        // (matching the synthesised dir gid) AND the `git config --get
        // core.sharedRepository` probe returns 'group'. The apply call
        // MUST NOT run -- enforce by throwing if it's invoked. The
        // server-side safe.directory bootstrap (Issue #853) is a separate,
        // unrelated runAsUser call and MUST be permitted (it always runs
        // in multi-user mode regardless of the shared-repo apply state).
        runAsUserMock.responder.fn = async (opts) => {
          if (opts.command.startsWith('getent group ')) {
            return {
              stdout: `agent-console-users:x:${FAKE_SHARED_GID}:agentconsole\n`,
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          if (opts.command.includes('--get core.sharedRepository')) {
            return {
              stdout: 'group\n',
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          if (opts.command.includes('safe.directory')) {
            // Server-side safe.directory bootstrap (Issue #853); permitted.
            return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
          }
          throw new Error(
            `apply should not run when already configured; got command: ${opts.command}`,
          );
        };

        const manager = await getRepositoryManager();
        const repo = await manager.registerRepository(TEST_REPO_DIR);
        expect(repo.path).toBe(TEST_REPO_DIR);

        // Three runAsUser calls -- the `getent` resolve + the
        // `git config --get core.sharedRepository` probe + the server-side
        // safe.directory bootstrap (Issue #853) -- AND no apply call. The
        // probe-first contract ensures we tightly assert the idempotent-skip
        // path was actually taken (not bypassed early).
        expect(runAsUserMock.calls.length).toBe(3);
        expect(runAsUserMock.calls[0].command).toContain('getent group ');
        expect(runAsUserMock.calls[1].command).toContain('--get core.sharedRepository');
        expect(runAsUserMock.calls[2].command).toContain('safe.directory');
        const applyCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('chgrp -R '),
        );
        expect(applyCalls.length).toBe(0);
      });

      it('registration succeeds with a warn log when apply hits permission denied', async () => {
        process.env.AUTH_MODE = 'multi-user';

        // Simulate the chgrp / chmod failing because the server does not
        // own the repo (chmod g+rwxs and chgrp would emit EPERM). The
        // production code logs a WARN containing the manual remediation
        // commands and proceeds with registration.
        runAsUserMock.responder.fn = async (opts) => {
          if (opts.command.startsWith('getent group ')) {
            return {
              stdout: `agent-console-users:x:${FAKE_SHARED_GID}:agentconsole\n`,
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          if (opts.command.includes('--get core.sharedRepository')) {
            return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
          }
          // Apply: simulate EPERM from chgrp.
          return {
            stdout: '',
            stderr: `chgrp: changing group of '${TEST_REPO_DIR}/.git': Operation not permitted`,
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
        // the `chgrp` substring.
        const applyCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('chgrp -R '),
        );
        expect(applyCalls.length).toBe(1);

        // The WARN-log embeds `buildManualFallbackCommands(...)` as a
        // structured array operators can copy-paste. Assert the exported
        // helper produces a non-empty list and that every command shape
        // present in the docs section is in the output. This pins the
        // contract the production WARN log delivers without depending on
        // pino-internal log-capture plumbing.
        const fallback = buildManualFallbackCommands(TEST_REPO_DIR, 'agent-console-users');
        expect(fallback.length).toBe(4);
        expect(fallback.some((c) => c.includes('git config core.sharedRepository group'))).toBe(true);
        expect(fallback.some((c) => c.includes('chmod g+rwxs'))).toBe(true);
        expect(fallback.some((c) => c.includes('chmod -R g+rw'))).toBe(true);
        expect(fallback.some((c) => c.includes('chgrp -R agent-console-users'))).toBe(true);
      });

      it('honours AGENT_CONSOLE_SERVICE_GROUP override for the chgrp target group', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const originalGroup = process.env.AGENT_CONSOLE_SERVICE_GROUP;
        process.env.AGENT_CONSOLE_SERVICE_GROUP = 'custom-shared-group';
        try {
          const manager = await getRepositoryManager();
          await manager.registerRepository(TEST_REPO_DIR);

          // The runAsUser command should reference the overridden group in
          // BOTH legs: the `getent group` lookup and the apply chain.
          const getentCalls = runAsUserMock.calls.filter((c) =>
            c.command.startsWith('getent group '),
          );
          expect(getentCalls.length).toBe(1);
          expect(getentCalls[0].command).toContain(`'custom-shared-group'`);

          const applyCalls = runAsUserMock.calls.filter((c) =>
            c.command.includes('chgrp -R '),
          );
          expect(applyCalls.length).toBe(1);
          expect(applyCalls[0].command).toContain(
            `chgrp -R 'custom-shared-group' '${TEST_REPO_DIR}/.git'`,
          );

          // The fallback helper also threads the override through.
          const fallback = buildManualFallbackCommands(TEST_REPO_DIR, 'custom-shared-group');
          expect(fallback.some((c) => c.includes('chgrp -R custom-shared-group'))).toBe(true);
        } finally {
          if (originalGroup === undefined) {
            delete process.env.AGENT_CONSOLE_SERVICE_GROUP;
          } else {
            process.env.AGENT_CONSOLE_SERVICE_GROUP = originalGroup;
          }
        }
      });
    });

    // Issue #853: bootstrap safe.directory into the SERVER's gitconfig at
    // registration so subsequent server-initiated git operations (listWorktrees,
    // getRemoteUrl, fetch, ...) against an operator-cloned source repo do not
    // hit `fatal: detected dubious ownership`. Mirror of #838 / PR #843 for the
    // per-user side but with `username: null`.
    describe('multi-user mode server-side safe.directory bootstrap (Issue #853)', () => {
      let originalAuthMode: string | undefined;

      const FAKE_SHARED_GID = 9876;

      // Same default responder as the #845 block: `getent` returns the
      // synthetic shared gid, everything else returns success. The new
      // safe.directory bootstrap call will land in the catch-all branch
      // (success).
      function defaultResponder(opts: RunAsUserOpts): Promise<RunAsUserResult> {
        if (opts.command.startsWith('getent group ')) {
          return Promise.resolve({
            stdout: `agent-console-users:x:${FAKE_SHARED_GID}:agentconsole\n`,
            stderr: '',
            exitCode: 0,
            timedOut: false,
          });
        }
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        });
      }

      beforeEach(() => {
        originalAuthMode = process.env.AUTH_MODE;
        runAsUserMock.responder.fn = defaultResponder;
      });

      afterEach(() => {
        if (originalAuthMode === undefined) {
          delete process.env.AUTH_MODE;
        } else {
          process.env.AUTH_MODE = originalAuthMode;
        }
      });

      it('invokes a single server-side safe.directory bootstrap call in multi-user mode', async () => {
        process.env.AUTH_MODE = 'multi-user';
        const manager = await getRepositoryManager();

        await manager.registerRepository(TEST_REPO_DIR);

        // Exactly one bootstrap call -- identified by the `safe.directory`
        // substring -- should have been issued. The command shape is the
        // idempotent grep-guarded `git config --global --add` pattern that
        // mirrors `bootstrapSafeDirectoryForUser` in worktree-service.ts.
        const bootstrapCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('safe.directory'),
        );
        expect(bootstrapCalls.length).toBe(1);
        const bootstrap = bootstrapCalls[0];
        // Run as the SERVER process (username: null) -- writing the server's
        // own gitconfig, not a user's. This is the distinguishing
        // characteristic versus #838's per-user bootstrap.
        expect(bootstrap.username).toBeNull();
        // Idempotent guard: the grep -Fxq check against the existing
        // entries, with a conditional `git config --global --add` only when
        // the value is missing. The repo path is shell-escaped via single
        // quotes by `shellEscape`.
        expect(bootstrap.command).toContain(
          `git config --global --get-all safe.directory`,
        );
        expect(bootstrap.command).toContain(`grep -Fxq '${TEST_REPO_DIR}'`);
        expect(bootstrap.command).toContain(
          `git config --global --add safe.directory '${TEST_REPO_DIR}'`,
        );
      });

      it('does not invoke the safe.directory bootstrap in single-user mode', async () => {
        delete process.env.AUTH_MODE;
        const manager = await getRepositoryManager();

        await manager.registerRepository(TEST_REPO_DIR);

        // Single-user mode: neither the #845 apply chain nor the #853
        // bootstrap should fire. The entire multi-user branch is gated on
        // AUTH_MODE.
        expect(runAsUserMock.calls.length).toBe(0);
      });

      it('registration succeeds with a warn log when the bootstrap returns non-zero', async () => {
        process.env.AUTH_MODE = 'multi-user';

        // Replace the responder so the safe.directory bootstrap returns
        // non-zero (e.g. the server's gitconfig is read-only, or the inner
        // grep pipeline produced an unexpected exit code). Other commands
        // (getent / chgrp apply) keep default success behaviour so the test
        // isolates the bootstrap failure.
        runAsUserMock.responder.fn = async (opts) => {
          if (opts.command.startsWith('getent group ')) {
            return {
              stdout: `agent-console-users:x:${FAKE_SHARED_GID}:agentconsole\n`,
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          }
          if (opts.command.includes('safe.directory')) {
            return {
              stdout: '',
              stderr: 'error: could not lock config file /home/agentconsole/.gitconfig: Permission denied',
              exitCode: 255,
              timedOut: false,
            };
          }
          // chgrp apply etc.: success
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        };

        const manager = await getRepositoryManager();
        // Must not throw -- bootstrap failure is non-fatal so registration
        // proceeds. The contract mirrors the #845 apply chain's
        // failure-tolerance: warn + continue rather than abort.
        const repo = await manager.registerRepository(TEST_REPO_DIR);

        // The DB record was still saved.
        const savedRepos = await repositoryRepository.findAll();
        expect(savedRepos.length).toBe(1);
        expect(savedRepos[0].path).toBe(TEST_REPO_DIR);
        expect(savedRepos[0].id).toBe(repo.id);

        // Verify the bootstrap was actually attempted (so this test fails
        // if the bootstrap call site is removed from registerRepository).
        const bootstrapCalls = runAsUserMock.calls.filter((c) =>
          c.command.includes('safe.directory'),
        );
        expect(bootstrapCalls.length).toBe(1);
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
