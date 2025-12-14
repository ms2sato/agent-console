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
  /** Server's host binding (defaults to localhost for security) */
  HOST: process.env.HOST || 'localhost',
  /** Log level (trace, debug, info, warn, error, fatal) */
  LOG_LEVEL: process.env.LOG_LEVEL,
  /**
   * Maximum size of output buffer per worker (in bytes).
   * This buffer stores terminal output for reconnection history.
   * Default: 100KB (100000 bytes)
   */
  WORKER_OUTPUT_BUFFER_SIZE: parseInt(process.env.WORKER_OUTPUT_BUFFER_SIZE || '100000', 10),
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
