/**
 * Verdict classifiers and exit-code mapping for
 * `scripts/smoke/probe-sdk-mcp-settings-sources.ts` (Issue #1781).
 *
 * The probe is billable and needs a real, authenticated `claude` CLI plus a
 * User-scope `chrome-devtools` server on the host, so its measurement is
 * never run here. Every classifier is pure -- it reads a `system:init`-lite
 * observation, spawn-canary booleans, and canary-word detection handed to it
 * as plain data -- and importing the module runs nothing (the
 * `import.meta.main` guard), so the decision layer is pinned at zero cost
 * and separately from what it decides about.
 *
 * What the pins protect: a deviation from the AC's "hoped" MCP-containment
 * shape must surface as a STOP, never fold into a green line; the
 * managedSettings-vs-settings carrier distinction (dropped vs measured) must
 * not blur into one expectation; an unsettled turn must never read as a
 * negative measurement (per `workflow.md`'s turnSettled discipline); and the
 * exit-code mapping must never claim MEASURED once a run halted on budget.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import {
  ALL_SERVER_NAMES,
  LOCAL_SERVER,
  PROBE_EXIT,
  PROJECT_SERVER_X,
  PROJECT_SERVER_Y,
  USER_SERVER,
  classifyArmASession,
  classifyArmBSession,
  classifyArmCSession,
  classifyArmD,
  classifyArmESession,
  classifyArmFSession,
  classifyArmGSession,
  exitCodeFor,
  expectedForArmA,
  finalExitCode,
  hasMcp,
  initLite,
  matchesLedgerEntry,
  mcpStatus,
  parseLedger,
  parseLedgerLine,
  type ArmALabel,
  type InitLite,
} from '../probe-sdk-mcp-settings-sources.js';

const emptyInit: InitLite = { tools: [], mcpServers: [], agents: [], skills: [] };

function initWith(names: readonly string[], statuses: Record<string, string> = {}, agents: string[] = [], skills: string[] = []): InitLite {
  return {
    tools: [],
    mcpServers: names.map((n) => ({ name: n, status: statuses[n] ?? 'connected' })),
    agents,
    skills,
  };
}

describe('exit codes', () => {
  it('assigns each outcome a distinct code, 0/1/2', () => {
    expect(new Set([PROBE_EXIT.MEASURED, PROBE_EXIT.INCONCLUSIVE, PROBE_EXIT.HARNESS]).size).toBe(3);
  });

  it('exits MEASURED only when every arm concluded, never on an empty set', () => {
    expect(exitCodeFor([{ conclusive: true }, { conclusive: true }])).toBe(PROBE_EXIT.MEASURED);
    expect(exitCodeFor([{ conclusive: true }, { conclusive: false }])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('a halted run can never report MEASURED, even with every pushed verdict conclusive', () => {
    expect(finalExitCode([{ conclusive: true }], true)).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(finalExitCode([{ conclusive: true }], false)).toBe(PROBE_EXIT.MEASURED);
  });

  it('a conclusive STOP-bearing verdict still reads MEASURED (a STOP is a measurement, not a failure)', () => {
    const v = classifyArmASession({
      label: 'A',
      settled: true,
      init: initWith([USER_SERVER, LOCAL_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { [USER_SERVER]: true, [LOCAL_SERVER]: true, [PROJECT_SERVER_X]: true, [PROJECT_SERVER_Y]: true },
      canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
    });
    expect(v.stops.length).toBeGreaterThan(0);
    expect(exitCodeFor([v])).toBe(PROBE_EXIT.MEASURED);
  });
});

describe('initLite / mcpStatus / hasMcp', () => {
  it('returns null for a missing system:init', () => {
    expect(initLite(null)).toBeNull();
  });

  it('defaults agents/skills to empty arrays when the message omits them', () => {
    // `agents` is genuinely optional on SDKSystemMessage; `skills` is not,
    // but a real CLI predating the field (or a malformed message) could
    // still omit it -- both keys are deliberately ABSENT here (not present
    // as `[]`) so `initLite`'s `?? []` fallback is actually exercised for
    // both, rather than merely echoing an already-empty array back
    // (CodeRabbit finding on PR #1782).
    const lite = initLite({
      type: 'system',
      subtype: 'init',
      tools: ['Read'],
      mcp_servers: [],
      apiKeySource: 'none',
      claude_code_version: '0.0.0',
      cwd: '/tmp',
      model: 'x',
      permissionMode: 'bypassPermissions',
      slash_commands: [],
      output_style: 'default',
      plugins: [],
      uuid: 'u' as never,
      session_id: 's',
    } as never);
    expect(lite?.agents).toEqual([]);
    expect(lite?.skills).toEqual([]);
  });

  it('mcpStatus/hasMcp read by exact name', () => {
    const init = initWith(['agent-console', PROJECT_SERVER_X], { [PROJECT_SERVER_X]: 'failed' });
    expect(hasMcp(init, 'agent-console')).toBe(true);
    expect(hasMcp(init, PROJECT_SERVER_Y)).toBe(false);
    expect(mcpStatus(init, PROJECT_SERVER_X)).toBe('failed');
    expect(mcpStatus(init, PROJECT_SERVER_Y)).toBeNull();
  });
});

describe('Arm A -- settingSources: [\'user\'] and controls', () => {
  it('unsettled turn is INCONCLUSIVE, never a negative measurement', () => {
    const v = classifyArmASession({
      label: 'A',
      settled: false,
      init: null,
      spawned: { [USER_SERVER]: false, [LOCAL_SERVER]: false, [PROJECT_SERVER_X]: false, [PROJECT_SERVER_Y]: false },
      canaries: { userClaudeMd: false, projectClaudeMd: false, unscopedRule: false },
    });
    expect(v.conclusive).toBe(false);
  });

  it('A matching the hoped shape is conclusive with no MCP-containment stop', () => {
    const expected = expectedForArmA('A');
    const v = classifyArmASession({
      label: 'A',
      settled: true,
      init: initWith(
        ALL_SERVER_NAMES.filter((n) => expected.spawned[n]),
        {},
        ['probe-user-agent'],
        [],
      ),
      spawned: expected.spawned,
      canaries: expected.canaries,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stops).toEqual([]);
  });

  it('A with X starting anyway (containment broken) raises a STOP', () => {
    const expected = expectedForArmA('A');
    const badSpawn = { ...expected.spawned, [PROJECT_SERVER_X]: true };
    const v = classifyArmASession({
      label: 'A',
      settled: true,
      init: initWith([USER_SERVER, LOCAL_SERVER, PROJECT_SERVER_X]),
      spawned: badSpawn,
      canaries: expected.canaries,
    });
    expect(v.stops.some((s) => s.includes('MCP containment'))).toBe(true);
  });

  it('A2 expects MCP blocked but CLAUDE.md/agent still loaded from the user scope (strict blocks MCP specifically)', () => {
    const expected = expectedForArmA('A2');
    expect(expected.spawned[USER_SERVER]).toBe(false);
    expect(expected.canaries.userClaudeMd).toBe(true);
    expect(expected.agents.user).toBe(true);
    const v = classifyArmASession({
      label: 'A2',
      settled: true,
      init: initWith([], {}, ['probe-user-agent']),
      spawned: expected.spawned,
      canaries: expected.canaries,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stops).toEqual([]);
  });

  it('A- (isolation) expects everything off', () => {
    const expected = expectedForArmA('A-');
    expect(Object.values(expected.spawned).every((b) => b === false)).toBe(true);
    expect(Object.values(expected.canaries).every((b) => b === false)).toBe(true);
  });

  it('A+ (positive control) expects everything on', () => {
    const expected = expectedForArmA('A+');
    expect(Object.values(expected.spawned).every((b) => b === true)).toBe(true);
    expect(Object.values(expected.canaries).every((b) => b === true)).toBe(true);
  });

  it('A3 (addendum) hopes U+L start and X/Y do not, same CLAUDE.md/agent shape as plain A', () => {
    const expected = expectedForArmA('A3');
    expect(expected.spawned[USER_SERVER]).toBe(true);
    expect(expected.spawned[LOCAL_SERVER]).toBe(true);
    expect(expected.spawned[PROJECT_SERVER_X]).toBe(false);
    expect(expected.spawned[PROJECT_SERVER_Y]).toBe(false);
    expect(expected.canaries).toEqual({ userClaudeMd: true, projectClaudeMd: false, unscopedRule: false });
  });

  it('A3 with X leaking in under [\'user\',\'local\'] raises a STOP (the load-bearing question for design II)', () => {
    const expected = expectedForArmA('A3');
    const v = classifyArmASession({
      label: 'A3',
      settled: true,
      init: initWith([USER_SERVER, LOCAL_SERVER, PROJECT_SERVER_X]),
      spawned: { ...expected.spawned, [PROJECT_SERVER_X]: true },
      canaries: expected.canaries,
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  for (const label of ['A', 'A+', 'A-', 'A2', 'A3'] as ArmALabel[]) {
    it(`${label}: expectedForArmA is a pure function of the label (no hidden state)`, () => {
      expect(expectedForArmA(label)).toEqual(expectedForArmA(label));
    });
  }
});

describe('Arm C -- the managedSettings/settings wall', () => {
  it('unsettled baseline is INCONCLUSIVE', () => {
    const v = classifyArmCSession({ variant: 'baseline', carrier: 'n/a', settled: false, init: null, spawned: { U: false, X: false, Y: false } });
    expect(v.conclusive).toBe(false);
  });

  it('baseline matching all-start is conclusive with no stop', () => {
    const v = classifyArmCSession({
      variant: 'baseline',
      carrier: 'n/a',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { U: true, X: true, Y: true },
    });
    expect(v.conclusive).toBe(true);
    expect(v.stops).toEqual([]);
  });

  it('baseline where X unexpectedly fails to start raises a STOP (regression control failed)', () => {
    const v = classifyArmCSession({
      variant: 'baseline',
      carrier: 'n/a',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_Y]),
      spawned: { U: true, X: false, Y: true },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('C1 via managedSettings matching "dropped -> same as baseline" (X,Y,U all start) has no stop', () => {
    const v = classifyArmCSession({
      variant: 'C1',
      carrier: 'managedSettings',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { U: true, X: true, Y: true },
    });
    expect(v.stops).toEqual([]);
  });

  it('C1 via managedSettings actually enforcing the allowlist (U,Y blocked) raises a STOP -- it should have been dropped', () => {
    const v = classifyArmCSession({
      variant: 'C1',
      carrier: 'managedSettings',
      settled: true,
      init: initWith([PROJECT_SERVER_X]),
      spawned: { U: false, X: true, Y: false },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('C5 via managedSettings expects the deny to SURVIVE (Y blocked, U/X fine); matching shape has no stop', () => {
    const v = classifyArmCSession({
      variant: 'C5',
      carrier: 'managedSettings',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X]),
      spawned: { U: true, X: true, Y: false },
    });
    expect(v.stops).toEqual([]);
  });

  it('C5 via managedSettings where Y starts anyway (deny dropped) raises a STOP', () => {
    const v = classifyArmCSession({
      variant: 'C5',
      carrier: 'managedSettings',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { U: true, X: true, Y: true },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('the settings carrier is undocumented -- no stop is raised regardless of measured shape', () => {
    const allStart = classifyArmCSession({
      variant: 'C1',
      carrier: 'settings',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { U: true, X: true, Y: true },
    });
    const literalShape = classifyArmCSession({
      variant: 'C1',
      carrier: 'settings',
      settled: true,
      init: initWith([PROJECT_SERVER_X]),
      spawned: { U: false, X: true, Y: false },
    });
    expect(allStart.stops).toEqual([]);
    expect(literalShape.stops).toEqual([]);
    expect(allStart.verdict).toContain('UNDOCUMENTED');
  });

  it('C1b (diagnostic: name-only allow entry) via managedSettings is still read as a permissive key expected dropped -- same shape as C1', () => {
    const v = classifyArmCSession({
      variant: 'C1b',
      carrier: 'managedSettings',
      settled: true,
      init: initWith([USER_SERVER, PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { U: true, X: true, Y: true },
    });
    expect(v.stops).toEqual([]);
  });

  it('C1b arm label composes as variant-carrier, matching its C1/C2/C3/C5 siblings', () => {
    const v = classifyArmCSession({ variant: 'C1b', carrier: 'settings', settled: true, init: initWith([]), spawned: { U: false, X: false, Y: false } });
    expect(v.arm).toBe('C1b-settings');
  });
});

describe('Arm B -- native project-gate semantics', () => {
  it('unsettled B1 is INCONCLUSIVE', () => {
    const v = classifyArmBSession({ variant: 'B1', settled: false, init: null, spawned: { X: false, Y: false } });
    expect(v.conclusive).toBe(false);
  });

  it('B1 matching the documented shape (X blocked, Y starts) has no stop', () => {
    const v = classifyArmBSession({ variant: 'B1', settled: true, init: initWith([PROJECT_SERVER_Y]), spawned: { X: false, Y: true } });
    expect(v.stops).toEqual([]);
  });

  it('B1 where X starts anyway raises a STOP', () => {
    const v = classifyArmBSession({ variant: 'B1', settled: true, init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]), spawned: { X: true, Y: true } });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('B2/B3 are open questions -- no stop regardless of measured shape', () => {
    const b2 = classifyArmBSession({ variant: 'B2', settled: true, init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]), spawned: { X: true, Y: true } });
    const b3 = classifyArmBSession({ variant: 'B3', settled: true, init: initWith([]), spawned: { X: false, Y: false } });
    expect(b2.stops).toEqual([]);
    expect(b3.stops).toEqual([]);
  });
});

describe('Arm F -- claudeMdExcludes feasibility', () => {
  it('control with canaries absent raises a STOP (the instrument cannot see the canaries at all)', () => {
    const v = classifyArmFSession({
      variant: 'control',
      settled: true,
      init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { X: true, Y: true },
      canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('control with canaries present is clean', () => {
    const v = classifyArmFSession({
      variant: 'control',
      settled: true,
      init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { X: true, Y: true },
      canaries: { userClaudeMd: true, projectClaudeMd: true, unscopedRule: true },
    });
    expect(v.stops).toEqual([]);
  });

  it('excludes variant matching feasibility (MCP still starts, canaries suppressed) is clean', () => {
    const v = classifyArmFSession({
      variant: 'F1-settings',
      settled: true,
      init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { X: true, Y: true },
      canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
    });
    expect(v.stops).toEqual([]);
  });

  it('excludes variant where the canary still leaks raises a STOP (design III premise false)', () => {
    const v = classifyArmFSession({
      variant: 'F1-settings',
      settled: true,
      init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
      spawned: { X: true, Y: true },
      canaries: { userClaudeMd: true, projectClaudeMd: true, unscopedRule: false },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  it('excludes variant where MCP loading is unexpectedly also suppressed raises a STOP', () => {
    const v = classifyArmFSession({
      variant: 'F1-settings',
      settled: true,
      init: initWith([]),
      spawned: { X: false, Y: false },
      canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
    });
    expect(v.stops.length).toBeGreaterThan(0);
  });

  describe('F2 (narrow, project-file-only exclude)', () => {
    it('matching feasibility (project canary suppressed, user CLAUDE.md + unscoped rule survive) is clean', () => {
      const v = classifyArmFSession({
        variant: 'F2-settings',
        settled: true,
        init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
        spawned: { X: true, Y: true },
        canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: true },
      });
      expect(v.stops).toEqual([]);
    });

    it('project canary still leaking raises a STOP', () => {
      const v = classifyArmFSession({
        variant: 'F2-settings',
        settled: true,
        init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
        spawned: { X: true, Y: true },
        canaries: { userClaudeMd: true, projectClaudeMd: true, unscopedRule: true },
      });
      expect(v.stops.some((s) => s.includes('did NOT suppress the project canary'))).toBe(true);
    });

    it('the narrow exclude ALSO suppressing user-level CLAUDE.md raises a STOP (design II cannot drop only its own file)', () => {
      const v = classifyArmFSession({
        variant: 'F2-settings',
        settled: true,
        init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
        spawned: { X: true, Y: true },
        canaries: { userClaudeMd: false, projectClaudeMd: false, unscopedRule: true },
      });
      expect(v.stops.some((s) => s.includes('ALSO suppressed user-level CLAUDE.md'))).toBe(true);
    });

    it('the narrow exclude unexpectedly suppressing the unscoped rule raises a STOP', () => {
      const v = classifyArmFSession({
        variant: 'F2-settings',
        settled: true,
        init: initWith([PROJECT_SERVER_X, PROJECT_SERVER_Y]),
        spawned: { X: true, Y: true },
        canaries: { userClaudeMd: true, projectClaudeMd: false, unscopedRule: false },
      });
      expect(v.stops.some((s) => s.includes('unexpectedly suppressed the unscoped rule'))).toBe(true);
    });
  });
});

describe('Arm E -- hooks under settingSources: [\'project\']', () => {
  it('unsettled is INCONCLUSIVE', () => {
    expect(classifyArmESession({ variant: 'control', settled: false, hookFired: false }).conclusive).toBe(false);
  });

  it('control expects the hook to fire; matching is clean, mismatch stops', () => {
    expect(classifyArmESession({ variant: 'control', settled: true, hookFired: true }).stops).toEqual([]);
    expect(classifyArmESession({ variant: 'control', settled: true, hookFired: false }).stops.length).toBeGreaterThan(0);
  });

  it('disableAllHooks expects the hook to NOT fire; matching is clean, mismatch stops', () => {
    expect(classifyArmESession({ variant: 'disableAllHooks', settled: true, hookFired: false }).stops).toEqual([]);
    expect(classifyArmESession({ variant: 'disableAllHooks', settled: true, hookFired: true }).stops.length).toBeGreaterThan(0);
  });
});

describe('Arm D -- disableClaudeAiConnectors', () => {
  it('no control connectors makes this arm INCONCLUSIVE (nothing to test disappearance against)', () => {
    const v = classifyArmD({ settled: true, init: initWith([]), controlConnectorNames: [] });
    expect(v.conclusive).toBe(false);
  });

  it('all control connectors gone is clean', () => {
    const v = classifyArmD({ settled: true, init: initWith(['agent-console']), controlConnectorNames: ['claude.ai Google Drive'] });
    expect(v.stops).toEqual([]);
  });

  it('a control connector still present raises a STOP', () => {
    const v = classifyArmD({ settled: true, init: initWith(['agent-console', 'claude.ai Google Drive']), controlConnectorNames: ['claude.ai Google Drive'] });
    expect(v.stops.length).toBeGreaterThan(0);
  });
});

describe('Arm G -- env-var expansion in declared server args', () => {
  it('no tool call (reportedTag null) is INCONCLUSIVE, not a negative measurement', () => {
    const v = classifyArmGSession({ variant: 'explicit', settled: true, reportedTag: null, literalTag: '${PROBE_VAR}', expandedTag: 'value' });
    expect(v.conclusive).toBe(false);
  });

  it('expanded value reported reads expanded=true, no stop', () => {
    const v = classifyArmGSession({ variant: 'explicit', settled: true, reportedTag: 'value', literalTag: '${PROBE_VAR}', expandedTag: 'value' });
    expect(v.verdict).toContain('expanded=true');
    expect(v.stops).toEqual([]);
  });

  it('literal placeholder reported reads literal=true, no stop', () => {
    const v = classifyArmGSession({ variant: 'explicit', settled: true, reportedTag: '${PROBE_VAR}', literalTag: '${PROBE_VAR}', expandedTag: 'value' });
    expect(v.verdict).toContain('literal=true');
    expect(v.stops).toEqual([]);
  });

  it('a reported tag matching neither form raises a STOP', () => {
    const v = classifyArmGSession({ variant: 'explicit', settled: true, reportedTag: 'garbage', literalTag: '${PROBE_VAR}', expandedTag: 'value' });
    expect(v.stops.length).toBeGreaterThan(0);
  });
});

describe('parseLedgerLine / parseLedger (teardown orphan check, Architect ruling PR #1782, CodeRabbit M1)', () => {
  it('parses a well-formed line', () => {
    expect(parseLedgerLine('12345\t9876543\tprobe-project-x\t2026-09-20T20:00:00.000Z')).toEqual({
      pid: 12345,
      starttime: '9876543',
      serverName: 'probe-project-x',
      timestamp: '2026-09-20T20:00:00.000Z',
    });
  });

  it('returns null for fewer than 4 tab-separated fields', () => {
    expect(parseLedgerLine('12345\t9876543\tprobe-project-x')).toBeNull();
  });

  it('returns null for a non-numeric or non-positive pid', () => {
    expect(parseLedgerLine('not-a-pid\t9876543\tprobe-project-x\t2026-09-20T20:00:00.000Z')).toBeNull();
    expect(parseLedgerLine('0\t9876543\tprobe-project-x\t2026-09-20T20:00:00.000Z')).toBeNull();
    expect(parseLedgerLine('-5\t9876543\tprobe-project-x\t2026-09-20T20:00:00.000Z')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseLedgerLine('')).toBeNull();
  });

  it('parses every valid line in a multi-line ledger, skipping blanks and malformed lines', () => {
    const content = [
      '111\t1000\tprobe-user-mcp\t2026-09-20T20:00:00.000Z',
      '',
      'garbage-line',
      '222\t2000\tprobe-project-x\t2026-09-20T20:00:01.000Z',
      '',
    ].join('\n');
    expect(parseLedger(content)).toEqual([
      { pid: 111, starttime: '1000', serverName: 'probe-user-mcp', timestamp: '2026-09-20T20:00:00.000Z' },
      { pid: 222, starttime: '2000', serverName: 'probe-project-x', timestamp: '2026-09-20T20:00:01.000Z' },
    ]);
  });
});

/** A synthetic `/proc/<pid>/stat` line: comm intentionally contains a space AND a `)` to exercise the last-`)` split. */
function fakeStatLine(starttime: string): string {
  return `12345 (weird comm)) S 1 12345 12345 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 ${starttime} 4327424 259 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 0 0 0 0 0 0`;
}

describe('matchesLedgerEntry (identity check before SIGKILL, Architect ruling PR #1782, CodeRabbit M2)', () => {
  const FIXTURE_MARKER = 'stdio-echo-mcp-server.ts';

  it('matches when starttime and cmdline both agree', () => {
    expect(matchesLedgerEntry('9876543', fakeStatLine('9876543'), `bun\0/abs/path/scripts/smoke/fixtures/${FIXTURE_MARKER}\0--canary\0/tmp/x.touched\0`, FIXTURE_MARKER)).toBe(true);
  });

  it('does not match when the starttime has changed (PID reused by a different process)', () => {
    expect(matchesLedgerEntry('9876543', fakeStatLine('1111111'), `bun\0/abs/path/scripts/smoke/fixtures/${FIXTURE_MARKER}\0`, FIXTURE_MARKER)).toBe(false);
  });

  it('does not match when cmdline no longer contains the fixture path (same starttime, different program -- an unlikely but not impossible PID-reuse coincidence)', () => {
    expect(matchesLedgerEntry('9876543', fakeStatLine('9876543'), 'some-other-program\0--flag\0', FIXTURE_MARKER)).toBe(false);
  });

  it('never matches an empty ledger starttime (never recorded, e.g. a non-Linux spawn)', () => {
    expect(matchesLedgerEntry('', fakeStatLine('9876543'), `bun\0${FIXTURE_MARKER}\0`, FIXTURE_MARKER)).toBe(false);
  });

  it('does not match malformed stat content (no starttime parseable)', () => {
    expect(matchesLedgerEntry('9876543', 'not-a-stat-line', `bun\0${FIXTURE_MARKER}\0`, FIXTURE_MARKER)).toBe(false);
  });
});

// `verifyIsolationStrict` / `snapshotIsolationEvidence` moved to the shared
// harness as its single writer (Issue #1783); their pins now live in
// `probe-sdk-session-harness.test.ts`, this probe's own local definitions
// having been removed. This probe still USES the harness functions (see
// `../probe-sdk-mcp-settings-sources.ts`'s `runOneSession` / `main`), but a
// second pin here would test the same function twice under two names.
