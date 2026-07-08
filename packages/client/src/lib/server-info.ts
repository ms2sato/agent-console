let cachedServerPort: number | null = null;

/**
 * Set the backend HTTP port for the running server.
 * Should be called once at app initialization from the `/api/config` response.
 */
export function setServerPort(port: number): void {
  cachedServerPort = port;
}

/**
 * Get the cached backend HTTP port, or `null` if it was not set yet.
 * Consumers should treat `null` as "unknown" and avoid rendering
 * server-URL-dependent UI in that case.
 */
export function getServerPort(): number | null {
  return cachedServerPort;
}

/**
 * Reset for testing.
 * @internal
 */
export function _reset(): void {
  cachedServerPort = null;
}
