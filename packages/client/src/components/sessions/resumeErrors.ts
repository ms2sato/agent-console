/**
 * Helpers for classifying errors thrown from the resume-session API.
 *
 * When the server detects an orphaned session (invalid data path metadata),
 * it responds with HTTP 409 and `body.code === 'session_orphaned'`. The
 * `ApiError` thrown by `handleApiError` preserves both fields so callers
 * can branch without string-matching error messages.
 */
import { ApiError } from '../../lib/api'

/**
 * Returns true when the error represents a server rejection because the
 * session is orphaned. The server indicates this with HTTP 409 and
 * `code === 'session_orphaned'` in the response body.
 */
export function isSessionOrphanedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'session_orphaned'
}
