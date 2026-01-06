/**
 * Module for managing the current server instance ID.
 *
 * The server ID is used to detect server restarts and invalidate stale terminal caches.
 * When the server restarts, its in-memory history buffers are lost, so cached terminal
 * states with offsets from the old server instance become invalid.
 */

let currentServerId: string | undefined;

/**
 * Set the current server ID.
 * Called during app initialization after fetching from the server.
 */
export function setServerId(serverId: string): void {
  currentServerId = serverId;
}

/**
 * Get the current server ID.
 * Returns undefined if not yet initialized.
 */
export function getServerId(): string | undefined {
  return currentServerId;
}
