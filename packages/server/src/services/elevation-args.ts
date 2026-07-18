/**
 * Pure helpers for building the argv that `MultiUserMode.spawnSudoPty`
 * passes to the OS-level `sudo` invocation. Extracted so production code and
 * the post-deploy smoke script (`scripts/smoke/check-multiuser-pty-env.ts`)
 * share a single source of truth for the elevation command shape.
 *
 * No I/O. No side effects. Pure function from input shape to argv + inner
 * shell command string.
 *
 * Design choice: the elevated user's natural login env (set by
 * `sudo -i`'s shell init: PATH / HOME / USER / SHELL / LOGNAME / LANG / ...)
 * is the source of truth for those vars. We do NOT inherit bun server's env;
 * doing so would override the elevated user's natural env and break PATH
 * lookup, HOME-relative config loading, etc.
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

/**
 * Env vars whose values must come from the elevated user's natural login
 * shell init -- never from per-spawn additionalEnvVars (repository / template
 * env). If a caller (e.g., a malicious or careless repository config)
 * supplies any of these in `additionalEnvVars`, the helper silently strips
 * them before exporting, so the elevated user's PATH lookup, HOME-relative
 * config loading, library preload chain, etc. cannot be overridden across
 * the privilege boundary.
 *
 * COLOR env (TERM / COLORTERM / FORCE_COLOR) is intentionally NOT in this
 * list -- a template legitimately may want to force, e.g., TERM=dumb for a
 * non-interactive headless command. Color env overrides are scoped to
 * presentation, not to security-critical resolution.
 *
 * Mirrors `PROTECTED_ENV_VARS` in `env-filter.ts` minus the color trinity.
 * The previous "additionalEnvVars wins" rule was too permissive at the
 * privilege boundary.
 */
const PRIVILEGE_BOUNDARY_PROTECTED: readonly string[] = Object.freeze([
  // Security-sensitive: library injection
  'LD_PRELOAD',           // Linux: preload shared library
  'LD_LIBRARY_PATH',      // Linux: library search path
  'DYLD_INSERT_LIBRARIES', // macOS: preload dynamic library
  'DYLD_LIBRARY_PATH',    // macOS: library search path
  'DYLD_FRAMEWORK_PATH',  // macOS: framework search path
  // System-critical: must come from login shell init
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
]);

function stripPrivilegeBoundaryProtected(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!PRIVILEGE_BOUNDARY_PROTECTED.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

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
   * collision with the color env, EXCEPT for privilege-boundary-protected
   * keys (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LD_PRELOAD`, etc. --
   * see `PRIVILEGE_BOUNDARY_PROTECTED`), which are silently stripped so a
   * caller cannot override the elevated user's natural login env.
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
  /**
   * Optional SSH_AUTH_SOCK fallback path for delegated worktree sessions.
   * When set, the inner shell command will conditionally export
   * SSH_AUTH_SOCK from this path IF AND ONLY IF SSH_AUTH_SOCK is currently
   * unset (or empty) AND the referenced socket file exists. The snippet is
   * placed BEFORE the explicit `export <COMBINED>` so an explicit
   * `SSH_AUTH_SOCK` in `additionalEnvVars` overrides the fallback.
   *
   * Populated only by the MCP delegate path using
   * `${user.homeDir}/.1password/agent.sock` (Linux 1Password convention).
   * Other code paths (REST, EnterWorktree, resume) leave this undefined
   * and the inner command emits no SSH_AUTH_SOCK-related shell code,
   * preserving prior behavior.
   */
  sshAuthSockFallback?: string;
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
  // Strip privilege-boundary-protected vars from additionalEnvVars BEFORE
  // merging. This prevents a malicious / careless repository config from
  // overriding the elevated user's PATH, HOME, LD_PRELOAD, etc. via per-spawn
  // env.
  const filteredAdditional = stripPrivilegeBoundaryProtected(input.additionalEnvVars);
  const combined: Record<string, string> = {
    ...COLOR_ENV,
    ...filteredAdditional,
    ...(input.agentConsoleVars ?? {}),
  };
  const exports = buildExportString(combined);
  const cdPart = `cd ${shellEscape(input.cwd)}`;
  // Conditional SSH_AUTH_SOCK fallback for delegated sessions.
  // Placed BEFORE the explicit `export <COMBINED>` so an explicit
  // SSH_AUTH_SOCK in `additionalEnvVars` still wins via the later export.
  // The `if ... fi` block always exits 0, so the following `&&` chain runs.
  const sshAuthSockSnippet = input.sshAuthSockFallback
    ? ` && if [ -z "$SSH_AUTH_SOCK" ] && [ -S ${shellEscape(input.sshAuthSockFallback)} ]; then export SSH_AUTH_SOCK=${shellEscape(input.sshAuthSockFallback)}; fi`
    : '';
  const innerCommand = exports
    ? `${cdPart}${sshAuthSockSnippet} && export ${exports}; ${input.command}`
    : `${cdPart}${sshAuthSockSnippet} && ${input.command}`;
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
