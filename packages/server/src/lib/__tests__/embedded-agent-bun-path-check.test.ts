import { describe, it, expect } from 'bun:test';
import {
  compareBinaryIdentity,
  isOtherExecutable,
  assessEmbeddedAgentBunPath,
} from '../embedded-agent-bun-path-check.js';

describe('compareBinaryIdentity', () => {
  it('is "same" when both realpaths resolve to the identical string', async () => {
    // Simulate a symlink on one side: the fake realpath canonicalizes both
    // raw inputs to the same underlying path, even though the raw inputs
    // themselves differ.
    const identity = await compareBinaryIdentity('/proc/self/exe', '/usr/local/bin/bun', {
      realpath: async () => '/usr/local/bun/1.3.5/bin/bun',
    });
    expect(identity).toBe('same');
  });

  it('is "different" when the two resolved paths differ', async () => {
    const identity = await compareBinaryIdentity('/proc/self/exe', '/usr/local/bin/bun', {
      realpath: async (p) => (p === '/proc/self/exe' ? '/opt/bun-a/bin/bun' : '/opt/bun-b/bin/bun'),
    });
    expect(identity).toBe('different');
  });

  it('is "unresolvable" for a bare name, and never calls realpath', async () => {
    let callCount = 0;
    const identity = await compareBinaryIdentity('/proc/self/exe', 'bun', {
      realpath: async (p) => {
        callCount++;
        return p;
      },
    });
    expect(identity).toBe('unresolvable');
    expect(callCount).toBe(0);
  });

  it('is "unresolvable" when io.realpath throws for the configured side (ENOENT)', async () => {
    const identity = await compareBinaryIdentity('/proc/self/exe', '/usr/local/bin/bun', {
      realpath: async (p) => {
        if (p === '/usr/local/bin/bun') throw new Error('ENOENT');
        return p;
      },
    });
    expect(identity).toBe('unresolvable');
  });

  it('is "unresolvable" when io.realpath throws for the self-exe side (ENOENT)', async () => {
    const identity = await compareBinaryIdentity('/proc/self/exe', '/usr/local/bin/bun', {
      realpath: async (p) => {
        if (p === '/proc/self/exe') throw new Error('ENOENT');
        return p;
      },
    });
    expect(identity).toBe('unresolvable');
  });
});

describe('isOtherExecutable', () => {
  it('is true for mode 0o755 (other-execute bit set)', async () => {
    const result = await isOtherExecutable('/usr/local/bin/bun', {
      stat: async () => ({ mode: 0o755 }),
    });
    expect(result).toBe(true);
  });

  it('is false for mode 0o750 (no other-execute bit)', async () => {
    const result = await isOtherExecutable('/usr/local/bin/bun', {
      stat: async () => ({ mode: 0o750 }),
    });
    expect(result).toBe(false);
  });

  it('is false for mode 0o744 (other-read but not other-execute)', async () => {
    const result = await isOtherExecutable('/usr/local/bin/bun', {
      stat: async () => ({ mode: 0o744 }),
    });
    expect(result).toBe(false);
  });

  it('is "unknown" for a bare name, and never calls stat', async () => {
    let called = false;
    const result = await isOtherExecutable('bun', {
      stat: async () => {
        called = true;
        return { mode: 0o755 };
      },
    });
    expect(result).toBe('unknown');
    expect(called).toBe(false);
  });

  it('is "unknown" when io.stat throws (ENOENT)', async () => {
    const result = await isOtherExecutable('/usr/local/bin/bun', {
      stat: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(result).toBe('unknown');
  });
});

describe('assessEmbeddedAgentBunPath', () => {
  const selfExe = '/proc/self/exe';

  it('same identity + other-executable true -> 0 warnings (happy path)', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured: '/usr/local/bin/bun',
      selfExe,
      io: {
        realpath: async () => '/usr/local/bun/1.3.5/bin/bun',
        stat: async () => ({ mode: 0o755 }),
      },
    });
    expect(result.identity).toBe('same');
    expect(result.otherExecutable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('different identity + other-executable true -> 1 warning', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured: '/usr/local/bin/bun',
      selfExe,
      io: {
        realpath: async (p) => (p === selfExe ? '/opt/bun-a/bin/bun' : '/opt/bun-b/bin/bun'),
        stat: async () => ({ mode: 0o755 }),
      },
    });
    expect(result.identity).toBe('different');
    expect(result.otherExecutable).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it('same identity + other-executable false -> 1 warning', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured: '/usr/local/bin/bun',
      selfExe,
      io: {
        realpath: async () => '/usr/local/bun/1.3.5/bin/bun',
        stat: async () => ({ mode: 0o750 }),
      },
    });
    expect(result.identity).toBe('same');
    expect(result.otherExecutable).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it('different identity + other-executable false -> 2 warnings', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured: '/usr/local/bin/bun',
      selfExe,
      io: {
        realpath: async (p) => (p === selfExe ? '/opt/bun-a/bin/bun' : '/opt/bun-b/bin/bun'),
        stat: async () => ({ mode: 0o750 }),
      },
    });
    expect(result.identity).toBe('different');
    expect(result.otherExecutable).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  it('bare name -> 1 warning (unresolvable identity, unknown other-executable)', async () => {
    const configured = 'bun';
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async (p) => p,
        stat: async () => ({ mode: 0o755 }),
      },
    });
    expect(result.identity).toBe('unresolvable');
    expect(result.otherExecutable).toBe('unknown');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('EMBEDDED_AGENT_BUN_PATH');
    expect(result.warnings[0]).toContain(configured);
    expect(result.warnings[0]).toContain('setup-multiuser-for-ubuntu.sh');
  });

  it('every warning in the different+false case names the env var, the configured path, and the setup script', async () => {
    const configured = '/usr/local/bin/bun';
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async (p) => (p === selfExe ? '/opt/bun-a/bin/bun' : '/opt/bun-b/bin/bun'),
        stat: async () => ({ mode: 0o750 }),
      },
    });
    for (const warning of result.warnings) {
      expect(warning).toContain('EMBEDDED_AGENT_BUN_PATH');
      expect(warning).toContain(configured);
      expect(warning).toContain('setup-multiuser-for-ubuntu.sh');
    }
  });
});
