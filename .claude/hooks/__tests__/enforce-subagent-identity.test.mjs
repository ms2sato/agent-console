import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Mutation-reach notes (workflow.md "A check's existence is not its
// detection power" / testing.md polarity discipline). Kept here, next to
// the cases, rather than only in the PR body:
//
//   - "blocked tool + agent_type present -> deny" (describe block below)
//     fails if the `is_blocked_tool` check, or the `agent_type` presence
//     check, is dropped from the hook script.
//   - "blocked tool + agent_type ABSENT -> allow" fails if the fail-open
//     branch is removed (i.e. if agent_type absence were treated as
//     deny instead of allow).
//   - "malformed/missing input -> allow" is the R4 polarity pin: it
//     fails if enforce-permissions.sh's fail_closed()-shaped exit 2
//     behavior were copy-pasted into this hook by mistake (this test
//     asserts exit 0, not exit 2, on every ambiguous-input shape).
//   - "non-blocked tool + agent_type present -> allow" fails if the
//     block-set check were dropped and the hook denied on agent_type
//     presence alone, regardless of tool_name.
//   - the per-tool block-set cases pin the R2 sweep decision itself: each
//     fails if that specific tool were removed from (or never added to)
//     BLOCKED_TOOLS, and the per-tool exclusion cases fail if a tool
//     that should stay excluded were added to it by mistake.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '..', 'enforce-subagent-identity.sh');

function runHook(input) {
  const result = spawnSync('bash', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function decision(stdout) {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecision ?? null;
}

function reason(stdout) {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecisionReason ?? null;
}

function subagentEvent(toolName, agentType) {
  const event = { tool_name: toolName, tool_input: {} };
  if (agentType !== undefined) {
    event.agent_type = agentType;
    event.agent_id = 'agent-under-test';
  }
  return event;
}

const BLOCKED_TOOLS = [
  'mcp__agent-console__send_session_message',
  'mcp__agent-console__write_memo',
  'mcp__agent-console__write_review_annotations',
  'mcp__agent-console__delegate_to_worktree',
  'mcp__agent-console__create_html_artifact',
  'mcp__agent-console__create_bookmark',
];

const EXCLUDED_TOOLS = [
  'mcp__agent-console__write_process_response',
  'mcp__agent-console__delete_html_artifact',
  'mcp__agent-console__delete_bookmark',
  'mcp__agent-console__clear_review_annotations',
  'mcp__agent-console__list_sessions',
];

describe('enforce-subagent-identity: 4 required AC cases', () => {
  it('case 1: blocked tool_name + agent_type present -> deny, actionable reason', () => {
    const r = runHook(subagentEvent('mcp__agent-console__send_session_message', 'fork'));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBe('deny');
    const reasonText = reason(r.stdout);
    expect(reasonText).toMatch(/send_session_message/);
    expect(reasonText).toMatch(/parent/i);
    expect(reasonText).toMatch(/report/i);
  });

  it('case 2: blocked tool_name + agent_type ABSENT -> allow', () => {
    const r = runHook(subagentEvent('mcp__agent-console__send_session_message'));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  it('case 3: non-blocked tool_name + agent_type present -> allow', () => {
    const r = runHook(subagentEvent('mcp__agent-console__list_sessions', 'fork'));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  describe('case 4: malformed/missing input -> allow (fail-open pin, NOT fail-closed exit 2)', () => {
    it('empty stdin -> allow', () => {
      const r = runHook('');
      expect(r.exitCode).toBe(0);
      expect(decision(r.stdout)).toBeNull();
    });

    it('malformed JSON -> allow', () => {
      const r = runHook('not json {{');
      expect(r.exitCode).toBe(0);
      expect(decision(r.stdout)).toBeNull();
    });

    it('missing tool_name -> allow', () => {
      const r = runHook({ agent_type: 'fork' });
      expect(r.exitCode).toBe(0);
      expect(decision(r.stdout)).toBeNull();
    });
  });
});

describe('enforce-subagent-identity: block-set sweep (Issue #1476 R2), all included tools', () => {
  it.each(BLOCKED_TOOLS.map((t) => [t]))('%s + agent_type present -> deny', (toolName) => {
    const r = runHook(subagentEvent(toolName, 'general-purpose'));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(new RegExp(toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it.each(BLOCKED_TOOLS.map((t) => [t]))('%s + agent_type absent -> allow', (toolName) => {
    const r = runHook(subagentEvent(toolName));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });
});

describe('enforce-subagent-identity: deliberately excluded tools stay allowed', () => {
  it.each(EXCLUDED_TOOLS.map((t) => [t]))('%s + agent_type present -> allow', (toolName) => {
    const r = runHook(subagentEvent(toolName, 'fork'));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });
});

describe('enforce-subagent-identity: agent_type variety', () => {
  it.each([['fork'], ['general-purpose'], ['backend-specialist'], ['Explore']])(
    'agent_type=%s on a blocked tool -> deny',
    (agentType) => {
      const r = runHook(subagentEvent('mcp__agent-console__write_memo', agentType));
      expect(decision(r.stdout)).toBe('deny');
    },
  );
});
