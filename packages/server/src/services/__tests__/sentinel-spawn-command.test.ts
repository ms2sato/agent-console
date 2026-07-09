import { describe, it, expect } from 'bun:test';
import {
  buildDirectSentinelShellCommand,
  buildElevatedSentinelCommand,
} from '../sentinel-spawn-command.js';

const SENTINEL = '__AGENT_CONSOLE_READY_abc123';

describe('buildDirectSentinelShellCommand', () => {
  it('prepends the unset prefix ahead of the login-shell exec', () => {
    const cmd = buildDirectSentinelShellCommand(SENTINEL, 'unset FOO BAR; ');
    expect(cmd.startsWith('unset FOO BAR; ')).toBe(true);
  });

  it('execs a login shell that echoes the sentinel then execs an interactive shell', () => {
    const cmd = buildDirectSentinelShellCommand(SENTINEL, '');
    expect(cmd).toContain('exec $SHELL -l -c');
    expect(cmd).toContain(`echo ${SENTINEL}; exec $SHELL`);
    // Byte-exact shape the worker-manager sentinel gate relies on.
    expect(cmd).toBe(`exec $SHELL -l -c 'echo ${SENTINEL}; exec $SHELL'`);
  });

  it('does not export env vars across the boundary (unset prefix only, no export/PATH)', () => {
    const cmd = buildDirectSentinelShellCommand(SENTINEL, 'unset FOO; ');
    // The direct path relies on the inherited process env, never re-exporting;
    // an `export`/`PATH=` in this command would signal an accidental leak.
    expect(cmd).not.toContain('export');
    expect(cmd).not.toContain('PATH=');
  });

  it('emits no unset text when the prefix is empty', () => {
    const cmd = buildDirectSentinelShellCommand(SENTINEL, '');
    expect(cmd).not.toContain('unset');
    expect(cmd.startsWith('exec $SHELL -l -c')).toBe(true);
  });
});

describe('buildElevatedSentinelCommand', () => {
  it('is exactly "echo <sentinel>; exec $SHELL"', () => {
    const cmd = buildElevatedSentinelCommand(SENTINEL);
    expect(cmd).toBe(`echo ${SENTINEL}; exec $SHELL`);
  });

  it('does not add the -l login flag (login init is the elevation chain\'s responsibility)', () => {
    const cmd = buildElevatedSentinelCommand(SENTINEL);
    expect(cmd).not.toContain('-l');
  });
});
