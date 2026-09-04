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
  const FILE = '/home/agentconsole/.bun/bin/bun';
  // Ancestor chain of FILE, nearest-to-root order:
  //   /home/agentconsole/.bun/bin
  //   /home/agentconsole/.bun
  //   /home/agentconsole
  //   /home
  //   /
  const OPEN_ANCESTORS: Record<string, number> = {
    '/home/agentconsole/.bun/bin': 0o755,
    '/home/agentconsole/.bun': 0o755,
    '/home/agentconsole': 0o755,
    '/home': 0o755,
    '/': 0o755,
  };

  function fakeIo(modeByPath: Record<string, number>, statThrowsFor?: Set<string>) {
    return {
      realpath: async (p: string) => p,
      stat: async (p: string) => {
        if (statThrowsFor?.has(p)) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        const mode = modeByPath[p];
        if (mode === undefined) {
          throw new Error(`fakeIo: no mode configured for ${p}`);
        }
        return { mode };
      },
    };
  }

  it('is true when every ancestor and the file itself are other-executable', async () => {
    const result = await isOtherExecutable(FILE, fakeIo({ ...OPEN_ANCESTORS, [FILE]: 0o755 }));
    expect(result).toBe(true);
    // reach: flipping the file's `(mode & 0o001) === 0` guard to always-true
    // (i.e. always reporting blocked) makes this fail, since it would no
    // longer report `true` for a fully-open chain.
  });

  it('is blocked at the file itself when its own mode has no other-execute bit (0o750)', async () => {
    const result = await isOtherExecutable(FILE, fakeIo({ ...OPEN_ANCESTORS, [FILE]: 0o750 }));
    expect(result).toEqual({ executable: false, blockedAt: FILE, kind: 'file', mode: 0o750 });
  });

  it('is blocked at the file itself when its own mode is other-readable but not other-executable (0o744)', async () => {
    const result = await isOtherExecutable(FILE, fakeIo({ ...OPEN_ANCESTORS, [FILE]: 0o744 }));
    expect(result).toEqual({ executable: false, blockedAt: FILE, kind: 'file', mode: 0o744 });
  });

  it('is blocked at a mid-chain ancestor directory (0o750), even though the file itself is 0o755', async () => {
    const modeByPath = { ...OPEN_ANCESTORS, [FILE]: 0o755, '/home/agentconsole': 0o750 };
    const result = await isOtherExecutable(FILE, fakeIo(modeByPath));
    expect(result).toEqual({
      executable: false,
      blockedAt: '/home/agentconsole',
      kind: 'directory',
      mode: 0o750,
    });
    // reach: flipping the directory-loop's `(dirStat.mode & 0o001) === 0`
    // guard to always-false (never reporting a blocked ancestor) makes this
    // fail -- it would fall through to statting the file and return `true`
    // instead of the blocked-directory shape.
  });

  it('reports the FIRST blocking ancestor walking from the file outward, not a farther one', async () => {
    // Both '/home/agentconsole/.bun' (nearer) and '/home' (farther) are
    // blocked; the nearer one is the one that actually stops traversal, so
    // it must be the one reported.
    const modeByPath = {
      ...OPEN_ANCESTORS,
      [FILE]: 0o755,
      '/home/agentconsole/.bun': 0o750,
      '/home': 0o750,
    };
    const result = await isOtherExecutable(FILE, fakeIo(modeByPath));
    expect(result).toEqual({
      executable: false,
      blockedAt: '/home/agentconsole/.bun',
      kind: 'directory',
      mode: 0o750,
    });
  });

  it('is "unknown" when io.stat throws for an ancestor directory (EACCES)', async () => {
    const modeByPath = { ...OPEN_ANCESTORS, [FILE]: 0o755 };
    const result = await isOtherExecutable(
      FILE,
      fakeIo(modeByPath, new Set(['/home/agentconsole'])),
    );
    expect(result).toBe('unknown');
  });

  it('is "unknown" for a bare name, and never calls io.stat or io.realpath', async () => {
    let statCalled = false;
    let realpathCalled = false;
    const result = await isOtherExecutable('bun', {
      realpath: async (p: string) => {
        realpathCalled = true;
        return p;
      },
      stat: async () => {
        statCalled = true;
        return { mode: 0o755 };
      },
    });
    expect(result).toBe('unknown');
    expect(statCalled).toBe(false);
    expect(realpathCalled).toBe(false);
  });

  it('is "unknown" when io.realpath throws (ENOENT)', async () => {
    const result = await isOtherExecutable(FILE, {
      realpath: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      stat: async () => ({ mode: 0o755 }),
    });
    expect(result).toBe('unknown');
  });
});

describe('assessEmbeddedAgentBunPath', () => {
  const selfExe = '/proc/self/exe';
  const configured = '/usr/local/bin/bun';
  // Single-segment ancestor chain for a shallow configured path so the
  // happy-path / file-blocked fixtures below stay simple: the only
  // ancestors of '/usr/local/bin/bun' are '/usr/local/bin', '/usr/local',
  // '/usr', and '/'.
  const OPEN_ANCESTORS: Record<string, number> = {
    '/usr/local/bin': 0o755,
    '/usr/local': 0o755,
    '/usr': 0o755,
    '/': 0o755,
  };

  it('same identity + other-executable true -> 0 warnings (happy path)', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async () => '/usr/local/bun/1.3.5/bin/bun',
        stat: async (p) => ({ mode: { ...OPEN_ANCESTORS, '/usr/local/bun/1.3.5/bin/bun': 0o755 }[p] ?? 0o755 }),
      },
    });
    expect(result.identity).toBe('same');
    expect(result.otherExecutable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('different identity + other-executable true -> 1 warning', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
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

  it('same identity + other-executable blocked at the file itself -> 1 warning naming "file", the path, and the mode', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async () => '/usr/local/bun/1.3.5/bin/bun',
        stat: async (p) =>
          p === '/usr/local/bun/1.3.5/bin/bun' ? { mode: 0o750 } : { mode: OPEN_ANCESTORS[p] ?? 0o755 },
      },
    });
    expect(result.identity).toBe('same');
    expect(result.otherExecutable).toEqual({
      executable: false,
      blockedAt: '/usr/local/bun/1.3.5/bin/bun',
      kind: 'file',
      mode: 0o750,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not executable by other users');
    expect(result.warnings[0]).toContain(configured);
  });

  it('different identity + other-executable blocked at the file itself -> 2 warnings', async () => {
    const resolvedConfigured = '/opt/bun-b/bin/bun';
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async (p) => (p === selfExe ? '/opt/bun-a/bin/bun' : resolvedConfigured),
        // Only the file itself is blocked (0o750); every ancestor
        // ('/opt/bun-b/bin', '/opt/bun-b', '/opt', '/') stays open (0o755),
        // so the block is attributable to the FILE, matching this test's name.
        stat: async (p) => ({ mode: p === resolvedConfigured ? 0o750 : 0o755 }),
      },
    });
    expect(result.identity).toBe('different');
    expect(result.otherExecutable).toEqual({
      executable: false,
      blockedAt: resolvedConfigured,
      kind: 'file',
      mode: 0o750,
    });
    expect(result.warnings).toHaveLength(2);
  });

  it('bare name -> 1 warning (unresolvable identity, unknown other-executable)', async () => {
    const bareConfigured = 'bun';
    const result = await assessEmbeddedAgentBunPath({
      configured: bareConfigured,
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
    expect(result.warnings[0]).toContain(bareConfigured);
    expect(result.warnings[0]).toContain('setup-multiuser-for-ubuntu.sh');
  });

  it('every warning in the different+file-blocked case names the env var, the configured path, and the setup script', async () => {
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

  it('an ancestor directory blocked (0o750 mid-chain) -> 1 warning naming "directory", the blocking ancestor path, and its mode', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async () => configured, // resolves to itself, no symlink hop
        stat: async (p) => ({ mode: p === '/usr/local' ? 0o750 : (OPEN_ANCESTORS[p] ?? 0o755) }),
      },
    });
    expect(result.otherExecutable).toEqual({
      executable: false,
      blockedAt: '/usr/local',
      kind: 'directory',
      mode: 0o750,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('directory');
    expect(result.warnings[0]).toContain('/usr/local');
    expect(result.warnings[0]).toContain('0750');
    // reach: removing this branch's guard (`typeof otherExecutable ===
    // 'object' && otherExecutable.executable === false`) so it never fires
    // for a directory-kind block makes this fail (warnings drops to 0).
  });

  // Real `fs.Stats.mode` (as returned by an actual `fs.stat()` call) carries
  // file-type bits alongside the permission bits -- `S_IFDIR = 0o040000` for
  // a directory, `S_IFREG = 0o100000` for a regular file. Every OTHER
  // fixture in this file uses a bare `{ mode: 0o750 }` fake, which can never
  // exercise the unmasked-mode bug because it never carries type bits in
  // the first place. These two tests deliberately mimic the real shape a
  // REAL `fs.stat()` call returns (the real-boot verification step that
  // caught this) so a future refactor can't silently reintroduce it.
  it('masks real fs.Stats.mode type bits (S_IFDIR) for an ancestor-directory block -> mode is 0o750, not 0o040750', async () => {
    const REAL_DIR_MODE = 0o750 | 0o040000; // 0o040750, as fs.Stats.mode really looks for a 0o750 directory
    const io = {
      realpath: async () => configured, // identity 'same', isolates this to the otherExecutable side
      stat: async (p: string) => ({ mode: p === '/usr/local' ? REAL_DIR_MODE : (OPEN_ANCESTORS[p] ?? 0o755) }),
    };
    const otherExecutable = await isOtherExecutable(configured, io);
    expect(otherExecutable).toEqual({
      executable: false,
      blockedAt: '/usr/local',
      kind: 'directory',
      mode: 0o750, // masked -- NOT 0o040750
    });

    const result = await assessEmbeddedAgentBunPath({ configured, selfExe, io });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('0750');
    expect(result.warnings[0]).not.toContain('40750');
    // reach: removing the `& 0o7777` mask on isOtherExecutable's
    // directory-block return makes both assertions above fail -- `mode`
    // comes back as 0o040750, and the warning text reads "mode 40750"
    // instead of "mode 0750" (see mutation-reach observation in the PR
    // report).
  });

  it('masks real fs.Stats.mode type bits (S_IFREG) for a file block -> mode is 0o750, not 0o100750', async () => {
    const REAL_FILE_MODE = 0o750 | 0o100000; // 0o100750, as fs.Stats.mode really looks for a 0o750 regular file
    const io = {
      realpath: async () => configured,
      stat: async (p: string) =>
        p === configured ? { mode: REAL_FILE_MODE } : { mode: OPEN_ANCESTORS[p] ?? 0o755 },
    };
    const otherExecutable = await isOtherExecutable(configured, io);
    expect(otherExecutable).toEqual({
      executable: false,
      blockedAt: configured,
      kind: 'file',
      mode: 0o750, // masked -- NOT 0o100750
    });

    const result = await assessEmbeddedAgentBunPath({ configured, selfExe, io });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('0750');
    expect(result.warnings[0]).not.toContain('100750');
    // reach: removing the mask on isOtherExecutable's file-block return
    // makes both assertions above fail -- `mode` comes back as 0o100750,
    // and the warning text reads "mode 100750" instead of "mode 0750".
  });

  it('an absolute path whose realpath throws (ENOENT) -> exactly 1 "could not read" warning naming the error code', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        realpath: async (p) => {
          if (p === configured) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return p;
        },
        stat: async () => ({ mode: 0o755 }),
      },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Could not read EMBEDDED_AGENT_BUN_PATH');
    expect(result.warnings[0]).toContain(configured);
    expect(result.warnings[0]).toContain('ENOENT');
  });

  it('an absolute path whose realpath succeeds but an ancestor stat throws (EACCES) -> exactly 1 "could not read" warning, not 2', async () => {
    const result = await assessEmbeddedAgentBunPath({
      configured,
      selfExe,
      io: {
        // Make identity resolve to 'same' (selfExe canonicalizes to the same
        // string as `configured`) so the case under test is isolated to the
        // otherExecutable side: only the ancestor stat throws.
        realpath: async (p) => (p === selfExe ? configured : p),
        stat: async (p) => {
          if (p === '/usr/local') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return { mode: OPEN_ANCESTORS[p] ?? 0o755 };
        },
      },
    });
    // Confirms the early-return short-circuits BEFORE the (here, inert
    // because identity is 'same') other branches can also push warnings.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Could not read EMBEDDED_AGENT_BUN_PATH');
    expect(result.warnings[0]).toContain(configured);
    expect(result.warnings[0]).toContain('EACCES');
    // reach: deleting the early-return `if (!isBareName && (...)) { ... return ... }`
    // block entirely makes this fail -- since identity is 'same' and
    // otherExecutable is 'unknown' (a string, not the blocked-object shape),
    // neither of the fallback branches fires, so `warnings` becomes `[]`
    // (length 0) instead of the expected 1, and the content assertions on
    // "Could not read" never even run against real output.
  });
});
