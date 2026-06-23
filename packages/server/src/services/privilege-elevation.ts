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
 *   from the server-process user -> invoke the same `sudo -u <user>
 *   --preserve-env=... -i sh -c <command>` shape established by the PTY worker
 *   at `packages/server/src/services/user-mode.ts:493-500`.
 * - Otherwise (single-user mode, no username, or same-user) -> invoke
 *   `['sh', '-c', command]` directly with no elevation.
 *
 * `preserveEnv` defaults to `['FORCE_COLOR']` (mirroring the PTY worker's
 * default so Node-based agents retain truecolor support across the
 * environment reset that `sudo -i` performs). When `preserveEnv` is passed
 * explicitly the provided list REPLACES the default — callers that want to
 * add to the default should pass `['FORCE_COLOR', 'NO_COLOR', ...]`. Passing
 * `[]` means no preservation flags are emitted.
 */
import * as os from 'node:os';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:privilege-elevation');

const DEFAULT_PRESERVE_ENV = ['FORCE_COLOR'] as const;

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
}

export interface RunAsUserResult {
  stdout: string;
  stderr: string;
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
): { args: string[]; elevated: boolean } {
  const shouldElevate =
    authMode === 'multi-user' &&
    typeof username === 'string' &&
    username.length > 0 &&
    username !== serverUsername;

  if (!shouldElevate) {
    return { args: ['sh', '-c', command], elevated: false };
  }

  // Mirror of packages/server/src/services/user-mode.ts:493-500
  // The --preserve-env flag survives `sudo -i`'s environment reset.
  const args: string[] = ['sudo', '-u', username];
  if (preserveEnv.length > 0) {
    args.push(`--preserve-env=${preserveEnv.join(',')}`);
  }
  args.push('-i', 'sh', '-c', command);
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
  );

  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (opts.cwd !== undefined) {
    spawnOptions.cwd = opts.cwd;
  }
  if (opts.env !== undefined) {
    spawnOptions.env = opts.env;
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

  const exitCode = await proc.exited;
  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

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
