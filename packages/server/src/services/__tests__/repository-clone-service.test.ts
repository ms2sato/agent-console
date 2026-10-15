/**
 * Tests for the clone-and-register repository service (Issue #834).
 *
 * Coverage targets:
 *   - happy-path (mocked runAsUser returns success -> registerRepository called
 *     -> job state succeeded)
 *   - URL validation rejection (no spawn invoked)
 *   - Name validation rejection (no spawn invoked)
 *   - 409-shape (CloneNameConflictError) when the target dir already exists
 *     (no spawn invoked)
 *   - Each classified error code (auth_failed, network_error,
 *     repo_not_found, permission_denied, timeout, unknown) from a non-zero
 *     git clone exit
 *   - Partial-clone cleanup on failure (rm -rf of the target)
 *   - Single-user vs multi-user spawn arg shape
 *   - deriveNameFromUrl unit cases (SSH SCP, https with .git, no segment)
 *   - classifyCloneError boundary cases
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { Repository } from '@agent-console/shared';
import { CLONE_ERROR_CODES, CLONE_JOB_STATUS } from '@agent-console/shared';
import {
  setupMemfs,
  cleanupMemfs,
} from '../../__tests__/utils/mock-fs-helper.js';
import {
  RepositoryCloneService,
  CloneValidationError,
  CloneNameConflictError,
  deriveNameFromUrl,
  classifyCloneError,
  validateCloneInputs,
  buildCloneCommand,
} from '../repository-clone-service.js';
import type {
  RunAsUserFn,
  RepositoryRegistrar,
} from '../repository-clone-service.js';
import type { RunAsUserOpts, RunAsUserResult } from '../privilege-elevation.js';

const MKDIR_PREFIX = 'mkdir -- ';

/**
 * Capture-and-respond fake for `runAsUser`. Default response: success
 * (exitCode 0, empty stdout/stderr). Per-test scenarios can replace the
 * responder via `responder.fn = ...`.
 */
function createRunAsUserMock() {
  const calls: RunAsUserOpts[] = [];
  // The target-directory reservation is a `mkdir -- '<dir>'` call; it is routed
  // to `reservation` so tests that replace `responder` for the clone step
  // keep a faithful reservation. The default behaves like mkdir(2) without
  // `-p` on the memfs volume: exit 0, or exit 1 with a `File exists` stderr.
  const reservation = {
    fn: async (opts: RunAsUserOpts): Promise<RunAsUserResult> => {
      const dir = opts.command.slice(MKDIR_PREFIX.length).replace(/^'|'$/g, '');
      try {
        await fsPromises.mkdir(dir);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'EEXIST') {
          return {
            stdout: '',
            stderr: `mkdir: cannot create directory '${dir}': File exists`,
            exitCode: 1,
            timedOut: false,
          };
        }
        throw err;
      }
    },
  };
  const responder = {
    fn: async (_opts: RunAsUserOpts): Promise<RunAsUserResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  };
  const runAsUserImpl: RunAsUserFn = ((opts: RunAsUserOpts, _spawn?: unknown) => {
    calls.push(opts);
    return opts.command.startsWith(MKDIR_PREFIX) ? reservation.fn(opts) : responder.fn(opts);
  }) as RunAsUserFn;
  return { calls, runAsUserImpl, responder, reservation };
}

function createRegistrarMock() {
  const calls: { repoPath: string; options?: { description?: string } }[] = [];
  const responder = {
    fn: async (repoPath: string, options?: { description?: string }): Promise<Repository> => ({
      id: 'mock-repo-id',
      name: path.basename(repoPath),
      path: repoPath,
      createdAt: '2024-01-01T00:00:00.000Z',
      description: options?.description ?? null,
      defaultAgentId: null,
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    }),
  };
  const registrar: RepositoryRegistrar = {
    registerRepository: async (repoPath, options) => {
      calls.push({ repoPath, options });
      return responder.fn(repoPath, options);
    },
  };
  return { calls, registrar, responder };
}

/**
 * Wait until the in-memory job state for `jobId` is no longer pending /
 * cloning, polling every 5ms. The background runner is fire-and-forget, so
 * tests have to drain to the terminal state explicitly.
 */
async function waitForJobTerminal(
  service: RepositoryCloneService,
  jobId: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = service.getJob(jobId);
    if (
      state &&
      (state.status === CLONE_JOB_STATUS.SUCCEEDED ||
        state.status === CLONE_JOB_STATUS.FAILED)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Job ${jobId} did not reach terminal state within ${timeoutMs}ms (status=${service.getJob(jobId)?.status})`,
  );
}

describe('repository-clone-service', () => {
  let scratchRoot: string;
  let sourceReposDir: string;
  const originalAuthMode = process.env.AUTH_MODE;

  beforeEach(async () => {
    // The test-utils memfs mock is process-global (test-utils.ts:25 calls
    // mock.module('fs') for the whole suite). Use memfs paths instead of
    // os.tmpdir() so the lstat conflict check + fsPromises.rm cleanup
    // exercise the (mocked) memfs volume rather than failing on the empty
    // real /tmp shadow.
    scratchRoot = `/test/clone-service-${Math.random().toString(36).slice(2)}`;
    sourceReposDir = path.join(scratchRoot, 'source-repos');
    setupMemfs({
      [`${sourceReposDir}/.keep`]: '',
    });
    delete process.env.AUTH_MODE;
  });

  afterEach(async () => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
    cleanupMemfs();
  });

  // ---------------------------------------------------------------------------
  // Pure unit cases
  // ---------------------------------------------------------------------------

  describe('deriveNameFromUrl', () => {
    it('strips .git from an https URL', () => {
      expect(deriveNameFromUrl('https://github.com/org/repo.git')).toBe('repo');
    });
    it('strips .git from an ssh SCP shortcut', () => {
      expect(deriveNameFromUrl('git@github.com:org/repo.git')).toBe('repo');
    });
    it('handles an ssh URL without .git', () => {
      expect(deriveNameFromUrl('ssh://git@host/org/repo')).toBe('repo');
    });
    it('returns null for a URL with no extractable basename', () => {
      // Edge case: empty path component after the last slash.
      expect(deriveNameFromUrl('https://example.com/')).toBe(null);
    });
  });

  describe('classifyCloneError', () => {
    it('returns timeout when timedOut=true regardless of exit code', () => {
      expect(classifyCloneError('whatever', 137, true)).toBe(CLONE_ERROR_CODES.TIMEOUT);
    });
    it('classifies Permission denied (publickey) as auth_failed (not permission_denied)', () => {
      expect(
        classifyCloneError('git@github.com: Permission denied (publickey).\nfatal: ...', 128, false),
      ).toBe(CLONE_ERROR_CODES.AUTH_FAILED);
    });
    it('classifies Repository not found as repo_not_found', () => {
      expect(
        classifyCloneError('remote: Repository not found.\nfatal: could not read', 128, false),
      ).toBe(CLONE_ERROR_CODES.REPO_NOT_FOUND);
    });
    it('classifies "Could not resolve host" as network_error', () => {
      expect(
        classifyCloneError('fatal: unable to access ... : Could not resolve host: github.com', 128, false),
      ).toBe(CLONE_ERROR_CODES.NETWORK_ERROR);
    });
    it('classifies bare permission denied as permission_denied', () => {
      expect(
        classifyCloneError("fatal: could not create work tree dir 'x': Permission denied", 128, false),
      ).toBe(CLONE_ERROR_CODES.PERMISSION_DENIED);
    });
    it('returns unknown for opaque stderr', () => {
      expect(classifyCloneError('fatal: weird new git failure', 128, false)).toBe(
        CLONE_ERROR_CODES.UNKNOWN,
      );
    });
  });

  describe('validateCloneInputs', () => {
    it('accepts a valid pair', () => {
      expect(() =>
        validateCloneInputs('https://github.com/org/repo.git', 'repo'),
      ).not.toThrow();
    });
    it('rejects a URL starting with a dash (argv-injection guard)', () => {
      expect(() => validateCloneInputs('--upload-pack=evil', 'name')).toThrow(
        CloneValidationError,
      );
    });
    it('rejects a name starting with a dash', () => {
      expect(() => validateCloneInputs('https://github.com/o/r.git', '-rf')).toThrow(
        CloneValidationError,
      );
    });
    it('rejects `..` in name', () => {
      expect(() => validateCloneInputs('https://github.com/o/r.git', '..')).toThrow(
        CloneValidationError,
      );
    });
    it('rejects `/` in name', () => {
      expect(() => validateCloneInputs('https://github.com/o/r.git', 'a/b')).toThrow(
        CloneValidationError,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Service-level cases
  // ---------------------------------------------------------------------------

  describe('enqueueClone -- happy path', () => {
    it('runs git clone then registers, transitioning to succeeded', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        description: 'a tested repo',
        requestUser: null,
      });

      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.SUCCEEDED);
      expect(state?.repositoryId).toBe('mock-repo-id');
      expect(state?.error).toBeUndefined();

      // Spawn invocations: the reservation, then the clone.
      expect(runAs.calls).toHaveLength(2);
      const call = runAs.calls[1];
      expect(call.command).toContain('git clone --config core.sharedRepository=group');
      expect(call.command).toContain("'https://github.com/org/repo.git'");
      expect(call.command).toContain(path.join(sourceReposDir, 'repo'));
      expect(call.cwd).toBe(sourceReposDir);
      expect(call.username).toBe(null);
      expect(call.preserveEnv).toEqual([
        'FORCE_COLOR',
        'SSH_AUTH_SOCK',
        'SSH_AGENT_PID',
        'GIT_ASKPASS',
      ]);

      // Registration invocation:
      expect(registrar.calls).toHaveLength(1);
      expect(registrar.calls[0].repoPath).toBe(path.join(sourceReposDir, 'repo'));
      expect(registrar.calls[0].options?.description).toBe('a tested repo');
    });

    it('respects an explicit name override', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        name: 'my-clone',
        requestUser: null,
      });
      await waitForJobTerminal(service, jobId);

      const expectedTarget = path.join(sourceReposDir, 'my-clone');
      expect(runAs.calls[0].command).toBe(`mkdir -- '${expectedTarget}'`);
      expect(runAs.calls[1].command).toContain(expectedTarget);
      expect(registrar.calls[0].repoPath).toBe(expectedTarget);
    });
  });

  describe('enqueueClone -- validation rejections (no spawn)', () => {
    it('rejects a URL that starts with a dash (no spawn)', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      await expect(
        service.enqueueClone({
          url: '--upload-pack=evil',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(0);
      expect(registrar.calls).toHaveLength(0);
    });

    it('rejects a `..` in an explicit name (no spawn)', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      await expect(
        service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          name: '..',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(0);
    });

    it('rejects a name that fails the regex (no spawn)', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      await expect(
        service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          name: 'has space',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(0);
    });
  });

  describe('enqueueClone -- name conflict (reservation only, no clone)', () => {
    it('throws CloneNameConflictError when the target dir already exists', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      // Pre-create the target dir.
      await fsPromises.mkdir(path.join(sourceReposDir, 'repo'), { recursive: true });

      await expect(
        service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneNameConflictError);
      // Only the failed reservation ran; no clone followed.
      expect(runAs.calls).toHaveLength(1);
      expect(runAs.calls[0].command.startsWith('mkdir -- ')).toBe(true);
      expect(registrar.calls).toHaveLength(0);
    });
  });

  describe('enqueueClone -- multi-user spawn arg shape', () => {
    it('threads requestUser through to runAsUser when AUTH_MODE=multi-user', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: 'alice',
      });
      await waitForJobTerminal(service, jobId);

      // The service does not itself decide whether to elevate; that is the
      // runAsUser helper's job (covered by its own tests). What this service
      // owes is correct argument propagation:
      expect(runAs.calls).toHaveLength(2);
      expect(runAs.calls[0].username).toBe('alice');
      expect(runAs.calls[1].username).toBe('alice');
      expect(runAs.calls[1].command).toContain('git clone --config core.sharedRepository=group');
    });
  });

  describe('buildCloneCommand', () => {
    const url = 'https://github.com/org/repo.git';
    const targetDir = '/srv/source-repos/repo';

    it('non-bare (bare omitted): the exact command the service has always run', () => {
      const expected =
        "git clone --config core.sharedRepository=group 'https://github.com/org/repo.git' '/srv/source-repos/repo'";
      expect(buildCloneCommand({ url, targetDir })).toBe(expected);
      expect(buildCloneCommand({ url, targetDir, bare: false })).toBe(expected);
    });

    it('bare: one single-line command with the refspec and the head resolution, all escaped', () => {
      const command = buildCloneCommand({ url, targetDir, bare: true });
      expect(command).toBe(
        "git clone --bare --config core.sharedRepository=group " +
          "--config 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*' " +
          "'https://github.com/org/repo.git' '/srv/source-repos/repo' " +
          "&& origin_refs=$(git -C '/srv/source-repos/repo' for-each-ref --count=1 refs/remotes/origin) " +
          "&& if [ -n \"$origin_refs\" ]; " +
          "then git -C '/srv/source-repos/repo' remote set-head origin -a; fi",
      );
      expect(command.includes('\n')).toBe(false);
    });

    it('bare: a single quote in the target is escaped in all three places it appears', () => {
      const command = buildCloneCommand({ url, targetDir: "/srv/it's", bare: true });
      expect(command.split("'/srv/it'\\''s'")).toHaveLength(4);
    });
  });

  describe('enqueueClone -- bare flag reaches the spawned command', () => {
    it('bare request: the command contains --bare and the origin fetch refspec', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
        bare: true,
      });
      await waitForJobTerminal(service, jobId);

      expect(runAs.calls).toHaveLength(2);
      expect(runAs.calls[1].command).toContain('--bare');
      expect(runAs.calls[1].command).toContain('remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*');
      // The directory name carries no .git suffix.
      expect(runAs.calls[1].command).toContain(`'${path.join(sourceReposDir, 'repo')}'`);
    });

    it('control, default request: the command is identical to the pre-bare one', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, jobId);

      expect(runAs.calls[1].command).toBe(
        `git clone --config core.sharedRepository=group 'https://github.com/org/repo.git' '${path.join(sourceReposDir, 'repo')}'`,
      );
      expect(runAs.calls[1].command).not.toContain('--bare');
    });

    it('bare clone whose command exits non-zero fails the job and removes the partial directory', async () => {
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async () => ({ stdout: '', stderr: 'fatal: fetch failed', exitCode: 1, timedOut: false });
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
        bare: true,
      });
      await waitForJobTerminal(service, jobId);

      expect(service.getJob(jobId)?.status).toBe(CLONE_JOB_STATUS.FAILED);
      expect(registrar.calls).toHaveLength(0);
      // Cleanup ran for the bare clone's directory (same helper the regular
      // clone failure path uses; the mock runner records its recursive-remove call).
      expect(runAs.calls).toHaveLength(3);
      expect(runAs.calls[1].command).toContain('--bare');
      expect(runAs.calls[2].command).toContain(path.join(sourceReposDir, 'repo'));
      expect(runAs.calls[2].command).not.toContain('git clone');
    });
  });

  describe('enqueueClone -- classified failure modes', () => {
    type Case = { name: string; stderr: string; expected: typeof CLONE_ERROR_CODES[keyof typeof CLONE_ERROR_CODES] };
    const cases: Case[] = [
      { name: 'auth_failed (publickey)', stderr: 'git@github.com: Permission denied (publickey).', expected: CLONE_ERROR_CODES.AUTH_FAILED },
      { name: 'repo_not_found', stderr: 'remote: Repository not found.', expected: CLONE_ERROR_CODES.REPO_NOT_FOUND },
      { name: 'network_error', stderr: 'fatal: unable to access ... : Could not resolve host: x', expected: CLONE_ERROR_CODES.NETWORK_ERROR },
      { name: 'permission_denied', stderr: "fatal: could not create work tree dir 'x': Permission denied", expected: CLONE_ERROR_CODES.PERMISSION_DENIED },
      { name: 'unknown', stderr: 'fatal: brand-new git failure shape', expected: CLONE_ERROR_CODES.UNKNOWN },
    ];

    for (const c of cases) {
      it(`maps "${c.name}" stderr to ${c.expected}`, async () => {
        const runAs = createRunAsUserMock();
        runAs.responder.fn = async () => ({
          stdout: '',
          stderr: c.stderr,
          exitCode: 128,
          timedOut: false,
        });
        const registrar = createRegistrarMock();
        const service = new RepositoryCloneService({
          sourceReposDir,
          registrar: registrar.registrar,
          runAsUserImpl: runAs.runAsUserImpl,
        });

        const jobId = await service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          requestUser: null,
        });
        await waitForJobTerminal(service, jobId);

        const state = service.getJob(jobId);
        expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
        expect(state?.error?.code).toBe(c.expected);
        expect(state?.error?.message.length).toBeGreaterThan(0);
        // The registrar must NOT have been called on failure.
        expect(registrar.calls).toHaveLength(0);
      });
    }

    it('maps timeout to TIMEOUT regardless of exit code', async () => {
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async () => ({
        stdout: '',
        stderr: 'killed',
        exitCode: 137,
        timedOut: true,
      });
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
        cloneTimeoutMs: 5000,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
      expect(state?.error?.code).toBe(CLONE_ERROR_CODES.TIMEOUT);
      expect(state?.error?.message).toContain('timed out');
    });
  });

  describe('partial-clone cleanup on failure', () => {
    // Cleanup is delegated to `rmRecursiveAsUser`, which routes through the
    // service's `runAsUser` test-seam via `runAsUserImpl`. So these tests
    // verify the helper's contract indirectly: the rm-as-user call still
    // appears in `runAs.calls` with the helper's distinctive command shape
    // (`rm -rf -- '<targetDir>'`) and cwd pin (`/`). A separate mock of
    // `rmRecursiveAsUser` would require either `mock.module` (forbidden by
    // testing.md Anti-Pattern #2) or a new service-level injection slot (one
    // test's worth of public surface). The current capture approach is
    // sufficient because the helper's shape is distinctive enough that no
    // other code path could produce it.
    it('delegates to rmRecursiveAsUser with null username when requestUser is null', async () => {
      const targetDir = path.join(sourceReposDir, 'repo');
      const runAs = createRunAsUserMock();
      // Simulate a partial clone: the responder creates the target dir on
      // disk before reporting failure, mirroring what real git does when it
      // fails mid-stream. The rm branch performs a real fs rm so the
      // post-condition lstat ENOENT assertion can verify cleanup happened
      // via the helper.
      runAs.responder.fn = async (opts) => {
        if (opts.command.startsWith('git clone')) {
          await fsPromises.mkdir(targetDir, { recursive: true });
          await fsPromises.writeFile(path.join(targetDir, 'partial-marker'), 'x');
          return {
            stdout: '',
            stderr: 'fatal: weird mid-clone failure',
            exitCode: 128,
            timedOut: false,
          };
        }
        if (opts.command.startsWith('rm -rf --')) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
      // The cleanup MUST have rm'd the partial dir.
      await expect(fsPromises.lstat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // Three calls: the reservation, the clone and the helper's rm. The helper
      // passes the null username through; the real `runAsUser` would
      // short-circuit elevation, but the mock just captures the shape.
      expect(runAs.calls).toHaveLength(3);
      expect(runAs.calls[1].command).toContain('git clone');
      const rmCall = runAs.calls[2];
      expect(rmCall.command.startsWith('rm -rf -- ')).toBe(true);
      expect(rmCall.command).toContain(`'${targetDir}'`);
      expect(rmCall.cwd).toBe('/');
      expect(rmCall.username).toBe(null);
    });

    it('delegates to rmRecursiveAsUser with the requesting user when requestUser is set', async () => {
      // Multi-user mode: the partial tree on disk is owned by `requestUser`,
      // so a direct `fsPromises.rm` from the server process would fail with
      // EACCES (Issue #887). The cleanup must route the rm through
      // runAsUser so it executes with the same ownership.
      process.env.AUTH_MODE = 'multi-user';
      const targetDir = path.join(sourceReposDir, 'repo');
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async (opts) => {
        if (opts.command.startsWith('git clone')) {
          await fsPromises.mkdir(targetDir, { recursive: true });
          await fsPromises.writeFile(path.join(targetDir, 'partial-marker'), 'x');
          return {
            stdout: '',
            stderr: 'fatal: weird mid-clone failure',
            exitCode: 128,
            timedOut: false,
          };
        }
        if (opts.command.startsWith('rm -rf --')) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: 'alice',
      });
      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
      await expect(fsPromises.lstat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });

      // The reservation, the clone and the rm-as-user calls must all have
      // happened, all targeting `alice`.
      expect(runAs.calls).toHaveLength(3);
      expect(runAs.calls[0].command.startsWith('mkdir -- ')).toBe(true);
      expect(runAs.calls[0].username).toBe('alice');
      const cloneCall = runAs.calls[1];
      expect(cloneCall.command.startsWith('git clone')).toBe(true);
      expect(cloneCall.username).toBe('alice');
      const rmCall = runAs.calls[2];
      expect(rmCall.command.startsWith('rm -rf -- ')).toBe(true);
      expect(rmCall.command).toContain(`'${targetDir}'`);
      expect(rmCall.cwd).toBe('/');
      expect(rmCall.username).toBe('alice');
    });

    it('delegates to rmRecursiveAsUser with the requesting user when the clone spawn throws', async () => {
      // Spawn-level failure (e.g., sudo missing) means git clone never
      // started, so `targetDir` only holds the empty reservation, which the
      // requesting user made and owns. The cleanup runs as that user like
      // every other failure path.
      process.env.AUTH_MODE = 'multi-user';
      const targetDir = path.join(sourceReposDir, 'repo');
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async (opts) => {
        if (opts.command.startsWith('git clone')) {
          throw new Error('spawn sudo ENOENT');
        }
        if (opts.command.startsWith('rm -rf --')) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: 'alice',
      });
      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
      // Three calls: the reservation, the failing clone and the helper's rm,
      // all as alice.
      expect(runAs.calls).toHaveLength(3);
      expect(runAs.calls[1].command.startsWith('git clone')).toBe(true);
      expect(runAs.calls[1].username).toBe('alice');
      const rmCall = runAs.calls[2];
      expect(rmCall.command.startsWith('rm -rf -- ')).toBe(true);
      expect(rmCall.cwd).toBe('/');
      expect(rmCall.username).toBe('alice');
      await expect(fsPromises.lstat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('enqueueClone -- target reservation runs as the requesting user', () => {
    const targetDir = () => path.join(sourceReposDir, 'repo');
    const request = (requestUser: string | null) => ({
      url: 'https://github.com/org/repo.git',
      requestUser,
    });
    const build = (runAs: ReturnType<typeof createRunAsUserMock>) =>
      new RepositoryCloneService({
        sourceReposDir,
        registrar: createRegistrarMock().registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

    it('the reservation is calls[0]: requesting user, plain mkdir without -p, cwd = source-repos', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const runAs = createRunAsUserMock();
      const service = build(runAs);

      const jobId = await service.enqueueClone(request('alice'));
      await waitForJobTerminal(service, jobId);

      expect(runAs.calls[0].username).toBe('alice');
      expect(runAs.calls[0].command).toBe(`mkdir -- '${targetDir()}'`);
      expect(runAs.calls[0].command).not.toContain(' -p');
      expect(runAs.calls[0].cwd).toBe(sourceReposDir);
      expect(runAs.calls[0].timeoutMs).toBeGreaterThan(0);
      service.dispose();
    });

    it('happy path: calls are [mkdir, clone] in that order', async () => {
      const runAs = createRunAsUserMock();
      const service = build(runAs);

      const jobId = await service.enqueueClone(request('alice'));
      await waitForJobTerminal(service, jobId);

      expect(runAs.calls.map((c) => c.command.split(' ')[0])).toEqual(['mkdir', 'git']);
      service.dispose();
    });

    it('exit non-zero with "File exists" -> CloneNameConflictError and no clone call follows', async () => {
      const runAs = createRunAsUserMock();
      runAs.reservation.fn = async () => ({
        stdout: '',
        stderr: `mkdir: cannot create directory '${targetDir()}': File exists`,
        exitCode: 1,
        timedOut: false,
      });
      const service = build(runAs);

      const error = await service.enqueueClone(request('alice')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CloneNameConflictError);
      expect((error as Error).message).toBe(`Target directory already exists: ${targetDir()}`);
      expect(runAs.calls).toHaveLength(1);
      service.dispose();
    });

    it('"Permission denied" -> CloneValidationError naming the 2775 contract; only the mkdir ran', async () => {
      const runAs = createRunAsUserMock();
      const stderr = `mkdir: cannot create directory '${targetDir()}': Permission denied`;
      runAs.reservation.fn = async () => ({ stdout: '', stderr, exitCode: 1, timedOut: false });
      const service = build(runAs);

      const error = await service.enqueueClone(request('alice')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CloneValidationError);
      expect((error as Error).message).toContain(
        "source-repos directory must be group-writable with the setgid bit (mode 2775, group agent-console-users); run the setup script's drift check",
      );
      expect((error as Error).message).toContain(stderr);
      expect(runAs.calls).toHaveLength(1);
      service.dispose();
    });

    it('another non-zero exit -> CloneValidationError("Could not reserve target directory: <stderr>")', async () => {
      const runAs = createRunAsUserMock();
      runAs.reservation.fn = async () => ({
        stdout: '',
        stderr: 'mkdir: cannot create directory: No space left on device',
        exitCode: 1,
        timedOut: false,
      });
      const service = build(runAs);

      const error = await service.enqueueClone(request('alice')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CloneValidationError);
      expect((error as Error).message).toBe(
        'Could not reserve target directory: mkdir: cannot create directory: No space left on device',
      );
      expect(runAs.calls).toHaveLength(1);
      service.dispose();
    });

    it('reservation timeout -> CloneValidationError, nothing to clean', async () => {
      const runAs = createRunAsUserMock();
      runAs.reservation.fn = async () => ({ stdout: '', stderr: '', exitCode: 137, timedOut: true });
      const service = build(runAs);

      await expect(service.enqueueClone(request('alice'))).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(1);
      service.dispose();
    });

    it('reservation spawn throw -> CloneValidationError and no cleanup call (the directory was never made)', async () => {
      const runAs = createRunAsUserMock();
      runAs.reservation.fn = async () => {
        throw new Error('spawn sudo ENOENT');
      };
      const service = build(runAs);

      const error = await service.enqueueClone(request('alice')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CloneValidationError);
      expect((error as Error).message).toContain('spawn sudo ENOENT');
      expect(runAs.calls).toHaveLength(1);
      expect(runAs.calls.some((c) => c.command.startsWith('rm '))).toBe(false);
      service.dispose();
    });

    it('requestUser null (single-user): calls[0].username is null and the same mkdir command is used', async () => {
      const runAs = createRunAsUserMock();
      const service = build(runAs);

      const jobId = await service.enqueueClone(request(null));
      await waitForJobTerminal(service, jobId);

      expect(runAs.calls[0].username).toBe(null);
      expect(runAs.calls[0].command).toBe(`mkdir -- '${targetDir()}'`);
      service.dispose();
    });
  });

  describe('registration failure after successful clone', () => {
    it('marks the job failed but leaves the cloned directory on disk', async () => {
      const targetDir = path.join(sourceReposDir, 'repo');
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async () => {
        await fsPromises.mkdir(targetDir, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };
      const registrar = createRegistrarMock();
      registrar.responder.fn = async () => {
        throw new Error('Repository already registered');
      };
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const jobId = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, jobId);

      const state = service.getJob(jobId);
      expect(state?.status).toBe(CLONE_JOB_STATUS.FAILED);
      expect(state?.error?.code).toBe(CLONE_ERROR_CODES.UNKNOWN);
      expect(state?.error?.message).toContain('Registration failed');
      // The dir from the successful clone is preserved (deliberate per
      // service design -- registration failure is not a clone failure).
      const stat = await fsPromises.lstat(targetDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('getJob', () => {
    it('returns undefined for an unknown jobId', () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });
      expect(service.getJob('does-not-exist')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // CodeRabbit follow-up: atomic target reservation + terminal-job TTL eviction
  // ---------------------------------------------------------------------------

  describe('atomic target reservation (TOCTOU guard)', () => {
    it('two concurrent enqueueClone calls for the same name -- exactly one wins', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      // Hold the clone open so the first job is still in `cloning` when the
      // second enqueue races -- this is the real-world race window the
      // CodeRabbit reviewer was concerned about.
      runAs.responder.fn = () => new Promise(() => {}); // never resolves
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const both = await Promise.allSettled([
        service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          requestUser: null,
        }),
        service.enqueueClone({
          url: 'https://github.com/org/repo.git',
          requestUser: null,
        }),
      ]);

      const fulfilled = both.filter((r) => r.status === 'fulfilled');
      const rejected = both.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        CloneNameConflictError,
      );
      service.dispose();
    });

    it('after a failed clone the target dir is freed for re-enqueue', async () => {
      const runAs = createRunAsUserMock();
      const targetDir = path.join(sourceReposDir, 'repo');
      runAs.responder.fn = async (opts) => {
        if (opts.command.startsWith('rm -rf --')) {
          await fsPromises.rm(targetDir, { recursive: true, force: true });
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
        return {
          stdout: '',
          stderr: 'fatal: not found',
          exitCode: 128,
          timedOut: false,
        };
      };
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      const id1 = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, id1);
      expect(service.getJob(id1)?.status).toBe(CLONE_JOB_STATUS.FAILED);

      // Now the partial-clone cleanup should have removed the reservation;
      // a second enqueue must succeed without 409.
      const id2 = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      expect(id2).not.toBe(id1);
      service.dispose();
    });
  });

  describe('terminal-job TTL eviction', () => {
    it('evicts a succeeded job from the in-memory map after the TTL fires', async () => {
      // Capture the eviction callback so the test can fire it on demand.
      const scheduled: { cb: () => void; delayMs: number }[] = [];
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
        terminalJobTtlMs: 5_000,
        scheduleEviction: (cb, delayMs) => {
          scheduled.push({ cb, delayMs });
          return { cancel: () => {} };
        },
      });

      const id = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, id);

      // Job is still in the map -- TTL has not elapsed.
      expect(service.getJob(id)?.status).toBe(CLONE_JOB_STATUS.SUCCEEDED);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].delayMs).toBe(5_000);

      // Fire the eviction. The job should be removed.
      scheduled[0].cb();
      expect(service.getJob(id)).toBeUndefined();
      service.dispose();
    });

    it('evicts a failed job from the in-memory map after the TTL fires', async () => {
      const scheduled: { cb: () => void; delayMs: number }[] = [];
      const runAs = createRunAsUserMock();
      runAs.responder.fn = async () => ({
        stdout: '',
        stderr: 'fatal: weird new failure',
        exitCode: 128,
        timedOut: false,
      });
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
        terminalJobTtlMs: 1_000,
        scheduleEviction: (cb, delayMs) => {
          scheduled.push({ cb, delayMs });
          return { cancel: () => {} };
        },
      });

      const id = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      await waitForJobTerminal(service, id);
      expect(service.getJob(id)?.status).toBe(CLONE_JOB_STATUS.FAILED);
      expect(scheduled).toHaveLength(1);
      scheduled[0].cb();
      expect(service.getJob(id)).toBeUndefined();
      service.dispose();
    });

    it('does not schedule eviction for pending / cloning jobs', async () => {
      const scheduled: { cb: () => void; delayMs: number }[] = [];
      const runAs = createRunAsUserMock();
      // Never resolves -- keep the job in CLONING.
      runAs.responder.fn = () => new Promise(() => {});
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
        scheduleEviction: (cb, delayMs) => {
          scheduled.push({ cb, delayMs });
          return { cancel: () => {} };
        },
      });

      const id = await service.enqueueClone({
        url: 'https://github.com/org/repo.git',
        requestUser: null,
      });
      // Wait a tick to let the cloning transition happen.
      await new Promise((r) => setTimeout(r, 10));
      expect(service.getJob(id)?.status).toBe(CLONE_JOB_STATUS.CLONING);
      expect(scheduled).toHaveLength(0);
      service.dispose();
    });
  });

  describe('URL re-validation (defense-in-depth)', () => {
    it('rejects http:// at the service layer (mirror of schema tightening)', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      await expect(
        service.enqueueClone({
          url: 'http://example.com/org/repo.git',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(0);
      service.dispose();
    });

    it('rejects a URL with embedded shell metacharacters', async () => {
      const runAs = createRunAsUserMock();
      const registrar = createRegistrarMock();
      const service = new RepositoryCloneService({
        sourceReposDir,
        registrar: registrar.registrar,
        runAsUserImpl: runAs.runAsUserImpl,
      });

      await expect(
        service.enqueueClone({
          url: 'https://example.com/repo;touch%20x',
          requestUser: null,
        }),
      ).rejects.toBeInstanceOf(CloneValidationError);
      expect(runAs.calls).toHaveLength(0);
      service.dispose();
    });
  });
});
