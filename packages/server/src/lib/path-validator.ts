import { resolve as resolvePath, normalize } from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * Paths that are explicitly denied for session locations.
 * These are sensitive system directories that should never be used.
 *
 * We use a deny-list approach rather than allow-list because:
 * - Users may legitimately work in /var/services/, /opt/projects/, /srv/, etc.
 * - Docker containers and non-standard setups use various paths
 * - The goal is to prevent access to system-critical directories, not restrict users
 */
const DENIED_PATHS = [
  // Linux/Unix critical system directories
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/lib',
  '/lib64',
  '/usr/lib',
  // macOS system directories
  '/System',
  '/Library/System',
  '/private/etc',
  // Note: /var and /private/var are NOT blocked because:
  // - /var/www, /var/services are legitimate development paths
  // - Only specific sensitive subdirs like /var/log, /var/run could be blocked if needed
];

/**
 * Result of path validation
 */
export interface PathValidationResult {
  valid: boolean;
  error?: string;
  resolvedPath?: string;
}

/**
 * Validates that a path is safe to use as a session location.
 *
 * Rules:
 * 1. Path must NOT be in the deny list (sensitive system directories)
 * 2. Path must exist and be accessible
 *
 * This uses a deny-list approach to block only sensitive system directories
 * while allowing legitimate development paths like /var/services/, /opt/, /srv/, etc.
 *
 * @param inputPath - The path to validate (can be relative or absolute)
 * @returns Validation result with resolved absolute path if valid
 */
export async function validateSessionPath(inputPath: string): Promise<PathValidationResult> {
  try {
    // Resolve to absolute path and normalize (removes .. and .)
    const absolutePath = normalize(resolvePath(inputPath));

    // Check against deny list first
    for (const deniedPath of DENIED_PATHS) {
      if (absolutePath === deniedPath || absolutePath.startsWith(deniedPath + '/')) {
        return {
          valid: false,
          error: `Path is in a restricted system directory: ${deniedPath}`,
        };
      }
    }

    // Get the real path (resolves symlinks) to prevent symlink attacks
    let realPath: string;
    try {
      realPath = await realpath(absolutePath);
    } catch {
      return {
        valid: false,
        error: `Path does not exist: ${inputPath}`,
      };
    }

    // Re-check deny list with resolved symlinks
    for (const deniedPath of DENIED_PATHS) {
      if (realPath === deniedPath || realPath.startsWith(deniedPath + '/')) {
        return {
          valid: false,
          error: `Path resolves to a restricted system directory: ${deniedPath}`,
        };
      }
    }

    return {
      valid: true,
      resolvedPath: realPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      valid: false,
      error: `Failed to validate path: ${message}`,
    };
  }
}
