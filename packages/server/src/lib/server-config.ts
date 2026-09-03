import { parseOptionalBoolean, parseIntWithDefault, parsePositiveIntWithDefault } from './env-parser.js';

/**
 * Centralized server-specific environment configuration.
 *
 * All server-only environment variables should be defined here.
 * This serves as a single source of truth and enables automatic
 * generation of BLOCKED_ENV_VARS for child processes.
 *
 * IMPORTANT: Variables that should be passed to child processes
 * (e.g., PATH, HOME, API keys for child tools) should NOT be added here.
 * Only add variables that are specific to the server's operation.
 */

export const serverConfig = {
  /** Server's environment mode (development/production) */
  NODE_ENV: process.env.NODE_ENV,
  /** Server's port binding */
  PORT: process.env.PORT || '3457',
  /**
   * Server's host binding.
   * Defaults to 0.0.0.0 (all interfaces) to avoid IPv4/IPv6 resolution issues.
   * On macOS, 'localhost' may resolve to IPv6 only (::1), causing browsers
   * that connect via IPv4 to fail.
   */
  HOST: process.env.HOST || '0.0.0.0',
  /** Log level (trace, debug, info, warn, error, fatal) */
  LOG_LEVEL: process.env.LOG_LEVEL,
  /**
   * Maximum size of output buffer per worker (in bytes).
   * This buffer stores terminal output for reconnection history.
   * Default: 100KB (100000 bytes)
   */
  WORKER_OUTPUT_BUFFER_SIZE: parseInt(process.env.WORKER_OUTPUT_BUFFER_SIZE || '100000', 10),
  /**
   * Maximum size of worker output file (in bytes).
   * When the live output file exceeds this, the oldest ~20% is archived into a
   * gzip segment (not destroyed) and the live file is rewritten to the remainder.
   * Default: 10MB (10 * 1024 * 1024 bytes)
   */
  WORKER_OUTPUT_FILE_MAX_SIZE: parseInt(process.env.WORKER_OUTPUT_FILE_MAX_SIZE || String(10 * 1024 * 1024), 10),
  /**
   * Maximum number of archived gzip segments retained per worker.
   * When exceeded after a cut, the oldest segments are deleted (their history
   * becomes unreachable). `0` opts into unlimited retention.
   * Default: 100 segments (~200MB raw / ~20MB gz at the default segment size).
   */
  WORKER_OUTPUT_MAX_SEGMENTS: parseInt(process.env.WORKER_OUTPUT_MAX_SEGMENTS || '100', 10),
  /**
   * Server-side cap on the bytes served in a single `history-range` response
   * (backwards paging). The client's `maxBytes` hint is min'd against this; the
   * server also clamps to a single storage unit (one segment or the live file),
   * so a response never stitches across a boundary (terminal-history-paging.md §5.2).
   * Default: 256KB (256 * 1024 bytes)
   */
  WORKER_OUTPUT_RANGE_MAX_BYTES: parseInt(process.env.WORKER_OUTPUT_RANGE_MAX_BYTES || String(256 * 1024), 10),

  /**
   * Ceiling on how far restore walks BACK through archived segments looking
   * for a compaction boundary. Generous by default: the walk stops at a
   * boundary or the true start in the ordinary case, and this only bounds the
   * pathological history that has neither. Exceeding it is treated exactly as
   * a pruned history -- partial restore from the first `user-message` within
   * what was read -- because uncapped, a very long history would be assembled
   * into memory and then into the `init` payload.
   */
  WORKER_OUTPUT_RESTORE_MAX_BYTES: parsePositiveIntWithDefault(
    process.env.WORKER_OUTPUT_RESTORE_MAX_BYTES,
    16 * 1024 * 1024,
  ),
  /**
   * Ceiling on how far the DISPLAY read (`readHistoryForDisplay`) walks BACK
   * through archived segments filling `WORKER_OUTPUT_INITIAL_HISTORY_LINES`
   * (R2, #1506). Same shape as `WORKER_OUTPUT_RESTORE_MAX_BYTES` but a
   * distinct knob -- the two answer different questions (how much
   * reconstruction context is safe to hand a fresh conversation vs. how much
   * archive I/O one client's initial-load request may cost) and are not
   * guaranteed to want the same value going forward. Exceeding it (or
   * exhausting every segment, or hitting a pruned/absent segment) simply
   * stops the walk early: the caller renders whatever was assembled, trimmed
   * to the line budget -- unlike restore, there is no distinct discriminated
   * verdict reported to a display consumer for why the walk stopped.
   */
  WORKER_OUTPUT_DISPLAY_FILL_MAX_BYTES: parsePositiveIntWithDefault(
    process.env.WORKER_OUTPUT_DISPLAY_FILL_MAX_BYTES,
    16 * 1024 * 1024,
  ),
  /**
   * Interval for flushing buffered output to file (in milliseconds).
   * Default: 100ms
   */
  WORKER_OUTPUT_FLUSH_INTERVAL: parseInt(process.env.WORKER_OUTPUT_FLUSH_INTERVAL || '100', 10),
  /**
   * Threshold for flushing buffered output to file (in bytes).
   * When buffer exceeds this size, it's flushed immediately.
   * Default: 64KB (64 * 1024 bytes)
   */
  WORKER_OUTPUT_FLUSH_THRESHOLD: parseInt(process.env.WORKER_OUTPUT_FLUSH_THRESHOLD || String(64 * 1024), 10),
  /**
   * Maximum number of lines to load on initial connection.
   * Full history is still saved, but only the most recent N lines are sent on connection.
   * Default: 5000 lines (approximately 500KB-1MB)
   */
  WORKER_OUTPUT_INITIAL_HISTORY_LINES: parseInt(process.env.WORKER_OUTPUT_INITIAL_HISTORY_LINES || '5000', 10),
  /**
   * Base URL for the application.
   * Used to generate URLs in outbound notifications (e.g., Slack "Open Session" button).
   * If not set, notifications will show a warning about missing configuration.
   * Example: APP_URL=https://agent-console.example.com
   */
  APP_URL: process.env.APP_URL || '',
  /**
   * GitHub webhook secret for verifying webhook signatures.
   * Required for inbound GitHub integration. If not set, webhooks are dropped.
   */
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? '',
  /**
   * Authentication mode.
   * - 'none': Single-user mode (default). No login required.
   * - 'multi-user': Multi-user mode with OS authentication.
   */
  AUTH_MODE: (() => {
    const mode = process.env.AUTH_MODE ?? 'none';
    if (mode !== 'none' && mode !== 'multi-user') {
      throw new Error(`Invalid AUTH_MODE: '${mode}'. Must be 'none' or 'multi-user'.`);
    }
    return mode as 'none' | 'multi-user';
  })(),
  /**
   * OS username of the shared account for shared-session creation.
   * When set in AUTH_MODE=multi-user, enables shared-session creation.
   * Ignored in AUTH_MODE=none.
   * See docs/design/shared-orchestrator-session.md.
   *
   * Empty string is treated as unset (operator-friendly).
   */
  AGENT_CONSOLE_SHARED_USERNAME: process.env.AGENT_CONSOLE_SHARED_USERNAME || undefined,
  /**
   * Controls the Secure attribute on the auth session cookie. Tri-state:
   * - unset (undefined or empty string): current behavior, secure = (NODE_ENV === 'production').
   *   Empty string is treated as unset (operator-friendly).
   * - 'false': never set Secure. For trusted-network plain-HTTP deployments
   *   (e.g. Cloudflare WARP / VPN internal networks) where the browser would
   *   otherwise drop the Secure cookie over HTTP. Disabling on an untrusted
   *   network enables session hijack.
   * - 'true': always set Secure.
   *
   * Any other non-empty value throws (fail-fast). Case-sensitive.
   */
  AUTH_COOKIE_SECURE: (() => {
    try {
      return parseOptionalBoolean(process.env.AUTH_COOKIE_SECURE);
    } catch (e) {
      throw new Error(`Invalid AUTH_COOKIE_SECURE: ${(e as Error).message}`);
    }
  })(),
  /**
   * PTY backend selector.
   * - 'bun-terminal' (default): use `Bun.spawn({ terminal: ... })` (Bun >= 1.3.5).
   * - 'bun-pty': use the bun-pty native shared library.
   *
   * See docs in `lib/pty-provider.ts` for the migration evaluation. Stage 2
   * flips the default to 'bun-terminal'; 'bun-pty' remains selectable as a
   * rollback escape hatch until Stage 3 retires it.
   */
  PTY_PROVIDER: (() => {
    const value = process.env.PTY_PROVIDER ?? 'bun-terminal';
    if (value !== 'bun-pty' && value !== 'bun-terminal') {
      throw new Error(`Invalid PTY_PROVIDER: '${value}'. Must be 'bun-pty' or 'bun-terminal'.`);
    }
    return value as 'bun-pty' | 'bun-terminal';
  })(),
  /**
   * VS Code "Open" mode selector.
   * - undefined (default): capability service decides based on AUTH_MODE.
   *   AUTH_MODE=multi-user -> 'remote-url-scheme' (server likely on remote host);
   *   otherwise 'local-spawn'.
   * - 'local-spawn': server spawns `code <path>` locally.
   * - 'remote-url-scheme': client opens `vscode://vscode-remote/...` URL.
   *
   * Empty string is treated as unset (operator-friendly).
   */
  VSCODE_OPEN_MODE: (() => {
    const raw = process.env.VSCODE_OPEN_MODE?.trim();
    if (!raw) return undefined;
    if (raw !== 'local-spawn' && raw !== 'remote-url-scheme') {
      throw new Error(
        `Invalid VSCODE_OPEN_MODE: '${raw}'. Must be 'local-spawn' or 'remote-url-scheme'.`
      );
    }
    return raw as 'local-spawn' | 'remote-url-scheme';
  })(),
  /**
   * Host to embed in `vscode://vscode-remote/ssh-remote+HOST<path>` URLs when
   * `VSCODE_OPEN_MODE === 'remote-url-scheme'`. When unset, the client uses
   * `window.location.hostname`.
   *
   * Empty string is treated as unset (operator-friendly).
   */
  VSCODE_REMOTE_HOST: (() => {
    const raw = process.env.VSCODE_REMOTE_HOST?.trim();
    return raw || undefined;
  })(),
  /**
   * Absolute path (or bare command name) used to invoke `bun` when spawning
   * the embedded-agent loop subprocess as a (possibly elevated, cross-user)
   * OS process. Defaults to `process.execPath` -- the absolute path of the
   * `bun` binary currently running this server process.
   *
   * Single-user / dev: this default is EXACT by construction. `process.execPath`
   * is literally the same binary file the server itself is running -- there is
   * no PATH lookup, and therefore no PATH ambiguity, involved in choosing it.
   *
   * This correctness rests on a documented assumption about how the server is
   * deployed: the current deploy shape is `bun dist/index.js` (or
   * `bun src/index.ts` in dev), so `process.execPath` IS the bun interpreter
   * executing this file. If a future deploy shape switches to
   * `bun build --compile` (producing a standalone compiled binary),
   * `process.execPath` would resolve to THAT compiled binary instead of a bun
   * interpreter, and this default would silently become wrong. This is not a
   * TODO -- it is the boundary of what this default is known to be correct for.
   *
   * Multi-user: real deployments set this explicitly via
   * `scripts/setup-multiuser-for-ubuntu.sh` (unchanged from before this
   * default changed); the `process.execPath` default only matters for an
   * unconfigured / dev instance. In multi-user mode, the subprocess runs
   * inside an elevated login shell (`sudo -u <user> -i sh -c '...'`) whose
   * non-interactive, non-bash `sh` (dash on Ubuntu) does not source `.bashrc`
   * -- a user-local `~/.bun/bin/bun` install is therefore NOT resolvable by
   * bare name inside that shell. Set this to an absolute path (e.g.
   * '/usr/local/bin/bun') reachable by every elevation target user;
   * `scripts/setup-multiuser-for-ubuntu.sh` provisions this path and
   * configures the systemd unit's Environment= accordingly.
   *
   * See .claude/rules/os-environment-coupling.md for the general principle:
   * elevated commands must not resolve binaries by PATH-only name.
   */
  EMBEDDED_AGENT_BUN_PATH: process.env.EMBEDDED_AGENT_BUN_PATH || process.execPath,
  /**
   * Milliseconds of continuous idleness after which a `claude-sdk` embedded-agent
   * worker's subprocess is evicted. Governs that engine only -- `openai-api`
   * workers are never evicted.
   *
   * Eviction drops the subprocess; the worker stays logically alive and the
   * next message delivered to it transparently wakes it (re-activating and
   * resuming the conversation), so the user is meant not to notice.
   *
   * `0` -- or any non-positive value -- disables eviction entirely. An
   * unparseable value falls back to the default rather than disabling: a typo
   * in an env var silently switching off memory management is a footgun, and
   * this is a system boundary where the one guard is worth it.
   *
   * Default: 30 minutes. Tests set it to a handful of milliseconds.
   */
  EMBEDDED_AGENT_IDLE_EVICTION_MS: parseIntWithDefault(
    process.env.EMBEDDED_AGENT_IDLE_EVICTION_MS,
    30 * 60 * 1000,
  ),
  /**
   * The origin the server believes it is reachable at by human viewers
   * (e.g. 'http://192.168.1.12:6340'). Used to mint absolute artifact-viewer
   * URLs (HTML Artifacts) -- there is no other viewer-facing
   * base URL in the codebase; `getMcpBaseUrl` is a same-host agent
   * dial-back address, not a value a human on another machine should open.
   *
   * NO SILENT DEFAULT of any kind, and NEVER derived from a request `Host`
   * header -- MCP tool calls arrive over the localhost dial-back, so the
   * `Host` header an MCP handler sees names the wrong machine. When unset,
   * consumers must fall back to a relative path plus an explicit note that
   * the origin is unconfigured (docs/design/html-artifacts.md §4.1).
   *
   * `dev.sh` exports 'http://localhost:<PORT>' for single-user dev
   * convenience; `scripts/setup-multiuser-for-ubuntu.sh` provisions it as an
   * operator-supplied opt-in value (it knows the host it installs on).
   *
   * Empty string is treated as unset (operator-friendly, same
   * trim-to-undefined convention as `VSCODE_REMOTE_HOST`).
   *
   * Trailing slash(es) are stripped: `buildArtifactToolResult` (mcp-server.ts)
   * concatenates this value directly with a leading-slash relative path, so
   * an operator-supplied trailing slash (e.g. `http://host:6340/`) would
   * otherwise produce a double slash in the minted artifact URL.
   */
  AGENT_CONSOLE_PUBLIC_ORIGIN: (() => {
    const raw = process.env.AGENT_CONSOLE_PUBLIC_ORIGIN?.trim();
    return raw ? raw.replace(/\/+$/, '') : undefined;
  })(),
} as const;

/**
 * Resolve whether the auth cookie should carry the Secure attribute.
 * Unset AUTH_COOKIE_SECURE preserves the historical behavior (Secure in production).
 */
export function resolveAuthCookieSecure(
  config: Pick<ServerConfig, 'AUTH_COOKIE_SECURE' | 'NODE_ENV'> = serverConfig,
): boolean {
  return config.AUTH_COOKIE_SECURE ?? config.NODE_ENV === 'production';
}

/**
 * Whether to emit the loud startup warning: secure cookies are explicitly
 * disabled in a production serving context, where the auth cookie would
 * otherwise be Secure. Fires ONLY in this case to avoid dev-startup noise.
 */
export function shouldWarnInsecureAuthCookie(
  config: Pick<ServerConfig, 'AUTH_COOKIE_SECURE' | 'NODE_ENV'> = serverConfig,
): boolean {
  return config.AUTH_COOKIE_SECURE === false && config.NODE_ENV === 'production';
}

/**
 * Whether to run the boot-time `EMBEDDED_AGENT_BUN_PATH` assessment (Issue
 * #1291). Gated on multi-user mode only -- single-user's `process.execPath`
 * default is correct by construction (see the field's own doc comment
 * above), so running the assessment there would only ever produce noise.
 */
export function shouldCheckEmbeddedAgentBunPath(
  config: Pick<ServerConfig, 'AUTH_MODE'> = serverConfig,
): boolean {
  return config.AUTH_MODE === 'multi-user';
}

/**
 * Whether to emit the informational boot-time log line: `AGENT_CONSOLE_PUBLIC_ORIGIN`
 * is unset, so artifact-viewer tools will return relative paths instead of
 * absolute URLs. Deliberately mode-independent (NOT keyed on AUTH_MODE
 * single-user vs multi-user) -- docs/design/html-artifacts.md §4.1's
 * "no mode-keyed inference anywhere" is load-bearing; a mode-keyed check
 * here would silently reintroduce the exact inference the spec forbids.
 */
export function shouldLogUnconfiguredPublicOrigin(
  config: Pick<ServerConfig, 'AGENT_CONSOLE_PUBLIC_ORIGIN'> = serverConfig,
): boolean {
  return config.AGENT_CONSOLE_PUBLIC_ORIGIN === undefined;
}

/**
 * Default patterns to ignore when watching for file changes.
 * These are commonly excluded directories and files that generate
 * frequent changes but are not relevant to git diff updates.
 */
const DEFAULT_FILE_WATCH_IGNORE_PATTERNS = [
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.log',
  '.env.local',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Parse comma-separated ignore patterns from environment variable.
 * If not set, returns the default patterns.
 *
 * Example: FILE_WATCH_IGNORE_PATTERNS=".git,node_modules,.cache,tmp"
 */
function parseFileWatchIgnorePatterns(): string[] {
  const envValue = process.env.FILE_WATCH_IGNORE_PATTERNS;
  if (!envValue) {
    return DEFAULT_FILE_WATCH_IGNORE_PATTERNS;
  }
  return envValue.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Patterns to ignore when watching for file changes.
 * Can be customized via FILE_WATCH_IGNORE_PATTERNS environment variable.
 * Format: comma-separated list of patterns (e.g., ".git,node_modules,.cache")
 */
export const fileWatchIgnorePatterns = parseFileWatchIgnorePatterns();

/**
 * List of environment variable names that are server-only.
 * Auto-generated from serverConfig keys.
 * Used by env-filter to prevent these from being passed to child processes.
 */
export const SERVER_ONLY_ENV_VARS = Object.keys(serverConfig) as ReadonlyArray<
  keyof typeof serverConfig
>;

/** Type for server configuration */
export type ServerConfig = typeof serverConfig;
