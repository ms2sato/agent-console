import { describe, it, expect } from 'bun:test';
import {
  buildElevationArgs,
  buildExportString,
  shellEscape,
} from '../elevation-args.js';

describe('shellEscape', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes via the POSIX `\'\\\'\'` pattern', () => {
    expect(shellEscape("it's")).toBe(`'it'\\''s'`);
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''");
  });
});

describe('buildExportString', () => {
  it('joins KEY=value pairs with spaces, quoting values', () => {
    expect(buildExportString({ A: '1', B: '2' })).toBe(`A='1' B='2'`);
  });

  it('skips keys that do not match POSIX env var naming rules', () => {
    // '1BAD' starts with digit -> rejected; 'BAD-KEY' contains dash -> rejected
    expect(buildExportString({ '1BAD': 'v', 'BAD-KEY': 'v', GOOD: 'v' })).toBe(`GOOD='v'`);
  });

  it('returns empty string for empty input', () => {
    expect(buildExportString({})).toBe('');
  });
});

describe('buildElevationArgs', () => {
  it('produces the expected sudo argv shape for a terminal worker', () => {
    const { argv, innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/home/alice/repo',
      additionalEnvVars: {},
      command: 'exec $SHELL -l',
    });
    expect(argv[0]).toBe('-u');
    expect(argv[1]).toBe('alice');
    expect(argv[2]).toBe('--preserve-env=FORCE_COLOR');
    expect(argv[3]).toBe('-i');
    expect(argv[4]).toBe('sh');
    expect(argv[5]).toBe('-c');
    expect(argv[6]).toBe(innerCommand);
  });

  it('injects the color trinity (TERM, COLORTERM, FORCE_COLOR) in the inner command', () => {
    const { innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/',
      additionalEnvVars: {},
      command: 'env',
    });
    expect(innerCommand).toContain("TERM='xterm-256color'");
    expect(innerCommand).toContain("COLORTERM='truecolor'");
    expect(innerCommand).toContain("FORCE_COLOR='3'");
  });

  // Issue #866: the elevated user's natural login env must NOT be overridden
  // by env from this helper. The helper's input only contains color env +
  // per-spawn additional + agent context; PATH / HOME / USER / SHELL /
  // LOGNAME never come from this helper. These negative assertions lock that
  // contract.
  it('does NOT export PATH / HOME / USER / SHELL / LOGNAME with empty additionalEnvVars (Issue #866)', () => {
    const { innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/',
      additionalEnvVars: {},
      command: 'env',
    });
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bHOME=/);
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bUSER=/);
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bSHELL=/);
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bLOGNAME=/);
  });

  // CodeRabbit Security/Major finding on PR #867: a malicious or careless
  // caller may put privilege-boundary-protected vars in additionalEnvVars
  // (PATH=evil:bin, LD_PRELOAD=/tmp/malicious.so, ...). The helper must
  // strip them silently before exporting. This test actively seeds those
  // vars to prove the strip works (the prior negative test only checked
  // they are not added; this one checks they are removed if supplied).
  it('strips PRIVILEGE_BOUNDARY_PROTECTED vars seeded in additionalEnvVars (CodeRabbit PR #867)', () => {
    const { innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/',
      additionalEnvVars: {
        PATH: '/evil/bin:/usr/bin',
        HOME: '/tmp/fake',
        USER: 'mallory',
        LOGNAME: 'mallory',
        SHELL: '/bin/false',
        LD_PRELOAD: '/tmp/malicious.so',
        LD_LIBRARY_PATH: '/tmp/lib',
        DYLD_INSERT_LIBRARIES: '/tmp/macos.dylib',
        SAFE_REPO_VAR: 'this-should-pass-through',
      },
      command: 'env',
    });
    // Forbidden keys are stripped (do not appear in the export list at all).
    expect(innerCommand).not.toMatch(/\bPATH=/);
    expect(innerCommand).not.toMatch(/\bHOME=/);
    expect(innerCommand).not.toMatch(/\bUSER=/);
    expect(innerCommand).not.toMatch(/\bLOGNAME=/);
    expect(innerCommand).not.toMatch(/\bSHELL=/);
    expect(innerCommand).not.toMatch(/\bLD_PRELOAD=/);
    expect(innerCommand).not.toMatch(/\bLD_LIBRARY_PATH=/);
    expect(innerCommand).not.toMatch(/\bDYLD_INSERT_LIBRARIES=/);
    // Non-protected vars pass through normally.
    expect(innerCommand).toContain("SAFE_REPO_VAR='this-should-pass-through'");
  });

  it('allows additionalEnvVars to override the color env (per-spawn wins)', () => {
    // Operator can force a specific TERM if a repo's template demands it.
    const { innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/',
      additionalEnvVars: { TERM: 'screen-256color' },
      command: 'env',
    });
    expect(innerCommand).toContain("TERM='screen-256color'");
    expect(innerCommand).not.toContain("TERM='xterm-256color'");
  });

  it('includes AGENT_CONSOLE_* vars only when agentConsoleVars is provided', () => {
    const { innerCommand } = buildElevationArgs({
      username: 'alice',
      cwd: '/',
      additionalEnvVars: {},
      agentConsoleVars: {
        AGENT_CONSOLE_BASE_URL: 'http://localhost:8080',
        AGENT_CONSOLE_SESSION_ID: 'session-1',
      },
      command: 'claude',
    });
    expect(innerCommand).toContain("AGENT_CONSOLE_BASE_URL='http://localhost:8080'");
    expect(innerCommand).toContain("AGENT_CONSOLE_SESSION_ID='session-1'");
  });

  it('produces a single-quoted inner command that survives sh -c parsing', () => {
    // The cwd may contain spaces, single quotes, etc. shellEscape must keep
    // the whole inner command argv-safe.
    const { argv } = buildElevationArgs({
      username: 'alice',
      cwd: "/home/alice/dir with spaces/it's",
      additionalEnvVars: {},
      command: 'env',
    });
    // The 7th argv element is the inner command; verifying its first segment
    // (the `cd` part) round-trips the awkward path correctly.
    expect(argv[6]).toContain("cd '/home/alice/dir with spaces/it'\\''s'");
  });

  it('uses just `cd && command` when no env vars are passed', () => {
    // This branch is never hit by buildElevationArgs (color env always present),
    // but the contract permits an empty exports string returning the
    // no-export form. Verify via buildExportString returning '' for empty input.
    expect(buildExportString({})).toBe('');
  });

  // ===========================================================================
  // Issue #918: conditional SSH_AUTH_SOCK fallback for delegated sessions
  // ===========================================================================
  //
  // When `sshAuthSockFallback` is provided, the inner shell command must
  // conditionally export SSH_AUTH_SOCK from that path IF AND ONLY IF the
  // elevated user's login init did not already set it AND the socket file
  // exists. The snippet is placed BEFORE the explicit `export <COMBINED>`
  // line so that an explicit `SSH_AUTH_SOCK` in `additionalEnvVars` still
  // wins (user-explicit overrides fallback).
  //
  // For consumers without this requirement (single-user mode, EnterWorktree,
  // resume), the input field is omitted and the inner command must contain
  // zero SSH_AUTH_SOCK-related shell code (back-compatibility lock).
  describe('Issue #918: sshAuthSockFallback', () => {
    it('does NOT include any SSH_AUTH_SOCK-related snippet when sshAuthSockFallback is undefined', () => {
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: {},
        command: 'env',
      });
      // No conditional, no export referencing SSH_AUTH_SOCK at all.
      expect(innerCommand).not.toMatch(/SSH_AUTH_SOCK/);
      expect(innerCommand).not.toMatch(/\.1password/);
    });

    it('injects the conditional fallback snippet when sshAuthSockFallback is provided', () => {
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: {},
        sshAuthSockFallback: '/home/alice/.1password/agent.sock',
        command: 'env',
      });
      // The snippet checks: SSH_AUTH_SOCK unset AND socket file exists, then export.
      expect(innerCommand).toContain('[ -z "$SSH_AUTH_SOCK" ]');
      expect(innerCommand).toContain("[ -S '/home/alice/.1password/agent.sock' ]");
      expect(innerCommand).toContain("export SSH_AUTH_SOCK='/home/alice/.1password/agent.sock'");
      // Wrapped in `if ... fi`.
      expect(innerCommand).toMatch(/\bif\b/);
      expect(innerCommand).toMatch(/\bfi\b/);
    });

    it('places the fallback snippet BEFORE the explicit `export` of combined env (so explicit SSH_AUTH_SOCK in additionalEnvVars wins)', () => {
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: {},
        sshAuthSockFallback: '/home/alice/.1password/agent.sock',
        command: 'env',
      });
      // The snippet's `if` must appear earlier in the string than the
      // explicit `export TERM=` (color env always sets TERM).
      const ifIdx = innerCommand.indexOf('if [ -z "$SSH_AUTH_SOCK"');
      const exportTermIdx = innerCommand.indexOf("export TERM='xterm-256color'");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(exportTermIdx).toBeGreaterThanOrEqual(0);
      expect(ifIdx).toBeLessThan(exportTermIdx);
    });

    it('shellEscapes paths containing single quotes', () => {
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home',
        additionalEnvVars: {},
        sshAuthSockFallback: "/home/it's user/.1password/agent.sock",
        command: 'env',
      });
      // Single quotes in path are escaped via the POSIX `'\''` pattern.
      expect(innerCommand).toContain("[ -S '/home/it'\\''s user/.1password/agent.sock' ]");
      expect(innerCommand).toContain(
        "export SSH_AUTH_SOCK='/home/it'\\''s user/.1password/agent.sock'",
      );
    });

    it('does NOT change the outer sudo argv shape when sshAuthSockFallback is provided', () => {
      const { argv } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: {},
        sshAuthSockFallback: '/home/alice/.1password/agent.sock',
        command: 'env',
      });
      // argv[0..5] are stable: -u, alice, --preserve-env=FORCE_COLOR, -i, sh, -c
      expect(argv[0]).toBe('-u');
      expect(argv[1]).toBe('alice');
      expect(argv[2]).toBe('--preserve-env=FORCE_COLOR');
      expect(argv[3]).toBe('-i');
      expect(argv[4]).toBe('sh');
      expect(argv[5]).toBe('-c');
      // argv[6] is the inner command string -- everything that changed is inside it.
      expect(typeof argv[6]).toBe('string');
    });

    it('preserves an explicit SSH_AUTH_SOCK in additionalEnvVars by exporting AFTER the conditional fallback', () => {
      // The conditional fallback must not override an explicit user value:
      // seed additionalEnvVars.SSH_AUTH_SOCK and verify the explicit value
      // is exported AFTER the fallback block, so the explicit export wins.
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: { SSH_AUTH_SOCK: '/tmp/explicit.sock' },
        sshAuthSockFallback: '/home/alice/.1password/agent.sock',
        command: 'env',
      });
      const ifIdx = innerCommand.indexOf('if [ -z "$SSH_AUTH_SOCK"');
      const explicitSockIdx = innerCommand.indexOf("SSH_AUTH_SOCK='/tmp/explicit.sock'");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(explicitSockIdx).toBeGreaterThanOrEqual(0);
      // Explicit export comes AFTER the conditional, so it wins on collision.
      expect(ifIdx).toBeLessThan(explicitSockIdx);
    });

    it('terminates the if-block so the following `&& export` chain is not aborted', () => {
      // The conditional must be valid POSIX shell that returns exit 0
      // regardless of the branch taken, so the subsequent `&&` chain runs.
      // We assert structurally: a `; then ... ; fi` (or equivalent) ends
      // with `fi` followed by ` && export` (the combined-export segment).
      const { innerCommand } = buildElevationArgs({
        username: 'alice',
        cwd: '/home/alice',
        additionalEnvVars: {},
        sshAuthSockFallback: '/home/alice/.1password/agent.sock',
        command: 'env',
      });
      // Look for the sequence: ...fi && export TERM=...
      expect(innerCommand).toMatch(/fi\s+&&\s+export\s+TERM=/);
    });
  });
});
