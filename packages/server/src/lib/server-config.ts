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
   * Output files larger than this are truncated from the beginning.
   * Default: 10MB (10 * 1024 * 1024 bytes)
   */
  WORKER_OUTPUT_FILE_MAX_SIZE: parseInt(process.env.WORKER_OUTPUT_FILE_MAX_SIZE || String(10 * 1024 * 1024), 10),
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
} as const;

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
