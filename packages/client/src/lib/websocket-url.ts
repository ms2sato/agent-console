/**
 * WebSocket URL utilities.
 * Centralizes WebSocket URL construction to ensure consistent protocol handling.
 */

/**
 * Get the WebSocket protocol based on the current page protocol.
 * Returns 'wss:' for HTTPS pages, 'ws:' for HTTP pages.
 */
export function getWsProtocol(): 'wss:' | 'ws:' {
  return window.location.protocol === 'https:' ? 'wss:' : 'ws:';
}

/**
 * Build a WebSocket URL for the app-level connection.
 */
export function getAppWsUrl(): string {
  return `${getWsProtocol()}//${window.location.host}/ws/app`;
}

/**
 * Build a WebSocket URL for a worker connection.
 */
export function getWorkerWsUrl(sessionId: string, workerId: string): string {
  return `${getWsProtocol()}//${window.location.host}/ws/session/${sessionId}/worker/${workerId}`;
}
