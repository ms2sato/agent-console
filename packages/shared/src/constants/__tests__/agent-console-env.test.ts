import { describe, it, expect } from 'bun:test';
import {
  AGENT_CONSOLE_ENV_PREFIX,
  AGENT_CONSOLE_IDENTITY_ENV_KEYS,
  isAgentConsoleIdentityEnvKey,
} from '../agent-console-env.js';

describe('AGENT_CONSOLE_IDENTITY_ENV_KEYS', () => {
  it('is exactly the six identity keys a terminal agent receives at PTY spawn, and nothing secret', () => {
    // Pinned as a literal list: the server's buildAgentConsoleEnv and the
    // embedded-agent Bash tool's allowlist both read this constant, so a key
    // added here is forwarded on BOTH sides. Reach measured: adding
    // AGENT_CONSOLE_MCP_TOKEN_FILE to the constant fails this test (and the
    // secret-hygiene test below).
    expect([...AGENT_CONSOLE_IDENTITY_ENV_KEYS]).toEqual([
      'AGENT_CONSOLE_BASE_URL',
      'AGENT_CONSOLE_SESSION_ID',
      'AGENT_CONSOLE_WORKER_ID',
      'AGENT_CONSOLE_REPOSITORY_ID',
      'AGENT_CONSOLE_PARENT_SESSION_ID',
      'AGENT_CONSOLE_PARENT_WORKER_ID',
    ]);
  });

  it('every key carries the shared prefix', () => {
    for (const key of AGENT_CONSOLE_IDENTITY_ENV_KEYS) {
      expect(key.startsWith(AGENT_CONSOLE_ENV_PREFIX)).toBe(true);
    }
  });

  it('never names a secret-carrying variable (token, token file, home, provider key)', () => {
    for (const forbidden of [
      'AGENT_CONSOLE_MCP_TOKEN',
      'AGENT_CONSOLE_MCP_TOKEN_FILE',
      'AGENT_CONSOLE_HOME',
      'AGENT_CONSOLE_PROVIDER_KEY',
    ]) {
      expect(isAgentConsoleIdentityEnvKey(forbidden)).toBe(false);
    }
  });
});

describe('isAgentConsoleIdentityEnvKey', () => {
  it('is exact membership, not a prefix test', () => {
    expect(isAgentConsoleIdentityEnvKey('AGENT_CONSOLE_SESSION_ID')).toBe(true);
    expect(isAgentConsoleIdentityEnvKey('AGENT_CONSOLE_SESSION_ID_X')).toBe(false);
    expect(isAgentConsoleIdentityEnvKey('agent_console_session_id')).toBe(false);
    expect(isAgentConsoleIdentityEnvKey('')).toBe(false);
  });
});
