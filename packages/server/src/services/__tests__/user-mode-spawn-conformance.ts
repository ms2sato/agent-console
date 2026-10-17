/**
 * Shared conformance assertions for the agent login-shell sentinel contract:
 * given an agent spawn request, the shell command a UserMode implementation
 * produces must echo the request's sentinel before handing over to an
 * interactive login shell, and must never run the agent command itself (the
 * worker-manager injects it after the sentinel line).
 *
 * Not a test file: each UserMode spawn path registers one row by calling
 * `describeAgentSpawnConformance` from its own test file, so a new spawn path
 * inherits the same assertions by adding one call.
 *
 * Empty-sentinel guard: every row goes through `spawnWithSentinel`, which
 * asserts `sentinel.length > 0` before the row's spawn runs, so an empty
 * sentinel can never satisfy an assertion vacuously (`''.split('')` and
 * `indexOf('echo ')` would otherwise pass for the wrong reasons). A dedicated
 * `it` proves the guard itself rejects an empty sentinel.
 */
import { describe, it, expect } from 'bun:test';
import type { AgentPtySpawnRequest } from '../user-mode.js';

const CONFORMANCE_SENTINEL = '__AGENT_CONSOLE_READY_conformance';

function makeRequest(sentinel: string): AgentPtySpawnRequest {
  return {
    type: 'agent',
    username: 'conformance-user',
    cwd: '/workspace/project',
    additionalEnvVars: {},
    cols: 80,
    rows: 24,
    command: 'claude --conformance-command',
    agentConsoleContext: {
      baseUrl: 'http://localhost:3457',
      sessionId: 'sess-conformance',
      workerId: 'wkr-conformance',
    },
    sentinel,
  };
}

function assertSentinelNonEmpty(request: AgentPtySpawnRequest): void {
  expect(request.sentinel.length).toBeGreaterThan(0);
}

function spawnWithSentinel(
  spawnShell: (request: AgentPtySpawnRequest) => string,
  request: AgentPtySpawnRequest,
): string {
  assertSentinelNonEmpty(request);
  return spawnShell(request);
}

export function describeAgentSpawnConformance(
  label: string,
  spawnShell: (request: AgentPtySpawnRequest) => string,
): void {
  describe(`agent spawn sentinel conformance: ${label}`, () => {
    it('rejects an empty sentinel loudly instead of passing vacuously', () => {
      const request = makeRequest('');
      expect(() => spawnWithSentinel(spawnShell, request)).toThrow();
    });

    it('emits the sentinel exactly once', () => {
      const request = makeRequest(CONFORMANCE_SENTINEL);
      const shell = spawnWithSentinel(spawnShell, request);
      expect(shell.split(request.sentinel)).toHaveLength(2);
    });

    it('echoes the sentinel before exec-ing the interactive shell', () => {
      // The direct shape is `exec $SHELL -l -c 'echo S; exec $SHELL'`: the outer
      // login-shell exec precedes the echo, so the interactive shell is the LAST exec.
      const request = makeRequest(CONFORMANCE_SENTINEL);
      const shell = spawnWithSentinel(spawnShell, request);
      const echoIndex = shell.indexOf(`echo ${request.sentinel}`);
      const execIndex = shell.lastIndexOf('exec $SHELL');
      expect(echoIndex).toBeGreaterThanOrEqual(0);
      expect(echoIndex).toBeLessThan(execIndex);
    });

    it('does not spawn the agent command directly', () => {
      const request = makeRequest(CONFORMANCE_SENTINEL);
      const shell = spawnWithSentinel(spawnShell, request);
      expect(shell).not.toContain(request.command);
    });

    it('produces a non-empty command that hands over to a login shell', () => {
      const request = makeRequest(CONFORMANCE_SENTINEL);
      const shell = spawnWithSentinel(spawnShell, request);
      expect(shell.length).toBeGreaterThan(0);
      expect(shell).toContain('exec $SHELL');
    });
  });
}
