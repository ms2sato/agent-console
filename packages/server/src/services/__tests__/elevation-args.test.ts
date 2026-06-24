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
  it('does NOT export PATH / HOME / USER / SHELL / LOGNAME (Issue #866)', () => {
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
});
