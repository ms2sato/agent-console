import { describe, it, expect } from 'bun:test';
import {
  SESSION_ATTENTION_TODO_ID_PREFIX,
  sessionAttentionTodoId,
  SESSION_DELETE_REMOVES_HEADING,
  SESSION_DELETE_REMOVES,
  SESSION_DELETE_KEEPS_HEADING,
  SESSION_DELETE_KEEPS,
  SESSION_DELETE_UNRESOLVED_NOTE,
} from '../session-deletion-guidance.js';

describe('sessionAttentionTodoId', () => {
  it('prefixes the session id with the shared prefix', () => {
    expect(sessionAttentionTodoId('abc')).toBe('session-attention:abc');
  });

  it('uses SESSION_ATTENTION_TODO_ID_PREFIX as its prefix', () => {
    expect(sessionAttentionTodoId('xyz')).toBe(`${SESSION_ATTENTION_TODO_ID_PREFIX}xyz`);
  });
});

describe('session-delete guidance sentences', () => {
  // Pinned verbatim: the server's body-builder and (later) the client card
  // both read these arrays, so a wording change here is a wording change
  // on both sides. Reach measured (M7, see PR body): emptying
  // SESSION_DELETE_KEEPS fails this test.
  it('SESSION_DELETE_REMOVES is exactly the four approved sentences', () => {
    expect(SESSION_DELETE_REMOVES).toEqual([
      "The session's record in agent-console, including its workers.",
      'The saved terminal and agent output of this session.',
      "The session's memo.",
      'Open TODO items that belong to this session (they are marked withdrawn).',
    ]);
  });

  it('SESSION_DELETE_KEEPS is exactly the three approved sentences', () => {
    expect(SESSION_DELETE_KEEPS).toEqual([
      'The working directory and every file in it.',
      'The git branch and its commits.',
      "The repository's registration in agent-console.",
    ]);
  });

  it('SESSION_DELETE_UNRESOLVED_NOTE is the approved sentence', () => {
    expect(SESSION_DELETE_UNRESOLVED_NOTE).toBe(
      'If agent-console cannot determine where this session\'s data is stored, the saved output and the memo are left on disk.',
    );
  });

  it('SESSION_DELETE_REMOVES_HEADING and SESSION_DELETE_KEEPS_HEADING are the approved headings', () => {
    expect(SESSION_DELETE_REMOVES_HEADING).toBe('Deleting this session removes:');
    expect(SESSION_DELETE_KEEPS_HEADING).toBe('Deleting this session keeps:');
  });
});
