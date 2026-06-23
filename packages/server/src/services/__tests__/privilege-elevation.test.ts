import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import { runAsUser, buildSpawnArgs, type SpawnFn } from '../privilege-elevation.js';

interface CapturedSpawn {
  args: string[];
  options: Parameters<typeof Bun.spawn>[1];
}

/**
 * Build a fake spawn that records the invocation and returns the canned
 * stdout/stderr/exitCode. Mirrors the runtime shape `Bun.spawn` returns so
 * `runAsUser` consumes it identically.
 */
function makeFakeSpawn(
  captured: CapturedSpawn[],
  opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    /** When set, `proc.exited` only resolves once `kill()` is called. */
    blockUntilKill?: boolean;
  } = {},
): SpawnFn {
  const stdoutText = opts.stdout ?? '';
  const stderrText = opts.stderr ?? '';
  const exitCode = opts.exitCode ?? 0;

  return ((args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    captured.push({ args, options });

    let resolveExited!: (value: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    if (!opts.blockUntilKill) {
      resolveExited(exitCode);
    }

    return {
      exited,
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdoutText));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderrText));
          controller.close();
        },
      }),
      kill: () => {
        if (opts.blockUntilKill) {
          // 137 = SIGKILL exit code on POSIX
          resolveExited(137);
        }
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as SpawnFn;
}

const serverUsername = os.userInfo().username;
const originalAuthMode = process.env.AUTH_MODE;

describe('privilege-elevation', () => {
  beforeEach(() => {
    delete process.env.AUTH_MODE;
  });

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  describe('buildSpawnArgs (pure)', () => {
    it('bypasses elevation when authMode is none even with a non-server username', () => {
      const result = buildSpawnArgs('alice', 'echo hi', ['FORCE_COLOR'], 'agentconsole', 'none');
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('bypasses elevation when username is null in multi-user mode', () => {
      const result = buildSpawnArgs(null, 'echo hi', ['FORCE_COLOR'], 'agentconsole', 'multi-user');
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('bypasses elevation when username equals serverUsername in multi-user mode', () => {
      const result = buildSpawnArgs(
        'agentconsole',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
      );
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('elevates with default preserveEnv in multi-user mode for a different user', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
      );
      expect(result.elevated).toBe(true);
      expect(result.args).toEqual([
        'sudo',
        '-u',
        'alice',
        '--preserve-env=FORCE_COLOR',
        '-i',
        'sh',
        '-c',
        'echo hi',
      ]);
    });

    it('joins multiple preserveEnv entries with commas', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR', 'NO_COLOR'],
        'agentconsole',
        'multi-user',
      );
      expect(result.args).toEqual([
        'sudo',
        '-u',
        'alice',
        '--preserve-env=FORCE_COLOR,NO_COLOR',
        '-i',
        'sh',
        '-c',
        'echo hi',
      ]);
    });

    it('omits the --preserve-env flag entirely when preserveEnv is empty', () => {
      const result = buildSpawnArgs('alice', 'echo hi', [], 'agentconsole', 'multi-user');
      expect(result.args).toEqual(['sudo', '-u', 'alice', '-i', 'sh', '-c', 'echo hi']);
    });
  });

  describe('runAsUser (integration with spawn)', () => {
    it('AUTH_MODE=none: invokes sh -c directly even when username is set', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: 'hello\n', exitCode: 0 });

      const result = await runAsUser(
        { username: 'alice', command: 'echo hello' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual(['sh', '-c', 'echo hello']);
      expect(result).toEqual({
        stdout: 'hello\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
    });

    it('AUTH_MODE=multi-user with a non-server username: elevates and preserves FORCE_COLOR by default', async () => {
      process.env.AUTH_MODE = 'multi-user';
      // Choose a username guaranteed to differ from the server-process user
      // by appending a marker to the real one.
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: 'ok', exitCode: 0 });

      const result = await runAsUser(
        { username: targetUser, command: 'whoami' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual([
        'sudo',
        '-u',
        targetUser,
        '--preserve-env=FORCE_COLOR',
        '-i',
        'sh',
        '-c',
        'whoami',
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe('ok');
    });

    it('AUTH_MODE=multi-user with username == server user: bypasses elevation (direct spawn)', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: 'same', exitCode: 0 });

      const result = await runAsUser(
        { username: serverUsername, command: 'id -un' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual(['sh', '-c', 'id -un']);
      expect(result.exitCode).toBe(0);
    });

    it('returns timedOut=true when the command exceeds timeoutMs and kills the process', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      // blockUntilKill keeps `proc.exited` pending until `kill()` is invoked,
      // so the timeout path is the only thing that can resolve it.
      const fakeSpawn = makeFakeSpawn(captured, { blockUntilKill: true, stdout: '', stderr: '' });

      const result = await runAsUser(
        { username: null, command: 'sleep 9999', timeoutMs: 10 },
        fakeSpawn,
      );

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(137);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('honors a custom preserveEnv list (extra entries appear in the sudo invocation)', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser(
        {
          username: targetUser,
          command: 'env',
          preserveEnv: ['FORCE_COLOR', 'NO_COLOR'],
        },
        fakeSpawn,
      );

      expect(captured[0].args).toEqual([
        'sudo',
        '-u',
        targetUser,
        '--preserve-env=FORCE_COLOR,NO_COLOR',
        '-i',
        'sh',
        '-c',
        'env',
      ]);
    });

    it('honors preserveEnv: [] (no --preserve-env flag at all)', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser(
        {
          username: targetUser,
          command: 'env',
          preserveEnv: [],
        },
        fakeSpawn,
      );

      expect(captured[0].args).toEqual([
        'sudo',
        '-u',
        targetUser,
        '-i',
        'sh',
        '-c',
        'env',
      ]);
      // Confirm no preserve flag slipped in
      expect(captured[0].args.some((a) => a.startsWith('--preserve-env'))).toBe(false);
    });

    it('forwards cwd and env to the spawn options', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser(
        {
          username: null,
          command: 'pwd',
          cwd: '/some/dir',
          env: { FOO: 'bar' },
        },
        fakeSpawn,
      );

      const opts = captured[0].options as { cwd?: string; env?: Record<string, string> };
      expect(opts.cwd).toBe('/some/dir');
      expect(opts.env).toEqual({ FOO: 'bar' });
    });
  });
});
