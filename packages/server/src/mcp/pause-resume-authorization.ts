/**
 * Pure relationship + self check for `pause_session` / `resume_session`
 * (rules 3 and 4 of the pause/resume authorization contract; see
 * `docs/design/session-pause-resume.md`'s MCP Surface subsection).
 *
 * Rule 1 (ownership, via `checkCallerOwnsSession`) and rule 2 (the caller
 * session exists in memory) are checked separately by each tool's handler,
 * before this function runs. This function covers only:
 *
 * - Rule 4: a session may never pause or resume itself.
 * - Rule 3: the caller must be the target's parent session, OR the target
 *   must be a worktree session and the caller must be one of its
 *   repository's designated Orchestrator sessions.
 *
 * Self is checked unconditionally FIRST: a session must never pause/resume
 * itself even when it would otherwise pass the relationship check (e.g. it
 * is its own repository's designated Orchestrator).
 */

export interface PauseResumeTarget {
  id: string;
  parentSessionId?: string;
  createdBy?: string;
  type: 'worktree' | 'quick';
  repositoryId?: string;
}

/**
 * Returns `null` when the call is authorized, or an error message otherwise.
 */
export function checkPauseResumeRelationship(
  target: PauseResumeTarget,
  fromSessionId: string,
  orchestratorSessionIds: readonly string[],
): string | null {
  if (target.id === fromSessionId) {
    return `A session cannot pause or resume itself (session: ${fromSessionId})`;
  }

  const isParent = target.parentSessionId === fromSessionId;
  const isDesignatedOrchestrator =
    target.type === 'worktree' && orchestratorSessionIds.includes(fromSessionId);

  if (!isParent && !isDesignatedOrchestrator) {
    return (
      `Session ${fromSessionId} may not pause or resume session ${target.id}: it is neither the target's ` +
      `parent session nor a designated Orchestrator of the target's repository`
    );
  }

  return null;
}
