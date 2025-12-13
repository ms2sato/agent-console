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
  /** Server's host binding */
  HOST: process.env.HOST ?? 'localhost',
  /** Log level (trace, debug, info, warn, error, fatal) */
  LOG_LEVEL: process.env.LOG_LEVEL,
} as const;

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
