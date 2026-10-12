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
] as const;

export type SessionClaimingTool = (typeof SESSION_CLAIMING_TOOLS)[number];
