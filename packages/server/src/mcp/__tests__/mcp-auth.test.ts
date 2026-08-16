import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  McpTokenRegistry,
  resolveMcpAuthMode,
  resolveCallerFromAuthHeader,
  checkCallerOwnsSession,
  evaluateMcpAuthGate,
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

// Note: `checkCallerOwnsSession` (tested via `evaluateMcpAuthGate` below and
// its own call sites elsewhere) is now referenced by mcp-auth.ts's JSDoc as
// having 6 existing call sites -- `create_html_artifact` (HTML Artifacts
// Phase 1, Issue #1312) is the sixth session-claiming MCP tool.

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
  it('passes explicit off/warn through regardless of AUTH_MODE', () => {
    for (const mode of ['off', 'warn'] as const) {
      expect(resolveMcpAuthMode(mode)).toBe(mode);
    }
  });

  it('defaults to warn when unset and AUTH_MODE is unset', () => {
    expect(resolveMcpAuthMode(undefined, undefined)).toBe('warn');
  });

  it('defaults to warn when unset and AUTH_MODE=none (single-user)', () => {
    expect(resolveMcpAuthMode(undefined, 'none')).toBe('warn');
  });

  it('defaults to warn when unset and AUTH_MODE=multi-user (Sprint 2026-07-16: enforce-by-default deferred, see #1107)', () => {
    expect(resolveMcpAuthMode(undefined, 'multi-user')).toBe('warn');
  });

  it('an explicit AGENT_CONSOLE_MCP_AUTH=enforce opts into enforcement in multi-user mode', () => {
    expect(resolveMcpAuthMode('enforce', 'multi-user')).toBe('enforce');
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

  it('treats a whitespace-only string as unset (warn, even in multi-user mode)', () => {
    expect(resolveMcpAuthMode('  ', 'multi-user')).toBe('warn');
  });

  it('throws on an invalid non-empty value', () => {
    expect(() => resolveMcpAuthMode('yes')).toThrow(
      /Invalid AGENT_CONSOLE_MCP_AUTH/,
    );
  });

  // Ruling 3 (Issue #1269, binding clarification): the contradiction check
  // is scoped to an EXPLICITLY-set AGENT_CONSOLE_MCP_AUTH=enforce only. It
  // must NOT fire for a value arrived at by default resolution (empty/unset),
  // otherwise a future default flip to `enforce` (#1107) would brick every
  // single-user deployment at startup.
  describe('Ruling 3: enforce + non-multi-user is a configuration error', () => {
    it('case (a): explicit enforce + non-multi-user AUTH_MODE -> throws naming both variables', () => {
      expect(() => resolveMcpAuthMode('enforce', 'none')).toThrow(
        /AGENT_CONSOLE_MCP_AUTH.*enforce.*AUTH_MODE|AUTH_MODE.*AGENT_CONSOLE_MCP_AUTH/s,
      );
      expect(() => resolveMcpAuthMode('enforce', 'none')).toThrow(/AGENT_CONSOLE_MCP_AUTH/);
      expect(() => resolveMcpAuthMode('enforce', 'none')).toThrow(/AUTH_MODE/);
    });

    it('case (a): explicit enforce + undefined AUTH_MODE -> throws (undefined is not multi-user)', () => {
      expect(() => resolveMcpAuthMode('enforce', undefined)).toThrow(/AUTH_MODE/);
    });

    it('case (b): explicit enforce + multi-user AUTH_MODE -> accepted', () => {
      expect(resolveMcpAuthMode('enforce', 'multi-user')).toBe('enforce');
    });

    it('case (c): DEFAULTED value (unset) + non-multi-user AUTH_MODE -> accepted as warn, no error', () => {
      expect(() => resolveMcpAuthMode(undefined, 'none')).not.toThrow();
      expect(resolveMcpAuthMode(undefined, 'none')).toBe('warn');
    });

    it('case (c): DEFAULTED value (empty string) + non-multi-user AUTH_MODE -> accepted as warn, no error', () => {
      expect(() => resolveMcpAuthMode('', 'none')).not.toThrow();
      expect(resolveMcpAuthMode('', 'none')).toBe('warn');
    });

    it('case (c): DEFAULTED value (whitespace-only) + non-multi-user AUTH_MODE -> accepted as warn, no error', () => {
      expect(() => resolveMcpAuthMode('  ', 'none')).not.toThrow();
      expect(resolveMcpAuthMode('  ', 'none')).toBe('warn');
    });

    it('explicit off/warn + non-multi-user AUTH_MODE -> accepted (contradiction check is enforce-only)', () => {
      expect(resolveMcpAuthMode('off', 'none')).toBe('off');
      expect(resolveMcpAuthMode('warn', 'none')).toBe('warn');
    });
  });
});

describe('evaluateMcpAuthGate (transport-level authN gate, Issue #1269)', () => {
  it('caller present -> allowed regardless of mode, no warn', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const { logger, calls } = makeRecordingLogger();
      const result = evaluateMcpAuthGate(identityA, mode, { logger });
      expect(result).toEqual({ allowed: true, caller: identityA });
      expect(calls).toHaveLength(0);
    }
  });

  it('caller=null + off -> allowed, no warn', () => {
    const { logger, calls } = makeRecordingLogger();
    expect(evaluateMcpAuthGate(null, 'off', { logger })).toEqual({ allowed: true, caller: null });
    expect(calls).toHaveLength(0);
  });

  it('caller=null + warn -> allowed, warns once', () => {
    const { logger, calls } = makeRecordingLogger();
    expect(evaluateMcpAuthGate(null, 'warn', { logger })).toEqual({ allowed: true, caller: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('AGENT_CONSOLE_MCP_AUTH=warn');
  });

  it('caller=null + enforce -> rejected with a distinct, greppable message naming the mode', () => {
    const result = evaluateMcpAuthGate(null, 'enforce');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toContain('MCP authentication required');
      expect(result.error).toContain('AGENT_CONSOLE_MCP_AUTH=enforce');
    }
  });

  // No-localhost-exception guard (AC requirement): evaluateMcpAuthGate takes
  // ONLY the already-resolved caller identity and the mode -- it has no
  // source-address / header parameter of any kind to key a bypass off of.
  // This test exists to make a future "but it's only localhost" patch fail:
  // spoofing a loopback-shaped signal upstream (e.g. X-Forwarded-For:
  // 127.0.0.1) cannot change `caller`, so a tokenless request is rejected
  // identically under enforce no matter what the caller claims about its
  // network origin.
  it('a tokenless caller is rejected under enforce even when it claims a loopback origin (no localhost bypass exists)', () => {
    // Simulates what a future localhost-exception patch would plausibly key
    // off of: some upstream signal claiming the request originated from
    // 127.0.0.1. evaluateMcpAuthGate has no such parameter, so there is
    // nothing for such a patch to thread through without changing this
    // function's signature -- and this test's assertion would need to be
    // updated (and re-justified) the moment one did.
    const spoofedLoopbackOriginSignal = '127.0.0.1';
    void spoofedLoopbackOriginSignal; // no bypass parameter exists to pass this to
    const result = evaluateMcpAuthGate(null, 'enforce');
    expect(result.allowed).toBe(false);
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
    expect(calls[0].message).toContain('without bearer token');
    expect(calls[0].payload).toEqual({
      toolName: 'run_process',
      claimedSessionId: 'session-a',
    });
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

/**
 * Grep-based containment check for Issue #1293 R1/S4: `McpCallerIdentity`
 * is consumed for authorization only (`checkCallerOwnsSession`); ownership
 * (a session's `createdBy`) must always derive from the parent session,
 * never from the caller's own identity. See `McpCallerIdentity`'s JSDoc in
 * ../mcp-auth.ts for the full rationale. This scans production source for
 * the regression shape a future PR could introduce: assigning
 * `createdBy` directly from a `.userId` field (the caller identity's own
 * field name).
 */
describe('McpCallerIdentity containment (Issue #1293 S4, grep-based)', () => {
  const SERVER_SRC = path.resolve(__dirname, '../..');

  function walkFiles(dir: string, acc: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        if (entry.name === 'node_modules') continue;
        walkFiles(fullPath, acc);
      } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
        acc.push(fullPath);
      }
    }
    return acc;
  }

  it('no production file derives a session createdBy from an MCP caller identity userId', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    // Matches `createdBy: foo.userId` / `createdBy = foo.userId` -- the
    // shape of assigning ownership from the caller identity's own field.
    const pattern = /createdBy\s*[:=]\s*[\w.]*\.userId\b/;

    for (const file of walkFiles(SERVER_SRC)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!pattern.test(content)) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          offenders.push({ file: path.relative(SERVER_SRC, file), line: i + 1, text: lines[i].trim() });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
