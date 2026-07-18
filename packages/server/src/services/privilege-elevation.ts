/**
 * Privilege-elevation helper for server-side operations that must run as the
 * requesting user (multi-user mode).
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
import * as path from 'node:path';
import type { Subprocess, FileSink } from 'bun';
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

/**
 * Recursive `rm` as the requesting user.
 *
 * Layer-correctness helper: encapsulates the canonical `rm -rf -- <path>`
 * elevated-removal pattern that consumers (worktree deletion, partial-clone
 * cleanup, hook teardown, ...) would otherwise inline. Mirrors how
 * `lib/git.ts` encapsulates git command construction.
 *
 * Semantics:
 * - `null` / `undefined` / single-user-mode username bypasses elevation via
 *   {@link runAsUser}'s own short-circuit.
 * - Pins outer cwd to `/` because the target path itself may not exist
 *   anymore (e.g., partial deletion left behind by a prior failure).
 * - Idempotent: POSIX `rm -rf --` does not fail on missing paths.
 * - `--` terminates option parsing so paths beginning with `-` are still
 *   treated as paths, not flags.
 *
 * Returns the underlying {@link RunAsUserResult} so callers can branch on
 * `exitCode` / `timedOut` and surface a meaningful error.
 *
 * `runAsUserImpl` is an optional injection point so service classes that
 * already accept a test-seam `runAsUser` (e.g.
 * {@link WorktreeService.runAsUserImpl}) can route through their own seam
 * rather than the module-level export -- otherwise tests that mock
 * `runAsUserImpl` would not capture rm calls funnelled through this helper.
 */
export async function rmRecursiveAsUser(
  path: string,
  username: string | null | undefined,
  opts: { timeoutMs?: number; runAsUserImpl?: typeof runAsUser } = {},
): Promise<RunAsUserResult> {
  const impl = opts.runAsUserImpl ?? runAsUser;
  return impl({
    username,
    command: `rm -rf -- ${shellEscape(path)}`,
    cwd: '/',
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Send `signal` to `pid` as the requesting user.
 *
 * Layer-correctness helper: encapsulates the canonical `kill -s <SIG> --
 * <pid>` elevated-signal pattern for consumers that need to terminate a
 * process owned by a different OS user (e.g. multi-user orphan-worker
 * cleanup, where the worker's PID was spawned via `resolveSpawnUsername` and
 * the server process cannot signal it directly -- `process.kill(pid, sig)`
 * raises `EPERM` for a cross-user PID).
 *
 * Semantics:
 * - `null` / `undefined` / single-user-mode username bypasses elevation via
 *   {@link runAsUser}'s own short-circuit.
 * - Pins outer cwd to `/`, mirroring {@link rmRecursiveAsUser} -- the target
 *   process's cwd is irrelevant to signalling it, and pinning avoids any
 *   EACCES from an unreadable inherited cwd.
 * - Does NOT interpret the kill's outcome (`ESRCH`, already-dead, etc.) --
 *   returns the underlying {@link RunAsUserResult} unchanged so callers
 *   branch on `exitCode` themselves, exactly like {@link rmRecursiveAsUser}.
 *   This is deliberate: whether a non-zero exit means "already dead, fine"
 *   or "genuinely failed to kill" is the caller's semantics, not this
 *   primitive's.
 * - `pid` is validated as a positive integer before being interpolated into
 *   the shell command. Unlike string paths there is no `shellEscape` step
 *   for a bare numeric argument, so this check is the injection-safety
 *   equivalent for this argument -- a non-integer or non-positive value
 *   never reaches the shell string.
 *
 * `runAsUserImpl` is an optional injection point mirroring
 * {@link rmRecursiveAsUser}'s DI seam for test-correctness.
 */
export async function killAsUser(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  username: string | null | undefined,
  opts: { timeoutMs?: number; runAsUserImpl?: typeof runAsUser } = {},
): Promise<RunAsUserResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`killAsUser: pid must be a positive integer, got ${pid}`);
  }
  const impl = opts.runAsUserImpl ?? runAsUser;
  return impl({
    username,
    command: `kill -s ${signal.replace(/^SIG/, '')} -- ${pid}`,
    cwd: '/',
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Write `content` to `filePath` as `username`, creating the containing
 * directory if necessary, with the file forced to mode 0600 regardless of the
 * ambient umask.
 *
 * Layer-correctness helper: encapsulates the canonical
 * `mkdir -p && umask 077 && cat > <dst>` elevated-write pattern for SECRET
 * payloads (bearer tokens, etc). Distinct from `worktree-service.ts`'s
 * `makeUserOwnedTemplateSink`, which deliberately relies on the ambient umask
 * for non-secret template files — `umask 077` here is the key difference,
 * forcing 0600 so the secret is not group/world-readable irrespective of the
 * target user's default umask.
 *
 * Semantics:
 * - `null` / `undefined` / single-user-mode username bypasses elevation via
 *   {@link runAsUser}'s own short-circuit (content is still written, just not
 *   elevated).
 * - Pins outer cwd to `/` (the destination directory may not exist yet).
 * - `runAsUserImpl` is an optional injection point mirroring
 *   {@link rmRecursiveAsUser}'s DI seam for test-correctness.
 *
 * Returns the underlying {@link RunAsUserResult} so callers can branch on
 * `exitCode` / `timedOut` and surface a meaningful error.
 */
export async function writeUserOwnedSecretFile(opts: {
  username: string;
  filePath: string;
  content: string;
  timeoutMs?: number;
  runAsUserImpl?: typeof runAsUser;
}): Promise<RunAsUserResult> {
  const impl = opts.runAsUserImpl ?? runAsUser;
  const dir = path.dirname(opts.filePath);
  // `cat >` preserves an existing file's mode, so a pre-existing file at a
  // looser mode (e.g. leftover 0644) would silently survive the write and
  // break the 0600 guarantee. Remove any pre-existing file first so a fresh
  // 0600 file is always created under `umask 077`.
  const command = `rm -f -- ${shellEscape(opts.filePath)} && mkdir -p -- ${shellEscape(dir)} && umask 077 && cat > ${shellEscape(opts.filePath)}`;
  return impl({
    username: opts.username,
    command,
    stdin: opts.content,
    cwd: '/',
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Options for `spawnAsUser`. Mirrors the elevation-relevant subset of
 * `RunAsUserOpts`, minus one-shot-only concerns (`timeoutMs`, `stdin` bytes).
 */
export interface SpawnAsUserOpts {
  /**
   * Target OS user. Same semantics as `RunAsUserOpts.username`: null /
   * undefined / equal-to-server-user / `AUTH_MODE !== 'multi-user'` all
   * bypass elevation.
   */
  username: string | null | undefined;
  /** Shell command (passed verbatim to `sh -c`). */
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Env-var names to preserve across the elevated shell via
   * `--preserve-env=NAME1,NAME2,...`. Defaults to `['FORCE_COLOR']`. An empty
   * array suppresses the flag entirely. Ignored when elevation is bypassed.
   */
  preserveEnv?: string[];
}

/**
 * Long-lived spawn result. Unlike `runAsUser`, the caller manages the
 * lifecycle of the returned subprocess (write to stdin over time, kill, etc).
 */
export interface SpawnAsUserResult {
  /**
   * The live Bun subprocess. Discriminated to the `'pipe','pipe','pipe'`
   * variant so callers retain typed access to `stdin` / `stdout` / `stderr`
   * as the corresponding streams.
   */
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'>;
  /**
   * Alias for `subprocess.stdin` so callers that previously stored
   * `subprocess.stdin` separately (e.g. `StoredProcess.stdin` in
   * `interactive-process-manager.ts`) can keep the existing field shape.
   */
  stdin: FileSink;
  /** Whether the spawn was elevated via `sudo`. Useful for logging. */
  elevated: boolean;
}

/**
 * Indirection so tests can inject a fake spawnAsUser implementation. Mirrors
 * the {@link SpawnFn} pattern used by `runAsUser`.
 * @internal Exported for testing.
 */
export type SpawnAsUserFn = (opts: SpawnAsUserOpts) => SpawnAsUserResult;

/**
 * Long-lived counterpart to {@link runAsUser}. Spawns `command` as
 * `opts.username` (elevating via `sudo` when necessary) and returns the live
 * `Subprocess` plus its `stdin` `FileSink` so callers can write over time
 * and kill on demand.
 *
 * Use this when the caller needs to:
 * - feed bytes to the child's stdin across multiple turns
 * - send SIGTERM / SIGKILL at a later point
 * - read stdout / stderr as streams rather than waiting for a final blob
 *
 * Use {@link runAsUser} when the caller wants a one-shot exec with optional
 * stdin bytes and a fixed timeout.
 *
 * Outer pipe-through-sudo behaviour is identical to the elevated stdin path
 * already in production at `worktree-service.ts:597-602`
 * (`makeUserOwnedTemplateSink.writeFile`), which feeds bytes through
 * `sudo -u <user> --preserve-env=FORCE_COLOR -i sh -c 'cat > <dst>'` via
 * `runAsUser`'s `opts.stdin`. The argv shape and the elevated/non-elevated
 * cwd / env decisions are produced by the same {@link buildSpawnArgs} pure
 * function, so unit tests on `buildSpawnArgs` cover both helpers.
 *
 * Lifecycle is fully the caller's responsibility -- no timeout, no auto-kill.
 */
export function spawnAsUser(
  opts: SpawnAsUserOpts,
  spawn: SpawnFn = Bun.spawn,
): SpawnAsUserResult {
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

  // Spawn options mirror `runAsUser`'s elevated / non-elevated branches:
  // - Elevated: cwd / env are embedded into the inner shell command, the
  //   outer spawn pins to SUDO_NEUTRAL_CWD and does not forward `opts.env`
  //   (it would be reset by `sudo -i` anyway).
  // - Non-elevated: cwd / env flow through spawn options as usual; `opts.env`
  //   is layered over `process.env` because `Bun.spawn`'s `env` option
  //   REPLACES (not merges) the child environment.
  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (elevated) {
    spawnOptions.cwd = SUDO_NEUTRAL_CWD;
  } else {
    if (opts.cwd !== undefined) {
      spawnOptions.cwd = opts.cwd;
    }
    if (opts.env !== undefined) {
      spawnOptions.env = { ...process.env, ...opts.env };
    }
  }

  // `Bun.spawn`'s discriminated return type narrows on the stdio options we
  // pass. We always request `'pipe'` for all three streams above, so the
  // returned subprocess is of the fully-piped variant. The `as` is a single
  // direct cast at the boundary (no `unknown` intermediate); it does not
  // change any runtime behaviour.
  const subprocess = spawn(args, spawnOptions) as Subprocess<
    'pipe',
    'pipe',
    'pipe'
  >;

  logger.info(
    { username: opts.username ?? null, elevated },
    'spawnAsUser spawned',
  );

  return {
    subprocess,
    stdin: subprocess.stdin,
    elevated,
  };
}
