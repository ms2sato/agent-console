import type { CloneErrorCode, CloneJobError } from '@agent-console/shared';

/**
 * Human-readable messages for each classified clone failure code.
 * Excludes `unknown`, which is rendered using the server's raw
 * `error.message` as a fallback.
 */
const CLONE_ERROR_MESSAGES: Record<Exclude<CloneErrorCode, 'unknown'>, string> = {
  auth_failed:
    'Authentication failed. Check your SSH key or HTTPS credentials and try again.',
  network_error:
    'Network error reaching the remote. Check the URL and your connection.',
  repo_not_found:
    'Repository not found at the given URL.',
  permission_denied:
    'Permission denied. Check that you are a member of the agent-console-users group and that the source-repos directory is writable.',
  name_conflict:
    'A repository with this name already exists. Choose a different name or unregister the existing one.',
  timeout:
    'Clone took too long and was cancelled. The remote may be slow or the repository may be very large.',
  validation_error:
    'The request was rejected as invalid. Verify the URL and the optional name.',
};

/**
 * Translate a classified Clone Job error into the user-facing string
 * shown inside the "Clone from URL" tab. Falls back to the server's
 * `error.message` when the code is `unknown` (or unrecognized).
 */
export function formatCloneJobError(error: CloneJobError): string {
  if (error.code === 'unknown') {
    return error.message || 'An unknown error occurred while cloning.';
  }
  const message = CLONE_ERROR_MESSAGES[error.code];
  // Defensive: a server adding a new code we do not yet know about
  // should still produce something useful instead of an empty string.
  return message ?? error.message ?? 'An unknown error occurred while cloning.';
}
