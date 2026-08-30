#!/bin/bash
# PreToolUse hook for Claude Code. Denies a fixed set of agent-console MCP
# tools when the call originates from inside a subagent (a Task/Agent-tool
# fork, general-purpose, or any custom subagent type) rather than the
# primary agent.
#
# Why this hook exists (Issue #1476): a subagent spawned via the Agent
# tool inherits its parent's MCP bearer token and the
# AGENT_CONSOLE_SESSION_ID / AGENT_CONSOLE_WORKER_ID environment
# variables verbatim. No server-side / transport-level signal in this
# repo's own MCP server (packages/server/src/mcp/mcp-server.ts) tells
# apart "the parent called this" from "a subagent the parent spawned
# called this, claiming to be the parent" -- the bearer token, the
# session id, and the shared StreamableHTTPTransport are identical
# either way. A subagent can therefore call any agent-console MCP tool
# and have the effect attributed to the PARENT session's identity: a
# message delivered to another session, a memo written into the UI, a
# review annotation pushed live, a delegated worktree created under the
# parent's ownership, and so on.
#
# This hook closes that gap at the one layer that DOES carry a
# distinguishing signal: Claude Code's own PreToolUse hook payload. See
# the fail-open block below, next to the branch that reads agent_type,
# for the premise this depends on and how it was verified.
#
# Relationship to enforce-permissions.sh: deliberately a SEPARATE file,
# not an extension of that script. The two scripts have OPPOSITE
# fail-behavior (that one fails closed on ambiguity; this one fails open,
# see below) and cover entirely different tool surfaces (native
# Bash/Read/Write/Edit vs this MCP server's own tool names). Keeping
# them separate makes the differing fail-open/fail-closed policies
# structurally visible without extra prose, and stops a future edit to
# one script's fail-policy from silently bleeding into the other. Do NOT
# copy enforce-permissions.sh's fail_closed() helper into this file --
# that would silently invert this hook's accepted risk posture (see the
# R4 note below).
#
# I/O contract: same shape as enforce-permissions.sh (see that file for
# the stdin/stdout/exit-code contract). The one deliberate difference:
# on ANY ambiguity (jq missing, empty stdin, malformed JSON, missing
# tool_name), this hook exits 0 / allow -- never exit 2 / fail-closed.

set -u

# -----------------------------------------------------------------------------
# Block-set (Issue #1476) -- the SINGLE source of truth for the decision.
# -----------------------------------------------------------------------------
# The settings.json matcher wiring this hook is deliberately scoped
# broadly (this MCP server's whole tool namespace), so any current or
# future tool at least reaches this script. The script itself, not the
# matcher regex, decides allow/deny -- this avoids a "matcher regex and
# script's internal list must be kept in sync" maintenance trap, and is
# what lets a unit test invoke this script directly (bypassing
# settings.json entirely) and still observe the correct decision.
#
# Every tool below shares one property (refined by the Architect's R2
# ruling from an earlier, too-broad "effect attributed to the session's
# identity" reading -- under that broader reading, kill_process /
# update_repository / restart_all_agents would also qualify, which
# converges to "block all mutations" and contradicts this mechanism's
# actual purpose): under the calling session's identity, the tool emits
# AUTHORED CONTENT reaching a human or another session -- a message
# delivered "from" the session, content displayed in the session's own
# UI, a live push framed as the session's own review judgement, or a new
# resource whose ownership/attribution is inherited from the session. A
# subagent invoking any of these with its parent's inherited session id
# produces output indistinguishable, to the recipient, from the parent
# having authored it itself.
#
# Design principle (state it explicitly so it isn't re-derived wrong):
# an authorization hole is something to be closed, not something to be
# designed around. Whether a tool ALSO has a separate, pre-existing
# authorization-scope gap (e.g. missing checkCallerOwnsSession) is NOT a
# reason to either include or exclude it here -- identity-attribution
# (this hook's concern) and authorization-scope (a server-side gate's
# concern) are independent axes. Conflating them was exactly the mistake
# the R2 ruling corrected; do not reintroduce it.
#
#   mcp__agent-console__send_session_message
#     The incident's own vector. Delivers a message to another
#     session/human, attributed as "from" the (inherited) parent session.
#   mcp__agent-console__write_memo
#     Writes a Markdown memo displayed in the session's own UI, persists
#     across conversations; appears to a human as the session's own note.
#   mcp__agent-console__write_review_annotations
#     Pushes review annotations to the connected client live via
#     WebSocket, attributed to sessionId (and optionally sourceSessionId).
#   mcp__agent-console__delegate_to_worktree
#     Resolves parentSessionId/parentWorkerId from the caller's own
#     AGENT_CONSOLE_SESSION_ID/AGENT_CONSOLE_WORKER_ID env vars, which a
#     subagent inherits identically to its parent. The new delegated
#     session's ownership (createdBy) and its default report-back
#     behaviour are both attributed to the inherited parent identity.
#   mcp__agent-console__create_html_artifact
#     Creates a persistent, per-user-attributed HTML artifact
#     (userId = session.createdBy, sourceSessionId = sessionId) with a
#     shareable URL. Same "new content attributed to the session's
#     owner" shape as write_memo, just delivered as a URL instead of
#     inline UI text.
#   mcp__agent-console__create_bookmark
#     Creates a persistent, per-user-attributed bookmark visible in the
#     session sidebar (userId = session.createdBy). Same shape as
#     create_html_artifact.
#
# Deliberately NOT included, despite superficially similar names --
# an omission, not an oversight:
#   mcp__agent-console__write_process_response
#     Writes to a specific already-spawned process's STDIN via
#     processId, a handle the caller must already hold. Scoped by
#     process handle, not by session/user identity; produces no artifact
#     that appears "authored by session X" to a human or another session.
#   mcp__agent-console__delete_html_artifact
#   mcp__agent-console__delete_bookmark
#     Destructive removal of an already-existing, already-attributed
#     resource. No NEW attribution is fabricated by these calls; this is
#     an authorization-scope concern (already gated server-side by
#     checkCallerOwnsSession), not an identity-attribution/impersonation
#     one. A general destructive-action audit is explicitly out of scope
#     for Issue #1476.
#   mcp__agent-console__clear_review_annotations
#     Clearing/erasing is not authoring content, so it does not fit the
#     R2-refined property above -- "a decision to erase" is not the same
#     hazard as "content injected under someone else's name". Its actual
#     residual risk decomposes into two axes, tracked separately, NOT by
#     this hook: (1) cross-session destruction -- any caller can pass an
#     arbitrary sessionId/workerId and clear another session's
#     annotations (confirmed in code: this tool's handler calls no
#     checkCallerOwnsSession, unlike the delete_html_artifact /
#     delete_bookmark pair above); this is a pre-existing
#     authorization-scope gap, independent of subagent-vs-parent
#     identity, now tracked as Issue #1486; (2) same-session drift -- a
#     subagent could still clear its OWN inherited parent session's
#     annotations, which an ownership check can't close (the subagent
#     legitimately "owns" the parent session it inherited from). This is
#     the same residual shape as the create_conditional_wakeup entry
#     below -- a subagent affecting its own parent's future state, not a
#     cross-boundary misattribution to a THIRD PARTY -- and is likewise
#     recorded as an accepted non-goal, not a gap.
#   mcp__agent-console__create_conditional_wakeup
#     Excluded because the wakeup notification fires TOWARD THE SAME
#     SESSION (a self-directed future reminder), not toward a third
#     party. Issue #1476's hazard is cross-boundary misattribution (a
#     third party mistaking a subagent's words for the parent's); a
#     subagent scheduling its own parent's future wakeup is a different,
#     lighter class of confusion (same-session drift, no third party
#     deceived). Explicitly recorded as a non-goal, not an oversight.
#   mcp__agent-console__run_process
#     Excluded on a futility argument, not just the property test: a
#     subagent has Bash access regardless, so blocking run_process closes
#     one of many open doors to arbitrary side effects and provides no
#     real containment. This mechanism is NOT "contain a malicious agent"
#     (Issue #1476 itself states no malice is involved or assumed) -- it
#     is "prevent non-malicious drift from producing a misattributed
#     first-class channel to a human or another session". Blocking
#     arbitrary code execution paths is explicitly out of scope; blocking
#     the small set of channels that deliver a session's own "words"
#     under its name is the actual scope.
BLOCKED_TOOLS=(
  'mcp__agent-console__send_session_message'
  'mcp__agent-console__write_memo'
  'mcp__agent-console__write_review_annotations'
  'mcp__agent-console__delegate_to_worktree'
  'mcp__agent-console__create_html_artifact'
  'mcp__agent-console__create_bookmark'
)

is_blocked_tool() {
  local name="$1" t
  for t in "${BLOCKED_TOOLS[@]}"; do
    [ "$t" = "$name" ] && return 0
  done
  return 1
}

# -----------------------------------------------------------------------------
# Fail-open on any ambiguity (deliberate deviation from enforce-permissions.sh)
# -----------------------------------------------------------------------------
# jq missing, empty stdin, malformed JSON, or a missing tool_name are all
# treated as "cannot determine -> allow", NOT "cannot determine -> deny"
# the way enforce-permissions.sh's fail_closed() does. See the block
# below (next to the agent_type check) for why fail-open was accepted
# for THIS hook specifically.
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ -n "$TOOL_NAME" ] || exit 0

is_blocked_tool "$TOOL_NAME" || exit 0

AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null) || exit 0

# -----------------------------------------------------------------------------
# The fail-open decision itself (R3 / R4, Issue #1476)
# -----------------------------------------------------------------------------
# Absence of agent_type here means "primary agent, allow". This is a
# DELIBERATE, RECORDED exception to this repo's normal discipline, which
# treats an absent/unobserved signal with suspicion (see
# .claude/rules/workflow.md, "Inference vs Verification"). There is no
# viable fail-closed alternative for this hook: there is no POSITIVE
# signal for "this is the primary agent" to gate on, only the absence of
# agent_type -- and fail-closed on absence would break the product's
# main path outright, since every ordinary primary-agent tool call has
# no agent_type at all. If you are reading this because you are
# "fixing" the fail-open branch below back to fail-closed, read PR
# #<FILL-IN-PR-NUMBER> / Issue #1476 first: the failure mode when the
# premise below breaks is "reverts to the pre-fix world" (subagents can
# call these tools again) -- bounded degradation, not a new hazard, and
# that bound is exactly why fail-open was accepted here.
#
# (a) THE PREMISE, AND WHAT WAS MEASURED.
#     This hook's correctness depends on Claude Code's PreToolUse hook
#     payload including agent_id/agent_type if and only if the hook
#     fires inside a subagent call. Measured 2026-08-30 across n=2
#     subagent types (fork, general-purpose) via direct payload capture
#     -- see (b) for the technique. This is also DOCUMENTED upstream,
#     not merely observed -- see (c).
#
# (b) THE ZERO-SIDE-EFFECT RE-VERIFICATION TECHNIQUE (reusable).
#     1. Create an UNCOMMITTED .claude/settings.local.json (gitignored)
#        with a PreToolUse hook, matcher ".*", pointing at a throwaway
#        always-allow script.
#     2. That script appends (">>", NOT ">" -- overwrite mode
#        self-poisons if a later Read of the dump file also triggers
#        this same hook) the raw JSON stdin payload to a dump file, plus
#        a "===NEXT===" separator line, then unconditionally exit 0.
#     3. Trigger a subagent tool call (Agent tool, any subagent_type).
#     4. Inspect the dump file for agent_id / agent_type.
#     5. Delete both the dump script and settings.local.json when done.
#     Re-run this after any Claude Code major-version upgrade, or if
#     this repo's own hook payload contract changes.
#
# (c) DOCUMENTED, NOT MERELY OBSERVED.
#     agent_id/agent_type are documented at
#     https://code.claude.com/docs/en/hooks (confirmed 2026-08-30;
#     verbatim quote in this PR's description) as present specifically
#     "when the hook fires inside a subagent call". This is a contract,
#     not an incidentally-observed implementation detail -- part of why
#     fail-open was accepted as a bounded risk rather than a fragile
#     one. It could still change in a future Claude Code version, hence
#     (b)'s re-verification trigger above.
if [ -z "$AGENT_TYPE" ]; then
  exit 0
fi

REASON="Direct use of ${TOOL_NAME} from a subagent is denied (Issue #1476): its effect would be attributed to the parent session's identity, and the recipient cannot tell a subagent's call apart from the parent's own. Report your findings back to your parent agent/conversation turn instead -- the primary session is the channel for messaging, memos, review annotations, delegation, and artifacts; a subagent's job is to return results, not to act as the session directly."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
