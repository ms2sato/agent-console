import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import {
  runAsUser,
  buildSpawnArgs,
  buildInnerCommand,
  shellEscape,
  type SpawnFn,
} from '../privilege-elevation.js';

interface CapturedSpawn {
  args: string[];
  options: Parameters<typeof Bun.spawn>[1];
}

/**
 * Build a fake spawn that records the invocation and returns the canned
 * stdout/stderr/exitCode. Mirrors the runtime shape `Bun.spawn` returns so
 * `runAsUser` consumes it identically.
 *
 * Bun reports signal-killed processes with `exitCode === null` and
 * `signalCode` carrying the signal name. The fake reproduces that contract:
 * when `blockUntilKill` is true, `proc.exited` only resolves when `kill()`
 * fires, and it resolves with `null` (NOT 137). The helper under test is
 * responsible for normalizing that to its own timeout-exit constant.
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

    // exited is typed as `Promise<number>` in Bun's d.ts, but at runtime it
    // resolves to `null` for signal-killed processes. We model that here.
    let resolveExited!: (value: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExited = resolve;
    });
    if (!opts.blockUntilKill) {
      resolveExited(exitCode);
    }

    return {
      exited: exited as unknown as Promise<number>,
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
          // Bun semantics: signal-killed -> exitCode resolves to `null`.
          // The helper under test is the layer that normalizes this to a
          // numeric timeout exit code; the fake faithfully emits the null.
          resolveExited(null);
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

  describe('shellEscape', () => {
    it('wraps plain values in single quotes', () => {
      expect(shellEscape('hello')).toBe("'hello'");
    });

    it('escapes embedded single quotes', () => {
      // foo'bar -> 'foo'\''bar'
      expect(shellEscape("foo'bar")).toBe("'foo'\\''bar'");
    });
  });

  describe('buildInnerCommand', () => {
    it('returns the command unchanged when there is no cwd or env', () => {
      expect(buildInnerCommand('echo hi', undefined, undefined)).toBe('echo hi');
    });

    it('prepends cd when cwd is provided', () => {
      expect(buildInnerCommand('echo hi', '/path/to/dir', undefined)).toBe(
        "cd '/path/to/dir'; echo hi",
      );
    });

    it('shell-escapes a cwd that contains a single quote', () => {
      expect(buildInnerCommand('echo hi', "/weird'/dir", undefined)).toBe(
        "cd '/weird'\\''/dir'; echo hi",
      );
    });

    it('prepends export when env is provided', () => {
      expect(buildInnerCommand('echo hi', undefined, { FOO: 'bar' })).toBe(
        "export FOO='bar'; echo hi",
      );
    });

    it('shell-escapes env values that contain single quotes', () => {
      expect(buildInnerCommand('echo hi', undefined, { FOO: "ba'r" })).toBe(
        "export FOO='ba'\\''r'; echo hi",
      );
    });

    it('combines cd and export with && between them (user-mode.ts pattern)', () => {
      // `cd X && export ...; <command>` -- fail fast on bad cwd, but allow
      // the user command to proceed even if `export` would emit a warning.
      expect(buildInnerCommand('echo hi', '/d', { A: '1', B: '2' })).toBe(
        "cd '/d' && export A='1' B='2'; echo hi",
      );
    });

    it('skips env keys that violate POSIX env-var naming (shell-injection guard)', () => {
      // Keys with shell metacharacters must be dropped, not interpolated.
      const result = buildInnerCommand('cmd', undefined, {
        VALID: 'ok',
        'BAD;rm -rf /': 'evil',
      });
      expect(result).toBe("export VALID='ok'; cmd");
      expect(result).not.toContain('BAD');
      expect(result).not.toContain('rm -rf');
    });
  });

  describe('buildSpawnArgs (pure)', () => {
    it('bypasses elevation when authMode is none even with a non-server username', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'none',
        undefined,
        undefined,
      );
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('bypasses elevation when username is null in multi-user mode', () => {
      const result = buildSpawnArgs(
        null,
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        undefined,
        undefined,
      );
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
        undefined,
        undefined,
      );
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('non-elevated path does NOT interpolate cwd/env into the command (they ride spawn options)', () => {
      const result = buildSpawnArgs(
        'agentconsole',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        '/some/dir',
        { FOO: 'bar' },
      );
      // Outer shell runs it -- cwd / env are passed via spawn options
      // (asserted in the runAsUser integration tests below).
      expect(result.elevated).toBe(false);
      expect(result.args).toEqual(['sh', '-c', 'echo hi']);
    });

    it('elevates with default preserveEnv and no cwd/env interpolation when none are passed', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        undefined,
        undefined,
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

    it('elevates and interpolates cwd into the inner command', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        '/path/to/work',
        undefined,
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
        "cd '/path/to/work'; echo hi",
      ]);
    });

    it('elevates and interpolates env into the inner command via export statements', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        undefined,
        { GIT_AUTHOR_NAME: 'Alice' },
      );
      expect(result.elevated).toBe(true);
      // The export MUST be inside the inner command -- if it were only on the
      // outer spawn options it would be silently discarded by `sudo -i`.
      expect(result.args[result.args.length - 1]).toBe(
        "export GIT_AUTHOR_NAME='Alice'; echo hi",
      );
    });

    it('elevates with both cwd and env, combined per the user-mode.ts pattern', () => {
      const result = buildSpawnArgs(
        'alice',
        'git clone https://x',
        ['FORCE_COLOR'],
        'agentconsole',
        'multi-user',
        '/var/agentconsole/work',
        { GIT_TERMINAL_PROMPT: '0' },
      );
      expect(result.args[result.args.length - 1]).toBe(
        "cd '/var/agentconsole/work' && export GIT_TERMINAL_PROMPT='0'; git clone https://x",
      );
    });

    it('joins multiple preserveEnv entries with commas', () => {
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        ['FORCE_COLOR', 'NO_COLOR'],
        'agentconsole',
        'multi-user',
        undefined,
        undefined,
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
      const result = buildSpawnArgs(
        'alice',
        'echo hi',
        [],
        'agentconsole',
        'multi-user',
        undefined,
        undefined,
      );
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

    it('returns timedOut=true and normalizes exitCode to 137 when Bun resolves exited to null after kill', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      // blockUntilKill keeps `proc.exited` pending until `kill()` is invoked,
      // and the fake resolves it with `null` to match Bun's actual semantics
      // for signal-killed processes. The helper must normalize that null to
      // a numeric exit code so the public `RunAsUserResult.exitCode` stays
      // typed as `number`.
      const fakeSpawn = makeFakeSpawn(captured, { blockUntilKill: true, stdout: '', stderr: '' });

      const result = await runAsUser(
        { username: null, command: 'sleep 9999', timeoutMs: 10 },
        fakeSpawn,
      );

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(137);
      expect(typeof result.exitCode).toBe('number');
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });

    it('honors a custom preserveEnv list (extra entries appear in the elevation invocation)', async () => {
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
      expect(captured[0].args.some((a) => a.startsWith('--preserve-env'))).toBe(false);
    });

    it('non-elevated: forwards cwd and env via spawn options', async () => {
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
      // And the command itself is unmodified (no interpolation).
      expect(captured[0].args).toEqual(['sh', '-c', 'pwd']);
    });

    it('elevated: interpolates cwd/env into the inner command AND pins spawn cwd to / (does NOT forward opts.env)', async () => {
      // This is the regression the CodeRabbit MAJOR finding exposed: the
      // prior implementation silently dropped opts.cwd / opts.env because
      // `sudo -i` resets the environment and chdirs to the target HOME. The
      // fix is to embed them in the inner shell command.
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser(
        {
          username: targetUser,
          command: 'git clone https://x',
          cwd: '/work/here',
          env: { GIT_TERMINAL_PROMPT: '0' },
        },
        fakeSpawn,
      );

      // The cwd/env MUST appear inside the inner shell command, not be lost.
      const innerCommand = captured[0].args[captured[0].args.length - 1];
      expect(innerCommand).toBe(
        "cd '/work/here' && export GIT_TERMINAL_PROMPT='0'; git clone https://x",
      );

      // Outer spawn options: cwd pinned to neutral '/', env NOT forwarded
      // (would be reset by `sudo -i` and only adds noise to the spawn).
      const opts = captured[0].options as { cwd?: string; env?: Record<string, string> };
      expect(opts.cwd).toBe('/');
      expect(opts.env).toBeUndefined();
    });
  });
});
