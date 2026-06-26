import { describe, it, expect } from 'bun:test';
import {
  removeWorktreeWithFallback,
  GitError,
  type WorktreeRemovalRunner,
} from '../git.js';

interface RunGitCall {
  args: string[];
}

interface RmCall {
  path: string;
}

function makeRunner(
  responder: (
    call: number,
    args: string[],
  ) =>
    | { exitCode: number; stderr: string; timedOut?: boolean }
    | Promise<{ exitCode: number; stderr: string; timedOut?: boolean }>
    | Error,
  rmBehavior?: (path: string) => void | Promise<void>,
): {
  runner: WorktreeRemovalRunner;
  runGitCalls: RunGitCall[];
  rmCalls: RmCall[];
} {
  const runGitCalls: RunGitCall[] = [];
  const rmCalls: RmCall[] = [];

  const runner: WorktreeRemovalRunner = {
    runGit: async (args) => {
      runGitCalls.push({ args });
      const result = await Promise.resolve(responder(runGitCalls.length, args));
      if (result instanceof Error) throw result;
      return result;
    },
    rmRecursive: async (path) => {
      rmCalls.push({ path });
      if (rmBehavior) await rmBehavior(path);
    },
  };

  return { runner, runGitCalls, rmCalls };
}

describe('removeWorktreeWithFallback', () => {
  it('returns after a single successful runGit (exit 0, force=false)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner(() => ({
      exitCode: 0,
      stderr: '',
      timedOut: false,
    }));

    await removeWorktreeWithFallback('/wt/feat', runner, { force: false });

    expect(runGitCalls.length).toBe(1);
    expect(runGitCalls[0].args).toEqual(['worktree', 'remove', '/wt/feat']);
    expect(rmCalls.length).toBe(0);
  });

  it('passes --force --force when force=true', async () => {
    const { runner, runGitCalls } = makeRunner(() => ({
      exitCode: 0,
      stderr: '',
    }));

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(runGitCalls[0].args).toEqual([
      'worktree',
      'remove',
      '/wt/feat',
      '--force',
      '--force',
    ]);
  });

  it('falls back to rmRecursive + prune --expire=now on a stale-worktree stderr (force=true)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: "fatal: '/wt/feat' is not a working tree",
          timedOut: false,
        };
      }
      return { exitCode: 0, stderr: '' };
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(runGitCalls.length).toBe(2);
    expect(runGitCalls[0].args).toEqual([
      'worktree',
      'remove',
      '/wt/feat',
      '--force',
      '--force',
    ]);
    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
    expect(runGitCalls[1].args).toEqual(['worktree', 'prune', '--expire=now']);
  });

  it('matches `cannot read .git file` as a stale-worktree pattern', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: 'fatal: cannot read .git file',
          timedOut: false,
        };
      }
      return { exitCode: 0, stderr: '' };
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
    expect(runGitCalls.length).toBe(2);
  });

  it('matches `invalid gitfile format` as a stale-worktree pattern', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: 'fatal: invalid gitfile format: /wt/feat/.git',
          timedOut: false,
        };
      }
      return { exitCode: 0, stderr: '' };
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
    expect(runGitCalls.length).toBe(2);
  });

  it("matches `'.git' file` substring as a stale-worktree pattern", async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: "fatal: '.git' file is corrupt",
          timedOut: false,
        };
      }
      return { exitCode: 0, stderr: '' };
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
    expect(runGitCalls.length).toBe(2);
  });

  it('propagates rmRecursive errors when fallback is triggered', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner(
      (call) => {
        if (call === 1) {
          return {
            exitCode: 128,
            stderr: "fatal: '/wt/feat' is not a working tree",
            timedOut: false,
          };
        }
        return { exitCode: 0, stderr: '' };
      },
      () => {
        throw new GitError(
          'elevated rm failed: exit code 1',
          1,
          'rm: cannot remove',
        );
      },
    );

    await expect(
      removeWorktreeWithFallback('/wt/feat', runner, { force: true }),
    ).rejects.toBeInstanceOf(GitError);

    expect(runGitCalls.length).toBe(1);
    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
  });

  it('does NOT propagate prune failures (best-effort swallow)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: "fatal: '/wt/feat' is not a working tree",
          timedOut: false,
        };
      }
      return new Error('prune blew up');
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(runGitCalls.length).toBe(2);
    expect(runGitCalls[1].args).toEqual(['worktree', 'prune', '--expire=now']);
    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
  });

  it('throws GitError on a non-stale stderr even when force=true (narrow matcher regression guard)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner(() => ({
      exitCode: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      timedOut: false,
    }));

    await expect(
      removeWorktreeWithFallback('/wt/feat', runner, { force: true }),
    ).rejects.toBeInstanceOf(GitError);

    expect(runGitCalls.length).toBe(1);
    expect(rmCalls.length).toBe(0);
  });

  it('throws GitError when force=false even on a stale-worktree stderr (no recovery without force)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner(() => ({
      exitCode: 128,
      stderr: "fatal: '/wt/feat' is not a working tree",
      timedOut: false,
    }));

    await expect(
      removeWorktreeWithFallback('/wt/feat', runner, { force: false }),
    ).rejects.toBeInstanceOf(GitError);

    expect(runGitCalls.length).toBe(1);
    expect(rmCalls.length).toBe(0);
  });

  it('throws GitError when timedOut=true even with a stale-worktree stderr (timeout suppresses recovery)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner(() => ({
      exitCode: 137,
      stderr: "fatal: '/wt/feat' is not a working tree",
      timedOut: true,
    }));

    await expect(
      removeWorktreeWithFallback('/wt/feat', runner, { force: true }),
    ).rejects.toBeInstanceOf(GitError);

    expect(runGitCalls.length).toBe(1);
    expect(rmCalls.length).toBe(0);
  });

  it('treats omitted timedOut as not-timed-out (default false)', async () => {
    const { runner, runGitCalls, rmCalls } = makeRunner((call) => {
      if (call === 1) {
        return {
          exitCode: 128,
          stderr: "fatal: '/wt/feat' is not a working tree",
        };
      }
      return { exitCode: 0, stderr: '' };
    });

    await removeWorktreeWithFallback('/wt/feat', runner, { force: true });

    expect(runGitCalls.length).toBe(2);
    expect(rmCalls).toEqual([{ path: '/wt/feat' }]);
  });
});
