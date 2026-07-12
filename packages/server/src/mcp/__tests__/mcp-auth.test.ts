import { describe, it, expect } from 'bun:test';
import {
  McpTokenRegistry,
  resolveMcpAuthMode,
  resolveCallerFromAuthHeader,
  checkCallerOwnsSession,
  type McpCallerIdentity,
  type McpAuthLogger,
} from '../mcp-auth.js';

/**
 * Recording logger used to assert warn side-effects without depending on
 * Pino. Captures the payload/message pairs the code under test emits.
 */
function makeRecordingLogger(): {
  logger: McpAuthLogger;
  calls: Array<{ payload: unknown; message: string }>;
} {
  const calls: Array<{ payload: unknown; message: string }> = [];
  return {
    calls,
    logger: {
      warn: (payload: unknown, message: string) => {
        calls.push({ payload, message });
      },
    },
  };
}

const identityA: McpCallerIdentity = {
  sessionId: 'session-a',
  workerId: 'worker-a',
  userId: 'user-a',
};

describe('McpTokenRegistry', () => {
  it('mint returns a 64-char lowercase hex token', () => {
    const registry = new McpTokenRegistry();
    const token = registry.mint(identityA);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two mints for the same identity produce distinct tokens', () => {
    const registry = new McpTokenRegistry();
    const t1 = registry.mint(identityA);
    const t2 = registry.mint(identityA);
    expect(t1).not.toBe(t2);
  });

  it('verify returns the identity for a minted token', () => {
    const registry = new McpTokenRegistry();
    const token = registry.mint(identityA);
    expect(registry.verify(token)).toEqual(identityA);
  });

  it('verify returns null for an unknown token', () => {
    const registry = new McpTokenRegistry();
    expect(registry.verify('unknown')).toBeNull();
  });

  it('verify returns null for an empty token', () => {
    const registry = new McpTokenRegistry();
    expect(registry.verify('')).toBeNull();
  });

  it('revokeByWorker revokes ALL tokens for that worker only', () => {
    const registry = new McpTokenRegistry();
    const a1 = registry.mint({ sessionId: 's', workerId: 'worker-a', userId: 'u' });
    const a2 = registry.mint({ sessionId: 's', workerId: 'worker-a', userId: 'u' });
    const b1 = registry.mint({ sessionId: 's', workerId: 'worker-b', userId: 'u' });

    registry.revokeByWorker('worker-a');

    expect(registry.verify(a1)).toBeNull();
    expect(registry.verify(a2)).toBeNull();
    expect(registry.verify(b1)).not.toBeNull();
  });

  it('revokeByWorker on an unknown worker is a no-op', () => {
    const registry = new McpTokenRegistry();
    const token = registry.mint(identityA);
    registry.revokeByWorker('nobody');
    expect(registry.verify(token)).toEqual(identityA);
  });
});

describe('resolveMcpAuthMode', () => {
  it('passes explicit values through', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      expect(resolveMcpAuthMode(mode)).toBe(mode);
    }
  });

  it('defaults to warn when unset and AUTH_MODE is unset', () => {
    expect(resolveMcpAuthMode(undefined, undefined)).toBe('warn');
  });

  it('defaults to warn when unset and AUTH_MODE=none (single-user)', () => {
    expect(resolveMcpAuthMode(undefined, 'none')).toBe('warn');
  });

  it('defaults to enforce when unset and AUTH_MODE=multi-user (Phase 4 flip)', () => {
    expect(resolveMcpAuthMode(undefined, 'multi-user')).toBe('enforce');
  });

  it('an explicit AGENT_CONSOLE_MCP_AUTH=warn overrides the multi-user enforce default', () => {
    expect(resolveMcpAuthMode('warn', 'multi-user')).toBe('warn');
  });

  it('treats an empty string as unset (warn)', () => {
    expect(resolveMcpAuthMode('')).toBe('warn');
  });

  it('treats a whitespace-only string as unset (warn)', () => {
    expect(resolveMcpAuthMode('  ')).toBe('warn');
  });

  it('treats an empty string as unset (warn) in single-user mode', () => {
    expect(resolveMcpAuthMode('', 'none')).toBe('warn');
  });

  it('treats a whitespace-only string as unset (enforce in multi-user mode)', () => {
    expect(resolveMcpAuthMode('  ', 'multi-user')).toBe('enforce');
  });

  it('throws on an invalid non-empty value', () => {
    expect(() => resolveMcpAuthMode('yes')).toThrow(
      /Invalid AGENT_CONSOLE_MCP_AUTH/,
    );
  });
});

describe('resolveCallerFromAuthHeader', () => {
  it('returns null when no header is present', () => {
    const registry = new McpTokenRegistry();
    expect(resolveCallerFromAuthHeader(undefined, registry)).toBeNull();
  });

  it('returns null and warns for a malformed header', () => {
    const registry = new McpTokenRegistry();
    const { logger, calls } = makeRecordingLogger();
    expect(resolveCallerFromAuthHeader('Basic abc', registry, { logger })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('Malformed Authorization header');
  });

  it('returns null and warns without leaking the token for an unknown bearer token', () => {
    const registry = new McpTokenRegistry();
    const { logger, calls } = makeRecordingLogger();
    const unknownToken = 'deadbeef'.repeat(8);
    expect(
      resolveCallerFromAuthHeader(`Bearer ${unknownToken}`, registry, { logger }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('did not verify');
    // The token must never appear in the logged payload.
    expect(JSON.stringify(calls[0].payload)).not.toContain(unknownToken);
  });

  it('returns the identity for a minted bearer token', () => {
    const registry = new McpTokenRegistry();
    const token = registry.mint(identityA);
    expect(resolveCallerFromAuthHeader(`Bearer ${token}`, registry)).toEqual(identityA);
  });

  it('accepts a lowercase bearer scheme', () => {
    const registry = new McpTokenRegistry();
    const token = registry.mint(identityA);
    expect(resolveCallerFromAuthHeader(`bearer ${token}`, registry)).toEqual(identityA);
  });
});

describe('checkCallerOwnsSession', () => {
  const claimed = { sessionId: 'session-a', createdBy: 'user-a' };
  const ctx = { toolName: 'run_process' };

  it('caller=null + off → null, no warn', () => {
    const { logger, calls } = makeRecordingLogger();
    expect(checkCallerOwnsSession(null, claimed, 'off', ctx, { logger })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('caller=null + warn → null, warns once', () => {
    const { logger, calls } = makeRecordingLogger();
    expect(checkCallerOwnsSession(null, claimed, 'warn', ctx, { logger })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('AGENT_CONSOLE_MCP_AUTH=warn');
  });

  it('caller=null + enforce → error', () => {
    const result = checkCallerOwnsSession(null, claimed, 'enforce', ctx);
    expect(result?.error).toContain('MCP authentication required');
  });

  it('caller present + claimed=null → null for all modes', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      expect(checkCallerOwnsSession(identityA, null, mode, ctx)).toBeNull();
    }
  });

  it('caller present + createdBy === userId → null for all modes', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      expect(
        checkCallerOwnsSession(identityA, { sessionId: 'session-a', createdBy: 'user-a' }, mode, ctx),
      ).toBeNull();
    }
  });

  it('caller present + createdBy differs → error in ALL modes including off', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const result = checkCallerOwnsSession(
        identityA,
        { sessionId: 'session-a', createdBy: 'someone-else' },
        mode,
        ctx,
      );
      expect(result?.error).toContain('identity mismatch');
    }
  });

  it('caller present + createdBy undefined → error (strict fail-closed)', () => {
    const result = checkCallerOwnsSession(
      identityA,
      { sessionId: 'session-a', createdBy: undefined },
      'off',
      ctx,
    );
    expect(result?.error).toContain('identity mismatch');
  });
});
