import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import type { FileSink } from 'bun';
import {
  runAsUser,
  rmRecursiveAsUser,
  spawnAsUser,
  buildSpawnArgs,
  buildInnerCommand,
  shellEscape,
  shouldElevateForUser,
  type RunAsUserOpts,
  type RunAsUserResult,
  type SpawnFn,
} from '../privilege-elevation.js';

interface CapturedSpawn {
  args: string[];
  options: Parameters<typeof Bun.spawn>[1];
}

/**
 * The subset of Bun's `Subprocess` shape that `runAsUser` actually consumes.
 * Declaring it explicitly lets the fake be typed without casting through
 * `unknown` (which the repo's TypeScript guideline prohibits).
 *
 * NOTE on `exited`: Bun's `.d.ts` declares `Promise<number>`, but at runtime
 * a signal-killed process resolves to `null` (with `signalCode` carrying the
 * signal name). The fake intentionally models that runtime semantics so the
 * helper's null-normalization path is genuinely exercised; we therefore type
 * `exited` as `Promise<number | null>` here, which is the truer shape.
 * `runAsUser` is the layer responsible for re-narrowing back to `number`.
 */
interface FakeProc {
  exited: Promise<number | null>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
}

/**
 * `SpawnFn` is typed to match `Bun.spawn`'s return value (`Subprocess`), but
 * `runAsUser` only touches the four properties on `FakeProc`. We bridge the
 * two via a single, deliberate cast at the fake's boundary -- this is a
 * structural-subtype escape that is allowed (no `unknown` intermediate).
 */
type FakeSpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1],
) => FakeProc;

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

  const fakeFn: FakeSpawnFn = (args, options) => {
    captured.push({ args, options });

    let resolveExited!: (value: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExited = resolve;
    });
    if (!opts.blockUntilKill) {
      resolveExited(exitCode);
    }

    const fake: FakeProc = {
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
          // Bun semantics: signal-killed -> exitCode resolves to `null`.
          // The helper under test is the layer that normalizes this to a
          // numeric timeout exit code; the fake faithfully emits the null.
          resolveExited(null);
        }
      },
    };
    return fake;
  };

  // Bridge FakeSpawnFn -> SpawnFn (which expects the full Subprocess return
  // shape). Single direct cast, no `unknown` intermediate -- allowed because
  // the helper only consumes the FakeProc subset and the cast happens once
  // at the fake's boundary.
  return fakeFn as SpawnFn;
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

  describe('shouldElevateForUser', () => {
    it('returns false when AUTH_MODE is unset (single-user)', () => {
      // AUTH_MODE deleted by beforeEach
      expect(shouldElevateForUser('alice')).toBe(false);
      expect(shouldElevateForUser(serverUsername)).toBe(false);
    });

    it('returns false when AUTH_MODE is set but username is null/undefined/empty', () => {
      process.env.AUTH_MODE = 'multi-user';
      expect(shouldElevateForUser(null)).toBe(false);
      expect(shouldElevateForUser(undefined)).toBe(false);
      expect(shouldElevateForUser('')).toBe(false);
    });

    it('returns false in multi-user mode when username equals the server user', () => {
      process.env.AUTH_MODE = 'multi-user';
      expect(shouldElevateForUser(serverUsername)).toBe(false);
    });

    it('returns true in multi-user mode for a different OS username', () => {
      process.env.AUTH_MODE = 'multi-user';
      const otherUser = `${serverUsername}-not-the-server-user`;
      expect(shouldElevateForUser(otherUser)).toBe(true);
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

    it('non-elevated: forwards cwd via spawn options AND merges opts.env over process.env (does not replace PATH/HOME)', async () => {
      // CodeRabbit MAJOR regression: Bun.spawn `env` REPLACES the child env
      // rather than merging, so passing a single override (e.g. FOO=bar)
      // without layering it over `process.env` would drop PATH/HOME and
      // typically break command resolution. The helper must merge.
      process.env.AUTH_MODE = 'none';
      // Pin a known parent-env entry the helper must preserve.
      const sentinelKey = '__PRIVILEGE_ELEVATION_TEST_SENTINEL__';
      const sentinelValue = 'parent-env-survives';
      process.env[sentinelKey] = sentinelValue;
      try {
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
        // Caller override is present.
        expect(opts.env?.FOO).toBe('bar');
        // Parent-env entry survived the merge (would be undefined if the
        // helper assigned `opts.env` directly instead of merging).
        expect(opts.env?.[sentinelKey]).toBe(sentinelValue);
        // PATH is the canonical example of what Bun's env-replacement would
        // drop. It is virtually always set in the parent process, so we
        // assert its presence to lock in the merge behavior.
        if (process.env.PATH !== undefined) {
          expect(opts.env?.PATH).toBe(process.env.PATH);
        }
        // The command itself is unmodified (no interpolation).
        expect(captured[0].args).toEqual(['sh', '-c', 'pwd']);
      } finally {
        delete process.env[sentinelKey];
      }
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

    it('forwards opts.stdin as Uint8Array to spawn options (string is UTF-8 encoded)', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser(
        {
          username: null,
          command: 'cat > /tmp/out',
          stdin: 'hello, world',
        },
        fakeSpawn,
      );

      const opts = captured[0].options as { stdin?: Uint8Array };
      expect(opts.stdin).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(opts.stdin)).toBe('hello, world');
    });

    it('forwards a Uint8Array stdin verbatim (no re-encoding for binary payloads)', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

      await runAsUser(
        {
          username: null,
          command: 'cat > /tmp/binary',
          stdin: bytes,
        },
        fakeSpawn,
      );

      const opts = captured[0].options as { stdin?: Uint8Array };
      // Same reference (no copy) is acceptable; assert bytes equality.
      expect(opts.stdin).toEqual(bytes);
    });

    it('omits the stdin spawn option when opts.stdin is not set', async () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawn(captured, { stdout: '', exitCode: 0 });

      await runAsUser({ username: null, command: 'echo hi' }, fakeSpawn);

      const opts = captured[0].options as { stdin?: unknown };
      expect(opts.stdin).toBeUndefined();
    });
  });

  describe('spawnAsUser (integration with spawn)', () => {
    /**
     * Subset of Bun's `FileSink` shape that `spawnAsUser`'s callers consume
     * via `subprocess.stdin` (write / end / flush). Pick from Bun's actual
     * `FileSink` type so the stub literal stays type-compatible with the
     * field's declared shape on `Subprocess.stdin`. Mirrors the typed-fake
     * pattern used by `FakeProc` above for the runAsUser fakes.
     */
    type FakeFileSink = Pick<FileSink, 'write' | 'end' | 'flush'>;

    /**
     * Subset of Bun's `Subprocess<'pipe','pipe','pipe'>` shape exposed by
     * `spawnAsUser`'s result. Differs from `FakeProc` in that it carries a
     * `stdin` `FileSink` (spawnAsUser callers manage stdin over time) and
     * `exited: Promise<number>` rather than `Promise<number | null>` because
     * the spawnAsUser tests never resolve `exited` and never expose the
     * signal-killed-as-null path. `stdin` is typed to Bun's actual `FileSink`
     * so the outer fake -> `SpawnFn` cast structurally overlaps with
     * `Subprocess<Writable,Readable,Readable>.stdin` (one direct cast at the
     * stub boundary substitutes for the previous `as unknown as`).
     */
    interface FakeSpawnAsUserProc {
      exited: Promise<number>;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      stdin: FileSink;
      kill: () => void;
    }

    type FakeSpawnFn = (
      args: string[],
      options: Parameters<typeof Bun.spawn>[1],
    ) => FakeSpawnAsUserProc;

    /**
     * Build a fake spawn for spawnAsUser. Unlike the runAsUser fake above,
     * `spawnAsUser` does NOT await `proc.exited` (lifecycle belongs to the
     * caller), so we keep it simple: a recorded argv/options pair and a
     * FakeFileSink stub for `stdin` so consumers can call `.write()`/
     * `.flush()`/`.end()` without touching a real subprocess.
     */
    function makeFakeSpawnForSpawnAsUser(captured: CapturedSpawn[]): SpawnFn {
      const fakeFn: FakeSpawnFn = (args, options) => {
        captured.push({ args, options });
        const stdinStub: FakeFileSink = {
          write: () => 0,
          end: () => 0,
          flush: () => Promise.resolve(0),
        };
        // The fake never resolves `exited` (no caller awaits it) and never
        // emits stream bytes -- only the spawn-time argv / options shape and
        // the FileSink-shaped stdin are exercised by these tests. The stub
        // only models the three FileSink methods callers touch; a single
        // direct cast at THIS boundary widens it to `FileSink` so the outer
        // `fakeFn as SpawnFn` cast structurally overlaps without `unknown`.
        const fake: FakeSpawnAsUserProc = {
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>(),
          stderr: new ReadableStream<Uint8Array>(),
          stdin: stdinStub as FileSink,
          kill: () => {},
        };
        return fake;
      };
      // Single direct cast at the fake boundary; the fake's typed return
      // shape (FakeSpawnAsUserProc) matches the subset spawnAsUser consumes.
      return fakeFn as SpawnFn;
    }

    it('AUTH_MODE=none: invokes sh -c directly even when username is set', () => {
      process.env.AUTH_MODE = 'none';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      const result = spawnAsUser(
        { username: 'alice', command: 'echo hello' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual(['sh', '-c', 'echo hello']);
      expect(result.elevated).toBe(false);
      expect(result.subprocess).toBeDefined();
      expect(result.stdin).toBeDefined();
    });

    it('AUTH_MODE=multi-user with a non-server username: elevates and preserves FORCE_COLOR by default', () => {
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      const result = spawnAsUser(
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
      expect(result.elevated).toBe(true);
    });

    it('AUTH_MODE=multi-user with username === serverUsername: bypasses elevation (direct spawn)', () => {
      process.env.AUTH_MODE = 'multi-user';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      const result = spawnAsUser(
        { username: serverUsername, command: 'id -un' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual(['sh', '-c', 'id -un']);
      expect(result.elevated).toBe(false);
    });

    it('AUTH_MODE=multi-user with null username: bypasses elevation', () => {
      process.env.AUTH_MODE = 'multi-user';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      const result = spawnAsUser(
        { username: null, command: 'echo legacy' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].args).toEqual(['sh', '-c', 'echo legacy']);
      expect(result.elevated).toBe(false);
    });

    it('always sets stdin/stdout/stderr to "pipe" regardless of elevation', () => {
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      // Non-elevated branch
      process.env.AUTH_MODE = 'none';
      spawnAsUser({ username: null, command: 'echo nonelev' }, fakeSpawn);

      // Elevated branch
      process.env.AUTH_MODE = 'multi-user';
      spawnAsUser(
        { username: `${serverUsername}-other`, command: 'echo elev' },
        fakeSpawn,
      );

      expect(captured).toHaveLength(2);
      for (const cap of captured) {
        const opts = cap.options as {
          stdin?: unknown;
          stdout?: unknown;
          stderr?: unknown;
        };
        expect(opts.stdin).toBe('pipe');
        expect(opts.stdout).toBe('pipe');
        expect(opts.stderr).toBe('pipe');
      }
    });

    it('non-elevated: forwards cwd via spawn options AND merges opts.env over process.env', () => {
      // Mirror of the runAsUser non-elevated env-merge regression test.
      process.env.AUTH_MODE = 'none';
      const sentinelKey = '__SPAWN_AS_USER_TEST_SENTINEL__';
      const sentinelValue = 'parent-env-survives';
      process.env[sentinelKey] = sentinelValue;
      try {
        const captured: CapturedSpawn[] = [];
        const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

        spawnAsUser(
          {
            username: null,
            command: 'pwd',
            cwd: '/some/dir',
            env: { FOO: 'bar' },
          },
          fakeSpawn,
        );

        const opts = captured[0].options as {
          cwd?: string;
          env?: Record<string, string>;
        };
        expect(opts.cwd).toBe('/some/dir');
        expect(opts.env?.FOO).toBe('bar');
        expect(opts.env?.[sentinelKey]).toBe(sentinelValue);
        if (process.env.PATH !== undefined) {
          expect(opts.env?.PATH).toBe(process.env.PATH);
        }
        expect(captured[0].args).toEqual(['sh', '-c', 'pwd']);
      } finally {
        delete process.env[sentinelKey];
      }
    });

    it('elevated: interpolates cwd/env into the inner command AND pins spawn cwd to /', () => {
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${serverUsername}-someone-else`;
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      spawnAsUser(
        {
          username: targetUser,
          command: 'git clone https://x',
          cwd: '/work/here',
          env: { GIT_TERMINAL_PROMPT: '0' },
        },
        fakeSpawn,
      );

      const innerCommand = captured[0].args[captured[0].args.length - 1];
      expect(innerCommand).toBe(
        "cd '/work/here' && export GIT_TERMINAL_PROMPT='0'; git clone https://x",
      );

      const opts = captured[0].options as {
        cwd?: string;
        env?: Record<string, string>;
      };
      expect(opts.cwd).toBe('/');
      expect(opts.env).toBeUndefined();
    });

    it('returns subprocess, stdin, and elevated boolean in the result', () => {
      process.env.AUTH_MODE = 'multi-user';
      const captured: CapturedSpawn[] = [];
      const fakeSpawn = makeFakeSpawnForSpawnAsUser(captured);

      const result = spawnAsUser(
        { username: `${serverUsername}-someone-else`, command: 'echo hi' },
        fakeSpawn,
      );

      expect(result.subprocess).toBeDefined();
      expect(result.stdin).toBeDefined();
      // stdin must point at the same FileSink the subprocess exposes -- the
      // `stdin` field is an alias so callers can store it once without
      // re-reading subprocess.stdin later.
      expect(result.stdin).toBe(result.subprocess.stdin);
      expect(result.elevated).toBe(true);
    });
  });

  // ============================================================
  // rmRecursiveAsUser (layer-correctness helper, Issue #882 owner feedback)
  // ============================================================
  //
  // The helper composes `runAsUser` with a fixed command shape
  // (`rm -rf -- '<path>'`) + cwd (`/`). It is the canonical encapsulation
  // for elevated recursive removal so consumers do not inline the
  // shellEscape + cwd-pinning + idempotency contract repeatedly.
  describe('rmRecursiveAsUser', () => {
    it('null username bypasses elevation (forwards null straight to runAsUser)', async () => {
      const captured: RunAsUserOpts[] = [];
      const fakeRunAsUser: typeof runAsUser = async (opts) => {
        captured.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      const result = await rmRecursiveAsUser('/some/path', null, {
        runAsUserImpl: fakeRunAsUser,
      });

      expect(captured.length).toBe(1);
      expect(captured[0].username).toBeNull();
      expect(result.exitCode).toBe(0);
    });

    it('elevated path: command contains shell-escaped path and cwd is "/"', async () => {
      const captured: RunAsUserOpts[] = [];
      const fakeRunAsUser: typeof runAsUser = async (opts) => {
        captured.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      // Path with a single quote forces non-trivial shellEscape behaviour.
      await rmRecursiveAsUser("/var/lib/it's-fine/wt-1", 'alice', {
        runAsUserImpl: fakeRunAsUser,
      });

      expect(captured.length).toBe(1);
      expect(captured[0].username).toBe('alice');
      expect(captured[0].cwd).toBe('/');
      // Single-quote escape: `'it'\''s-fine'` style.
      expect(captured[0].command).toBe(`rm -rf -- '/var/lib/it'\\''s-fine/wt-1'`);
    });

    it('forwards timeoutMs to runAsUser when provided', async () => {
      const captured: RunAsUserOpts[] = [];
      const fakeRunAsUser: typeof runAsUser = async (opts) => {
        captured.push(opts);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      };

      await rmRecursiveAsUser('/p', 'alice', {
        timeoutMs: 12345,
        runAsUserImpl: fakeRunAsUser,
      });

      expect(captured[0].timeoutMs).toBe(12345);
    });

    it('returns the underlying RunAsUserResult unchanged (caller branches on exitCode/timedOut)', async () => {
      const fakeRunAsUser: typeof runAsUser = async () => ({
        stdout: 'OUT',
        stderr: 'ERR',
        exitCode: 137,
        timedOut: true,
      });

      const result: RunAsUserResult = await rmRecursiveAsUser('/p', 'alice', {
        runAsUserImpl: fakeRunAsUser,
      });

      expect(result).toEqual({
        stdout: 'OUT',
        stderr: 'ERR',
        exitCode: 137,
        timedOut: true,
      });
    });

    it('uses the module runAsUser when no runAsUserImpl is injected (default branch)', async () => {
      // Smoke-test the default — we cannot easily intercept module-internal
      // runAsUser without spying, but we can confirm null bypass returns
      // exitCode 0 from the real `sh -c 'rm -rf -- /nonexistent-xyz...'`
      // invocation. Idempotency contract: missing paths do not fail.
      const result = await rmRecursiveAsUser(
        '/nonexistent-rm-recursive-as-user-test-path-xyz-12345',
        null,
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });
  });
});
