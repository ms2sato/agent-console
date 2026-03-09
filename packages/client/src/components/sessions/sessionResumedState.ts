/**
 * Pure logic for determining the page state after a session is resumed.
 *
 * Extracted from SessionPage to enable direct unit testing without React component rendering.
 * When a session is resumed (e.g., by another tab/client), the client must decide whether
 * to transition to 'active' or 'disconnected' based on whether PTY workers are actually running.
 */
import type { Session } from '@agent-console/shared';

/**
 * Page state produced by session resume resolution.
 * Uses a discriminated union matching a subset of SessionPage's PageState.
 */
export type ResumedPageState =
  | { type: 'active'; session: Session }
  | { type: 'disconnected'; session: Session };

/**
 * Determine the correct page state after a session is resumed.
 *
 * Resuming from the DB does not automatically start PTY workers. If the session's
 * activationState is 'hibernated' or its status is not 'active', the workers are
 * not running and Terminal should not try to connect -- so we transition to 'disconnected'.
 */
export function resolveResumedState(session: Session): ResumedPageState {
  if (session.activationState === 'hibernated' || session.status !== 'active') {
    return { type: 'disconnected', session };
  }
  return { type: 'active', session };
}
