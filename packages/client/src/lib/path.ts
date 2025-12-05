let cachedHomeDir: string | null = null;

/**
 * Set the home directory for path formatting
 * Should be called once at app initialization
 */
export function setHomeDir(homeDir: string): void {
  cachedHomeDir = homeDir;
}

/**
 * Format a path for display, replacing home directory with ~/
 */
export function formatPath(path: string): string {
  if (cachedHomeDir && path.startsWith(cachedHomeDir)) {
    return '~' + path.slice(cachedHomeDir.length);
  }
  return path;
}
