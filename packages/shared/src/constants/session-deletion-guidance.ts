/**
 * Shared wording and id convention for "a session needs attention" records
 * (unreadable or orphaned rows -- see `SessionAttentionRecorder` on the
 * server and, later, the client card that reads the same sentences). Plain
 * constants only: no schema, no type crossing the wire boundary, so this
 * file must never be imported from `packages/shared/src/schemas/**`.
 */

export const SESSION_ATTENTION_TODO_ID_PREFIX = 'session-attention:';

export function sessionAttentionTodoId(sessionId: string): string {
  return `${SESSION_ATTENTION_TODO_ID_PREFIX}${sessionId}`;
}

export const SESSION_DELETE_REMOVES_HEADING = 'Deleting this session removes:';

export const SESSION_DELETE_REMOVES: readonly string[] = [
  "The session's record in agent-console, including its workers.",
  'The saved terminal and agent output of this session.',
  "The session's memo.",
  'Open TODO items that belong to this session (they are marked withdrawn).',
];

export const SESSION_DELETE_KEEPS_HEADING = 'Deleting this session keeps:';

export const SESSION_DELETE_KEEPS: readonly string[] = [
  'The working directory and every file in it.',
  'The git branch and its commits.',
  "The repository's registration in agent-console.",
];

export const SESSION_DELETE_UNRESOLVED_NOTE =
  'If agent-console cannot determine where this session\'s data is stored, the saved output and the memo are left on disk.';
