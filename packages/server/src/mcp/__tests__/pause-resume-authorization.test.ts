/**
 * `checkPauseResumeRelationship` unit tests (Issue #2315): the pure
 * relationship + self check used by the `pause_session` / `resume_session`
 * MCP tools. No server harness needed -- this is a pure function.
 *
 * The tool-level integration tests (authorization wired into `pause_session`
 * / `resume_session`, plus the `includePaused` / paused-branch extensions to
 * `list_sessions` / `get_session_status`) live in the sibling
 * `pause-resume-session.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { checkPauseResumeRelationship, type PauseResumeTarget } from '../pause-resume-authorization.js';

describe('checkPauseResumeRelationship (pure helper)', () => {
  const base: PauseResumeTarget = {
    id: 'target-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    createdBy: 'user-1',
  };

  it('allows the parent', () => {
    const target: PauseResumeTarget = { ...base, parentSessionId: 'parent-1' };
    expect(checkPauseResumeRelationship(target, 'parent-1', [])).toBeNull();
  });

  it("allows a designated Orchestrator of the target's repository", () => {
    const target: PauseResumeTarget = { ...base, parentSessionId: 'someone-else' };
    expect(checkPauseResumeRelationship(target, 'orch-1', ['orch-1'])).toBeNull();
  });

  it('refuses a designated Orchestrator of ANOTHER repository', () => {
    const target: PauseResumeTarget = { ...base, parentSessionId: 'someone-else' };
    // `orchestratorSessionIds` here is the TARGET repository's set -- an
    // orchestrator of a different repository simply never appears in it.
    expect(checkPauseResumeRelationship(target, 'orch-of-another-repo', ['a-different-session'])).not.toBeNull();
  });

  it('refuses an unrelated session', () => {
    const target: PauseResumeTarget = { ...base, parentSessionId: 'parent-1' };
    expect(checkPauseResumeRelationship(target, 'unrelated-session', [])).not.toBeNull();
  });

  it('refuses self, even when self would otherwise pass as its own parent', () => {
    // parentSessionId deliberately equals the caller's own id: this isolates
    // rule 4 (self-refusal) from rule 3 (the relationship check) -- without
    // rule 4, `isParent` would be true and the call would be allowed.
    const target: PauseResumeTarget = { ...base, id: 'self-1', parentSessionId: 'self-1' };
    expect(checkPauseResumeRelationship(target, 'self-1', [])).not.toBeNull();
  });

  it("refuses self even when self is the session's repository's designated Orchestrator", () => {
    const target: PauseResumeTarget = { ...base, id: 'self-1', parentSessionId: 'parent-1' };
    expect(checkPauseResumeRelationship(target, 'self-1', ['self-1'])).not.toBeNull();
  });

  it('refuses a target with no parentSessionId and an empty orchestratorSessionIds', () => {
    const target: PauseResumeTarget = { ...base, parentSessionId: undefined };
    expect(checkPauseResumeRelationship(target, 'anyone', [])).not.toBeNull();
  });

  it('a quick-session target with a matching parent passes the helper (the tool refuses it afterwards as quick)', () => {
    const target: PauseResumeTarget = { id: 'quick-1', type: 'quick', parentSessionId: 'parent-1' };
    expect(checkPauseResumeRelationship(target, 'parent-1', [])).toBeNull();
  });
});
