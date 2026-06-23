/**
 * Privilege-elevation helper for server-side operations that must run as the
 * requesting user (multi-user mode).
 *
 * Foundation for umbrella Issue #837. Consumer migrations are tracked
 * independently in #834 (clone), #835 (description generation), and #838
 * (worktree creation).
 *
 * Semantics:
 * - `AUTH_MODE === 'multi-user'` AND `username` is set AND `username` differs
 *   from the server-process user -> elevate via `sudo -u <user>
 *   --preserve-env=... -i sh -c <innerCommand>`. Because `sudo -i` resets the
 *   environment and chdirs to the target user's HOME, `cwd` and `env` cannot
 *   travel through the outer spawn options; they MUST be interpolated into
 *   `innerCommand` itself (`cd <cwd> && export KEY=val ...; <command>`). This
 *   mirrors the canonical PTY worker pattern at
 *   `packages/server/src/services/user-mode.ts:493-500`.
 * - Otherwise (single-user mode, no username, or same-user) -> invoke
 *   `['sh', '-c', command]` directly with no elevation. In that branch `cwd`
 *   and `env` are passed via spawn options (the outer shell is not reset).
 *
 * `preserveEnv` defaults to `['FORCE_COLOR']` (mirroring the PTY worker's
 * default so Node-based agents retain truecolor support across the
 * environment reset that `sudo -i` performs). When `preserveEnv` is passed
 * explicitly the provided list REPLACES the default — callers that want to
 * add to the default should pass `['FORCE_COLOR', 'NO_COLOR', ...]`. Passing
 * `[]` means no preservation flags are emitted. `preserveEnv` only governs
 * which OUTER env vars the elevated shell inherits via the `--preserve-env`
 * flag; the per-call `opts.env` map is delivered separately via `export`
 * statements inside the inner command.
 */
import * as os from 'node:os';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:privilege-elevation');

const DEFAULT_PRESERVE_ENV = ['FORCE_COLOR'] as const;

/**
 * `sudo -i` chdirs into the target user's HOME, but the outer `sudo` process
 * still inherits this `chdir(2)` before exec. If the launching process'
 * effective cwd happens to be unreadable by the service user, the spawn
 * aborts with EACCES. `/` is always traversable, so we pin the outer spawn
 * there and let the inner `cd <cwd>` (which runs AS the target user) handle
 * the real landing. Identical reasoning to user-mode.ts:SUDO_NEUTRAL_CWD.
 */
const SUDO_NEUTRAL_CWD = '/';

/**
 * POSIX-conformant env var name: leading letter or underscore, then
 * letters / digits / underscores. Any key that does not match is skipped
 * to prevent shell injection via crafted env-var key names. Mirrors the
 * filter applied at user-mode.ts:528-534.
 */
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Exit code we surface when the helper kills the child due to timeout.
 * Bun (and POSIX in general) reports signal-killed processes with
 * `exitCode === null` and `signalCode === 'SIGKILL'`. We normalize to the
 * conventional 128 + 9 = 137 so consumers can keep `RunAsUserResult.exitCode`
 * narrowly typed as `number` and check `=== 0` for success; the canonical
 * "did we time out?" signal is the separate `timedOut` boolean.
 */
const TIMEOUT_EXIT_CODE = 137;

export interface RunAsUserOpts {
  /**
   * Target OS user. When null/undefined or equal to the server-process user,
   * elevation is bypassed. In `AUTH_MODE=none` elevation is always bypassed
   * regardless of this value.
   */
  username: string | null | undefined;
  /** Shell command (passed verbatim to `sh -c`). */
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Env-var names to preserve across the elevated shell via
   * `--preserve-env=NAME1,NAME2,...`. Defaults to `['FORCE_COLOR']`. An empty
   * array suppresses the flag entirely. Ignored when elevation is bypassed.
   */
  preserveEnv?: string[];
  /**
   * Optional bytes to feed to the child's stdin. Use when the command is a
   * sink that reads stdin (e.g. `sh -c 'cat > <dst>'` to materialize a file
   * as the target user, see worktree-service.ts template materialization).
   * String values are encoded as UTF-8; pass a `Uint8Array` for binary
   * content. When omitted, stdin is left as the default (inherit / no pipe).
   */
  stdin?: string | Uint8Array;
}

export interface RunAsUserResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit code. When `timedOut === true`, normalized to 137
   * (= 128 + SIGKILL). Otherwise the OS-reported exit code.
   */
  exitCode: number;
  timedOut: boolean;
}

/**
 * Indirection so tests can inject a fake spawn. Defaults to `Bun.spawn`.
 * @internal Exported for testing.
 */
export type SpawnFn = (
  args: string[],
  options: Parameters<typeof Bun.spawn>[1],
) => ReturnType<typeof Bun.spawn>;

/**
 * Escape a string for safe use inside a single-quoted shell context.
 * Identical implementation to user-mode.ts:shellEscape.
 * @internal Exported for testing.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the `cd <cwd> && export K=v ...; <command>` inner shell string used
 * when elevation is in play. Returns `command` unchanged when there is
 * nothing to prepend. Keys that do not match POSIX env-var naming are
 * silently dropped (with a warn log) to prevent shell injection via crafted
 * key names.
 * @internal Exported for testing.
 */
export function buildInnerCommand(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  const exportPairs: string[] = [];
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      if (!VALID_ENV_KEY.test(key)) {
        logger.warn({ key }, 'runAsUser: skipping env var with invalid key name');
        continue;
      }
      exportPairs.push(`${key}=${shellEscape(value)}`);
    }
  }

  const parts: string[] = [];
  if (cwd !== undefined) {
    parts.push(`cd ${shellEscape(cwd)}`);
  }
  if (exportPairs.length > 0) {
    // `export K1=v1 K2=v2` in one statement; ';' between cd and export so the
    // export still runs even if `cd` fails to set up the env for diagnostic
    // visibility -- but we prefer `&&` to fail fast on cwd error. Match
    // user-mode.ts:478-480 which uses `&& export ...; <command>`.
    parts.push(`export ${exportPairs.join(' ')}`);
  }
  if (parts.length === 0) {
    return command;
  }
  // user-mode.ts pattern: `cd X && export A=1 B=2; <command>`
  // -- `&&` between cd and export (fail fast on bad cwd),
  //    `;` before the user command (so `export` warnings do not block).
  return `${parts.join(' && ')}; ${command}`;
}

/**
 * Decide whether `runAsUser` would actually elevate for the given username
 * under the current `AUTH_MODE`. Callers use this to gate companion logic
 * that only makes sense when running as a different OS user (e.g., the
 * source-repo `safe.directory` bootstrap in `worktree-service.ts`).
 *
 * Reads `process.env.AUTH_MODE` and `os.userInfo().username` at call time so
 * the result reflects the same runtime conditions `runAsUser` itself sees.
 */
export function shouldElevateForUser(
  username: string | null | undefined,
): boolean {
  const authMode = process.env.AUTH_MODE;
  const serverUsername = os.userInfo().username;
  return (
    authMode === 'multi-user' &&
    typeof username === 'string' &&
    username.length > 0 &&
    username !== serverUsername
  );
}

/**
 * Build the argv that will actually be spawned. Pure function so tests can
 * assert the shape without spawning a real process.
 * @internal Exported for testing.
 */
export function buildSpawnArgs(
  username: string | null | undefined,
  command: string,
  preserveEnv: readonly string[],
  serverUsername: string,
  authMode: string | undefined,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): { args: string[]; elevated: boolean } {
  const shouldElevate =
    authMode === 'multi-user' &&
    typeof username === 'string' &&
    username.length > 0 &&
    username !== serverUsername;

  if (!shouldElevate) {
    // Non-elevated branch: spawn options carry cwd/env directly (no
    // environment reset), so the inner command stays as-is.
    return { args: ['sh', '-c', command], elevated: false };
  }

  // Elevated branch: `sudo -i` resets env and chdirs to target HOME, so cwd
  // and env MUST be interpolated into the inner command. Mirror of
  // user-mode.ts:493-500.
  const innerCommand = buildInnerCommand(command, cwd, env);
  const args: string[] = ['sudo', '-u', username];
  if (preserveEnv.length > 0) {
    args.push(`--preserve-env=${preserveEnv.join(',')}`);
  }
  args.push('-i', 'sh', '-c', innerCommand);
  return { args, elevated: true };
}

/**
 * Run `command` as `opts.username`, elevating via `sudo` when necessary.
 *
 * See module-level docs for full semantics.
 */
export async function runAsUser(
  opts: RunAsUserOpts,
  spawn: SpawnFn = Bun.spawn,
): Promise<RunAsUserResult> {
  const preserveEnv = opts.preserveEnv ?? [...DEFAULT_PRESERVE_ENV];
  const serverUsername = os.userInfo().username;
  const authMode = process.env.AUTH_MODE;

  const { args, elevated } = buildSpawnArgs(
    opts.username,
    opts.command,
    preserveEnv,
    serverUsername,
    authMode,
    opts.cwd,
    opts.env,
  );

  // When elevated: cwd / env were embedded into the inner command. The outer
  // spawn pins to a neutral cwd (see SUDO_NEUTRAL_CWD docs) and does not
  // forward `opts.env` (it would be reset by `sudo -i` anyway and could only
  // confuse readers of the spawn options).
  //
  // When NOT elevated: the outer shell is the one that runs the command, so
  // cwd / env flow through spawn options as usual.
  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (opts.stdin !== undefined) {
    // Caller provided stdin bytes -- normalize string to UTF-8 and hand
    // Bun.spawn the Uint8Array. Bun's `stdin` option accepts Uint8Array,
    // Blob, ReadableStream, etc.; Uint8Array is the simplest contract.
    const stdinBytes =
      typeof opts.stdin === 'string'
        ? new TextEncoder().encode(opts.stdin)
        : opts.stdin;
    spawnOptions.stdin = stdinBytes;
  }
  if (elevated) {
    spawnOptions.cwd = SUDO_NEUTRAL_CWD;
  } else {
    if (opts.cwd !== undefined) {
      spawnOptions.cwd = opts.cwd;
    }
    if (opts.env !== undefined) {
      // Bun.spawn's `env` option REPLACES the child environment (it does not
      // merge with process.env), so we must layer `opts.env` over the parent
      // environment ourselves. Without this, callers that pass a single
      // override (e.g., GIT_TERMINAL_PROMPT=0) lose PATH/HOME/etc. and the
      // command typically fails to resolve. Matches the pattern used by
      // repository-description-generator.ts:110-115. The elevated branch
      // does not need this because `export K=v` inside the inner shell
      // augments the login shell's environment rather than replacing it.
      spawnOptions.env = { ...process.env, ...opts.env };
    }
  }

  const proc = spawn(args, spawnOptions);

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }

  // Bun resolves `proc.exited` to `null` for signal-killed processes; the
  // helper normalizes that to TIMEOUT_EXIT_CODE so the public type stays
  // `number`. `timedOut` is the canonical signal -- consumers should branch
  // on it, not on the exit code, to decide "did we hit the timeout?".
  const rawExitCode = await proc.exited;
  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }
  const exitCode = timedOut
    ? TIMEOUT_EXIT_CODE
    : typeof rawExitCode === 'number'
      ? rawExitCode
      : TIMEOUT_EXIT_CODE;

  // stdout/stderr are guaranteed ReadableStream because we requested 'pipe'
  // above; Bun's discriminated return type also admits `number` (fd) for the
  // non-pipe branches, hence the cast.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);

  logger.info(
    { username: opts.username ?? null, elevated, exitCode, timedOut },
    'runAsUser completed',
  );

  return { stdout, stderr, exitCode, timedOut };
}
