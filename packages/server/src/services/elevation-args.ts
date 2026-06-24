/**
 * Pure helpers for building the argv that `MultiUserMode.spawnSudoPty`
 * passes to the OS-level `sudo` invocation. Extracted so production code and
 * the post-deploy smoke script (`scripts/smoke/check-multiuser-pty-env.ts`)
 * share a single source of truth for the elevation command shape.
 *
 * No I/O. No side effects. Pure function from input shape to argv + inner
 * shell command string.
 *
 * Design choice (Issue #866): the elevated user's natural login env (set by
 * `sudo -i`'s shell init: PATH / HOME / USER / SHELL / LOGNAME / LANG / ...)
 * is the source of truth for those vars. We do NOT inherit bun server's env;
 * doing so would override the elevated user's natural env and break PATH
 * lookup, HOME-relative config loading, etc. (PR #864's regression).
 *
 * The only env vars we inject across the privilege boundary are the ones
 * sudo strips AND login shell init does not restore -- empirically just the
 * color trinity (TERM / COLORTERM / FORCE_COLOR). Linux sudo defaults do not
 * preserve them in env_keep; no shell init script sets them (terminals are
 * detection-driven, but here the terminal is xterm.js via our PTY allocation
 * -- we know the capability and pass it explicitly).
 *
 * Sync contract: production code (`MultiUserMode.spawnSudoPty`) and the
 * post-deploy smoke script BOTH import `buildElevationArgs` from this
 * module, so the argv shape they exercise cannot drift.
 */

const COLOR_ENV: Readonly<Record<string, string>> = Object.freeze({
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
});

export interface ElevationArgsInput {
  /**
   * Target OS user the privilege-elevation chain should land in.
   */
  username: string;
  /**
   * The cwd the inner shell should `cd` into before running the command.
   */
  cwd: string;
  /**
   * Per-spawn additional env (repository / template env). Wins on key
   * collision with the color env.
   */
  additionalEnvVars: Record<string, string>;
  /**
   * Optional agent-context env (AGENT_CONSOLE_* vars). Only set for agent
   * workers. Wins on key collision with additionalEnvVars + color env, since
   * it's spawn-context-specific.
   */
  agentConsoleVars?: Record<string, string>;
  /**
   * The shell command to execute after the cd + export. For terminal
   * workers, typically `exec $SHELL -l`. For agent workers, the agent's
   * launch command.
   */
  command: string;
}

export interface ElevationArgs {
  /**
   * Positional argv for `sudo`. Pass to `spawn('sudo', argv, opts)`.
   */
  argv: string[];
  /**
   * The inner shell command string that the last argv element wraps. Exposed
   * for test assertions and the smoke script's diagnostics; production code
   * does not need to read this separately.
   */
  innerCommand: string;
}

/**
 * Build the sudo argv + inner shell command for a privilege-elevated PTY
 * spawn. See module-level comment for the design rationale and sync
 * contract.
 */
export function buildElevationArgs(input: ElevationArgsInput): ElevationArgs {
  const combined: Record<string, string> = {
    ...COLOR_ENV,
    ...input.additionalEnvVars,
    ...(input.agentConsoleVars ?? {}),
  };
  const exports = buildExportString(combined);
  const cdPart = `cd ${shellEscape(input.cwd)}`;
  const innerCommand = exports
    ? `${cdPart} && export ${exports}; ${input.command}`
    : `${cdPart} && ${input.command}`;
  return {
    argv: [
      '-u',
      input.username,
      // `--preserve-env=FORCE_COLOR` is kept as harmless safety: if a future
      // deploy injects FORCE_COLOR at the bun process / systemd unit level,
      // sudo would preserve it. Today the bun process does not carry it; the
      // color env above is what makes color work.
      '--preserve-env=FORCE_COLOR',
      '-i',
      'sh',
      '-c',
      innerCommand,
    ],
    innerCommand,
  };
}

/**
 * Convert a Record<string, string> to a shell export string.
 * e.g., "KEY1=val1 KEY2=val2"
 *
 * Keys are validated against POSIX environment variable naming rules to
 * prevent shell injection via crafted key names. Invalid keys are silently
 * skipped (the caller's logging context is not available here; production
 * callers should log invalid keys at the call site if needed).
 */
export function buildExportString(vars: Record<string, string>): string {
  return Object.entries(vars)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(' ');
}

/**
 * Escape a string for safe use in a single-quoted shell context.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
