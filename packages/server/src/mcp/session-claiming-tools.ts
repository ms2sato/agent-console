/**
 * Single writer of the session-claiming tool set: the MCP tools that accept a
 * caller-supplied `sessionId` and gate it through `checkCallerOwnsSession`.
 *
 * `checkCallerOwnsSession`'s `context.toolName` is typed `SessionClaimingTool`,
 * so a tool that calls the gate with an unlisted name fails `typecheck`. The
 * reverse direction (a listed name whose registration no longer calls the
 * gate, or a gated registration missing from this list) is enforced by
 * `__tests__/session-claiming-tools.test.ts`, which parses `mcp-server.ts`.
 */
export const SESSION_CLAIMING_TOOLS = [
  'set_orchestrator_session',
  'clear_orchestrator_session',
  'send_session_message',
  'delegate_to_worktree',
  'remove_worktree',
  'create_conditional_wakeup',
  'run_process',
  'write_review_annotations',
  'clear_review_annotations',
  'create_html_artifact',
  'delete_html_artifact',
  'create_bookmark',
  'delete_bookmark',
  'set_agent_parameters',
  'set_mcp_server_permission',
  'write_memo',
  'close_session',
] as const;

export type SessionClaimingTool = (typeof SESSION_CLAIMING_TOOLS)[number];

/**
 * MCP tools that take a caller-supplied `sessionId` and neither gate it through
 * `checkCallerOwnsSession` nor resolve it from the caller's own identity. Every
 * entry carries the reason it is exempt, and `__tests__/session-claiming-tools.test.ts`
 * fails when an entry is stale (the block now gates, or no longer takes the
 * param) as well as when a tool takes `sessionId` and is on neither list, so
 * the next ungated tool fails CI instead of being found by a sweep.
 *
 * Entries are reads of team-visible data; a WRITE never belongs here.
 */
export const SESSION_ID_TAKING_UNGATED_TOOLS: ReadonlyArray<{ tool: string; reason: string }> = [
  { tool: 'get_session_status', reason: 'read of data every client already receives in sessions-sync' },
  {
    tool: 'list_timers',
    reason: 'read; lists all timers when sessionId is omitted, so a per-session gate would not restrict the data',
  },
];
