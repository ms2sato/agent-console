/**
 * Generate a unique task ID with fallback for non-secure contexts.
 *
 * crypto.randomUUID() requires a secure context (HTTPS or localhost).
 * When the app is accessed via IP address over HTTP, we fall back to
 * a timestamp + random hex string.
 */
export function generateTaskId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
