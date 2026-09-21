/**
 * Verdict classifiers and exit-code mapping for
 * `scripts/smoke/probe-sdk-phase5-pr2-premises.ts` (Issue #1785, Phase 5
 * PR-2 premises P-a/P-b).
 *
 * The probe is billable and needs a real, authenticated `claude` CLI, so its
 * measurement is never run here. Every classifier is pure -- it reads a
 * `system:init.agents` list, a `McpSetServersResult`, an `mcpServerStatus()`
 * list, and hook-firing booleans handed to it as plain data -- and importing
 * the module runs nothing (the `import.meta.main` guard), so the decision
 * layer is pinned at zero cost and separately from what it decides about.
 *
 * What the pins protect: P-a's positive/negative reading must be decided by
 * NAME (never "any failed status" or "any connected status"), an unsettled
 * turn must read INCONCLUSIVE rather than a negative measurement, and P-b's
 * "exactly one agent entry" gate must not silently accept a duplicate
 * (declared + natively-loaded) count of two as if it were a clean one.
 */
import { describe, it, expect } from 'bun:test';
import {
  PROBE_EXIT,
  agentEntryCount,
  classifyAgentsExactlyOne,
  classifyDuplicateConsoleRegistration,
  classifyPa,
  classifyPbControl,
  classifyPbSubject,
  describeReservedPersistence,
  exitCodeFor,
  type PaInputs,
} from '../probe-sdk-phase5-pr2-premises.js';

const BASE_PA: PaInputs = {
  turnSettled: true,
  canaryExists: true,
  toolCallObserved: true,
  missingToolCallObserved: false,
  statusByName: [
    { name: 'agent-console', status: 'connected' },
    { name: 'console', status: 'connected' },
    { name: 'probe-live-add', status: 'connected' },
    { name: 'probe-missing-command', status: 'failed' },
  ],
  setResult: { added: ['probe-live-add', 'probe-missing-command'], removed: [], errors: {} },
  newServerName: 'probe-live-add',
  missingServerName: 'probe-missing-command',
};

describe('exit codes', () => {
  it('assigns each outcome a distinct code, 0/1/2', () => {
    expect(new Set([PROBE_EXIT.MEASURED, PROBE_EXIT.INCONCLUSIVE, PROBE_EXIT.HARNESS]).size).toBe(3);
    expect(PROBE_EXIT.MEASURED).toBe(0);
    expect(PROBE_EXIT.INCONCLUSIVE).toBe(1);
    expect(PROBE_EXIT.HARNESS).toBe(2);
  });

  it('exits MEASURED only when every arm concluded, and never on an empty set', () => {
    expect(exitCodeFor([{ conclusive: true }, { conclusive: true }])).toBe(PROBE_EXIT.MEASURED);
    expect(exitCodeFor([{ conclusive: true }, { conclusive: false }])).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor([])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  /**
   * A STOP finding is a MEASUREMENT: a broken live-add or a leaked agents
   * count exits 0 with the `STOP:` line, because the run produced exactly
   * the reading it exists to produce. The mapping reads `conclusive` only.
   */
  it('does not downgrade a conclusive STOP finding to a non-zero code', () => {
    const broken = classifyPa({ ...BASE_PA, canaryExists: false });
    expect(broken.stops.length).toBeGreaterThan(0);
    expect(exitCodeFor([broken])).toBe(PROBE_EXIT.MEASURED);
  });
});

describe('classifyPa', () => {
  it('reads LIVE ADD WORKS when both the positive and negative controls hold', () => {
    const v = classifyPa(BASE_PA);
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('LIVE ADD WORKS');
    expect(v.stops).toEqual([]);
  });

  it('is INCONCLUSIVE, never a negative measurement, when the tool-call turn did not settle', () => {
    const v = classifyPa({ ...BASE_PA, turnSettled: false, canaryExists: false, toolCallObserved: false });
    expect(v.conclusive).toBe(false);
    expect(v.verdict).toStartWith('INCONCLUSIVE');
    expect(exitCodeFor([v])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('flags the positive control as broken when the canary never appeared, even if status says connected', () => {
    const v = classifyPa({ ...BASE_PA, canaryExists: false });
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('LIVE ADD DEVIATES');
    expect(v.stops[0]).toContain('canaryExists=false');
  });

  it('flags the positive control as broken when status is not connected by NAME', () => {
    const v = classifyPa({
      ...BASE_PA,
      statusByName: BASE_PA.statusByName.map((s) => (s.name === 'probe-live-add' ? { ...s, status: 'pending' } : s)),
    });
    expect(v.verdict).toStartWith('LIVE ADD DEVIATES');
  });

  it('flags the positive control as broken when no tool call was ever observed', () => {
    const v = classifyPa({ ...BASE_PA, toolCallObserved: false });
    expect(v.verdict).toStartWith('LIVE ADD DEVIATES');
  });

  it('accepts the negative control via McpSetServersResult.errors naming the server', () => {
    const v = classifyPa({
      ...BASE_PA,
      statusByName: BASE_PA.statusByName.map((s) => (s.name === 'probe-missing-command' ? { ...s, status: 'pending' } : s)),
      setResult: { added: ['probe-live-add'], removed: [], errors: { 'probe-missing-command': 'ENOENT' } },
    });
    expect(v.verdict).toStartWith('LIVE ADD WORKS');
  });

  it('accepts the negative control via mcpServerStatus() reporting failed, with an empty errors object', () => {
    const v = classifyPa({ ...BASE_PA, setResult: { added: ['probe-live-add'], removed: [], errors: {} } });
    expect(v.verdict).toStartWith('LIVE ADD WORKS');
  });

  it('flags the negative control as NOT clean when a tool from the missing server was observed', () => {
    const v = classifyPa({ ...BASE_PA, missingToolCallObserved: true });
    expect(v.verdict).toStartWith('LIVE ADD DEVIATES');
    expect(v.stops.some((s) => s.includes('negative control'))).toBe(true);
  });

  it('flags the negative control as NOT clean when neither errors nor status reports the failure', () => {
    const v = classifyPa({
      ...BASE_PA,
      statusByName: BASE_PA.statusByName.map((s) => (s.name === 'probe-missing-command' ? { ...s, status: 'connected' } : s)),
    });
    expect(v.verdict).toStartWith('LIVE ADD DEVIATES');
  });
});

describe('describeReservedPersistence', () => {
  it('reports (absent) for both before and after on an empty list', () => {
    expect(describeReservedPersistence([], [], ['agent-console', 'console'])).toBe(
      'agent-console: before=(absent) after=(absent); console: before=(absent) after=(absent)',
    );
  });

  it('reports the status found by name at each snapshot', () => {
    const before = [{ name: 'agent-console', status: 'connected' }, { name: 'console', status: 'connected' }];
    const after = [{ name: 'agent-console', status: 'connected' }, { name: 'console', status: 'failed' }];
    expect(describeReservedPersistence(before, after, ['agent-console', 'console'])).toBe(
      'agent-console: before=connected after=connected; console: before=connected after=failed',
    );
  });
});

describe('classifyDuplicateConsoleRegistration', () => {
  it('reads accepted-cleanly on an empty errors object', () => {
    expect(classifyDuplicateConsoleRegistration({ errors: {} }, 'console')).toBe('accepted-cleanly');
  });

  it('reads accepted-cleanly when errors names an unrelated server', () => {
    expect(classifyDuplicateConsoleRegistration({ errors: { 'probe-missing-command': 'ENOENT' } }, 'console')).toBe('accepted-cleanly');
  });

  it('reads errored when errors names the server under test', () => {
    expect(classifyDuplicateConsoleRegistration({ errors: { console: 'duplicate registration' } }, 'console')).toBe('errored');
  });
});

describe('agentEntryCount / classifyAgentsExactlyOne', () => {
  it('counts zero when agents is undefined', () => {
    expect(agentEntryCount(undefined, 'probe-agent')).toBe(0);
    expect(classifyAgentsExactlyOne(undefined, 'probe-agent')).toEqual({ count: 0, exactlyOne: false });
  });

  it('counts zero on an empty array', () => {
    expect(agentEntryCount([], 'probe-agent')).toBe(0);
    expect(classifyAgentsExactlyOne([], 'probe-agent')).toEqual({ count: 0, exactlyOne: false });
  });

  it('counts one when the name appears once, among others', () => {
    expect(agentEntryCount(['general-purpose', 'probe-agent'], 'probe-agent')).toBe(1);
    expect(classifyAgentsExactlyOne(['general-purpose', 'probe-agent'], 'probe-agent')).toEqual({ count: 1, exactlyOne: true });
  });

  it('counts two -- declared plus natively loaded -- and does not accept it as exactly-one', () => {
    expect(agentEntryCount(['probe-agent', 'probe-agent'], 'probe-agent')).toBe(2);
    expect(classifyAgentsExactlyOne(['probe-agent', 'probe-agent'], 'probe-agent')).toEqual({ count: 2, exactlyOne: false });
  });
});

describe('classifyPbSubject', () => {
  const BASE = {
    turnSettled: true,
    agentsInInit: ['probe-agent'],
    subagentStartFired: true,
    answer: 'The subagent reported NONCE=OPT-1 and said it is the OPTION version.',
    optionNonce: 'OPT-1',
  };

  it('reads OPTIONS.AGENTS WORKS when every condition holds', () => {
    const v = classifyPbSubject(BASE);
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('OPTIONS.AGENTS WORKS');
    expect(v.stops).toEqual([]);
  });

  it('is INCONCLUSIVE, never a negative measurement, when the delegation turn did not settle', () => {
    const v = classifyPbSubject({ ...BASE, turnSettled: false, agentsInInit: undefined, subagentStartFired: false, answer: '' });
    expect(v.conclusive).toBe(false);
    expect(v.verdict).toStartWith('INCONCLUSIVE');
  });

  it('flags a STOP when system:init.agents reports the name twice, not exactly once', () => {
    const v = classifyPbSubject({ ...BASE, agentsInInit: ['probe-agent', 'probe-agent'] });
    expect(v.verdict).toStartWith('OPTIONS.AGENTS DEVIATES');
    expect(v.stops.some((s) => s.includes('2 time(s)'))).toBe(true);
  });

  it('flags a STOP when system:init.agents omits the name entirely', () => {
    const v = classifyPbSubject({ ...BASE, agentsInInit: [] });
    expect(v.verdict).toStartWith('OPTIONS.AGENTS DEVIATES');
  });

  it('flags a STOP when no SubagentStart firing was observed', () => {
    const v = classifyPbSubject({ ...BASE, subagentStartFired: false });
    expect(v.verdict).toStartWith('OPTIONS.AGENTS DEVIATES');
  });

  it('flags a STOP when the nonce was never relayed', () => {
    const v = classifyPbSubject({ ...BASE, answer: 'The subagent said it is the OPTION version.' });
    expect(v.verdict).toStartWith('OPTIONS.AGENTS DEVIATES');
  });

  it('flags a STOP when the answer says FILE instead of OPTION -- the file version won', () => {
    const v = classifyPbSubject({ ...BASE, answer: 'The subagent reported NONCE=OPT-1 and said it is the FILE version.' });
    expect(v.verdict).toStartWith('OPTIONS.AGENTS DEVIATES');
  });
});

describe('classifyPbControl', () => {
  it('reads CONTROL CLEAN when the name never appears with Options.agents omitted', () => {
    const v = classifyPbControl({ turnSettled: true, agentsInInit: [] });
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('CONTROL CLEAN');
    expect(v.stops).toEqual([]);
  });

  it('reads CONTROL CLEAN when agentsInInit is undefined', () => {
    expect(classifyPbControl({ turnSettled: true, agentsInInit: undefined }).verdict).toStartWith('CONTROL CLEAN');
  });

  it('is INCONCLUSIVE when the control turn did not settle', () => {
    const v = classifyPbControl({ turnSettled: false, agentsInInit: undefined });
    expect(v.conclusive).toBe(false);
    expect(v.verdict).toStartWith('INCONCLUSIVE');
  });

  it('reads CONTROL LEAKED with a STOP when the name appears despite Options.agents being omitted', () => {
    const v = classifyPbControl({ turnSettled: true, agentsInInit: ['probe-agent'] });
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('CONTROL LEAKED');
    expect(v.stops[0]).toContain('probe-agent');
  });
});
