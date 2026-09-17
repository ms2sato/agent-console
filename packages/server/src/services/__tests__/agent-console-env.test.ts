import { describe, it, expect } from 'bun:test';
import { AGENT_CONSOLE_IDENTITY_ENV_KEYS } from '@agent-console/shared';
import { buildAgentConsoleEnv, type AgentConsoleContext } from '../agent-console-env.js';

// Issue #1694 (C2): the single writer of the AgentConsoleContext ->
// AGENT_CONSOLE_* mapping. Reach measured per test in its own comment.
describe('buildAgentConsoleEnv', () => {
  const full: AgentConsoleContext = {
    baseUrl: 'http://localhost:3457',
    sessionId: 'sess-1',
    workerId: 'work-1',
    repositoryId: 'repo-1',
    parentSessionId: 'parent-sess',
    parentWorkerId: 'parent-work',
  };

  it('maps every context field to its identity key (all six present)', () => {
    // Reach: dropping any one of the six spread/literal lines fails here
    // (measured on REPOSITORY_ID and PARENT_WORKER_ID); swapping the
    // SESSION_ID / WORKER_ID values fails here.
    expect(buildAgentConsoleEnv(full)).toEqual({
      AGENT_CONSOLE_BASE_URL: 'http://localhost:3457',
      AGENT_CONSOLE_SESSION_ID: 'sess-1',
      AGENT_CONSOLE_WORKER_ID: 'work-1',
      AGENT_CONSOLE_REPOSITORY_ID: 'repo-1',
      AGENT_CONSOLE_PARENT_SESSION_ID: 'parent-sess',
      AGENT_CONSOLE_PARENT_WORKER_ID: 'parent-work',
    });
  });

  it('omits the optional keys entirely (no undefined, no empty string) when the context lacks them', () => {
    // Reach, measured: an unconditional `AGENT_CONSOLE_REPOSITORY_ID:
    // ctx.repositoryId` spread ALONE does NOT fail here -- the copy loop's
    // `value !== undefined` guard catches it (only the empty-string test
    // below fails). Replacing the guarded copy loop with a raw
    // `Object.assign(...)` return that forwards the undefined value fails
    // both this test and the empty-string one. The contract is pinned at
    // the function's output, not at one line -- the loop is the second line
    // of defence, and this test is what makes removing it visible.
    const env = buildAgentConsoleEnv({ baseUrl: 'http://localhost:3457', sessionId: 's', workerId: 'w' });
    expect(env).toEqual({
      AGENT_CONSOLE_BASE_URL: 'http://localhost:3457',
      AGENT_CONSOLE_SESSION_ID: 's',
      AGENT_CONSOLE_WORKER_ID: 'w',
    });
    expect('AGENT_CONSOLE_REPOSITORY_ID' in env).toBe(false);
    expect('AGENT_CONSOLE_PARENT_SESSION_ID' in env).toBe(false);
    expect('AGENT_CONSOLE_PARENT_WORKER_ID' in env).toBe(false);
  });

  it('treats an empty-string optional field as absent (same rule the PTY path always had)', () => {
    const env = buildAgentConsoleEnv({ ...full, repositoryId: '', parentSessionId: '', parentWorkerId: '' });
    expect(Object.keys(env).sort()).toEqual([
      'AGENT_CONSOLE_BASE_URL',
      'AGENT_CONSOLE_SESSION_ID',
      'AGENT_CONSOLE_WORKER_ID',
    ]);
  });

  it('emits only keys from the shared AGENT_CONSOLE_IDENTITY_ENV_KEYS constant (the Bash allowlist would strip anything else)', () => {
    // Reach: adding a seventh key (e.g. AGENT_CONSOLE_MCP_TOKEN_FILE) to the
    // builder's object fails here -- the server mapping and the embedded
    // Bash allowlist read the same constant, so a key outside it is one the
    // child would silently lose.
    const env = buildAgentConsoleEnv(full);
    const identityKeys: readonly string[] = AGENT_CONSOLE_IDENTITY_ENV_KEYS;
    for (const key of Object.keys(env)) {
      expect(identityKeys).toContain(key);
    }
    expect(Object.keys(env).length).toBe(AGENT_CONSOLE_IDENTITY_ENV_KEYS.length);
  });
});
