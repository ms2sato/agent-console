/**
 * Verdict classifiers and exit-code mapping for
 * `scripts/smoke/probe-sdk-declared-mcp-and-task.ts` (Issue #1726).
 *
 * The probe is billable and needs a real, authenticated `claude` CLI plus a
 * User-scope `chrome-devtools` server on the host, so its measurement is
 * never run here. Every classifier is pure -- it reads a `system:init`
 * observation, a post-turn status list, and hook-firing tallies handed to it
 * as plain data -- and importing the module runs nothing (the
 * `import.meta.main` guard), so the decision layer is pinned at zero cost and
 * separately from what it decides about.
 *
 * What the pins protect: the decisions that turn a run into a design input.
 * "Is this a leak?" must be decided by NAME against the reserved pair, never
 * by "any MCP-shaped entry"; a positive control that cannot see the seeded
 * server must make P0 INCONCLUSIVE rather than "no leak"; the P2 negative
 * control must be read by name; and a subagent using a tool outside the
 * allowlist must surface as a STOP, never fold into a green CONTAINED line.
 */
import { describe, it, expect } from 'bun:test';
import {
  PROBE_EXIT,
  classifyBaseline,
  classifyP0,
  classifyP1,
  classifyP2,
  classifyP3,
  classifyStrict,
  exitCodeFor,
  finalExitCode,
  honoredTaskToolName,
  isAccountConnector,
  mcpServerOf,
  parseClaimedTools,
  slugifyMcpServerName,
  startAgentConsoleStandIn,
  type InitObservation,
} from '../probe-sdk-declared-mcp-and-task.js';
import { Client } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const RESERVED_ONLY: InitObservation = {
  tools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Write', 'Edit', 'mcp__console__Compact', 'mcp__console__TodoWrite'],
  mcpServers: [
    { name: 'agent-console', status: 'connected' },
    { name: 'console', status: 'connected' },
  ],
};

const WITH_AMBIENT: InitObservation = {
  tools: [...RESERVED_ONLY.tools, 'mcp__chrome-devtools__list_pages'],
  mcpServers: [...RESERVED_ONLY.mcpServers, { name: 'chrome-devtools', status: 'connected' }],
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
   * A STOP finding is a MEASUREMENT: a P0 leak or a broken containment exits
   * 0 with the `STOP:` line, because the run produced exactly the reading it
   * exists to produce. The mapping reads `conclusive` only.
   */
  it('does not downgrade a conclusive STOP finding to a non-zero code', () => {
    const leak = classifyP0(WITH_AMBIENT, WITH_AMBIENT, 'chrome-devtools');
    expect(leak.stops.length).toBeGreaterThan(0);
    expect(exitCodeFor([leak])).toBe(PROBE_EXIT.MEASURED);
  });

  /**
   * Regression (CodeRabbit finding, PR #1727): a P0 leak with
   * `--continue-after-leak` absent withholds the selected `--p2`/`--p3` arms
   * before they ever push a verdict. `exitCodeFor` only ever sees PUSHED
   * verdicts, so a conclusive P0 alone reads MEASURED even though the
   * withheld arms produced no reading at all -- a caller reading the bare
   * exit code cannot tell "every selected arm read" from "some were
   * withheld". `finalExitCode` must downgrade that case to INCONCLUSIVE.
   */
  describe('finalExitCode (halt-after-leak downgrade)', () => {
    it('downgrades a would-be MEASURED code to INCONCLUSIVE when halted', () => {
      const onlyP0 = [classifyP0(RESERVED_ONLY, WITH_AMBIENT, 'chrome-devtools')];
      expect(exitCodeFor(onlyP0)).toBe(PROBE_EXIT.MEASURED); // the bug this guards against
      expect(finalExitCode(onlyP0, true)).toBe(PROBE_EXIT.INCONCLUSIVE);
    });

    it('leaves an unhalted MEASURED code unchanged', () => {
      const onlyP0 = [classifyP0(RESERVED_ONLY, WITH_AMBIENT, 'chrome-devtools')];
      expect(finalExitCode(onlyP0, false)).toBe(PROBE_EXIT.MEASURED);
    });

    it('never upgrades an already-INCONCLUSIVE or HARNESS-shaped result', () => {
      const inconclusive = [classifyP0(null, WITH_AMBIENT, 'chrome-devtools')];
      expect(finalExitCode(inconclusive, true)).toBe(PROBE_EXIT.INCONCLUSIVE);
      expect(finalExitCode(inconclusive, false)).toBe(PROBE_EXIT.INCONCLUSIVE);
    });
  });
});

describe('mcpServerOf', () => {
  it('extracts the server segment of an MCP-namespaced tool and null otherwise', () => {
    expect(mcpServerOf('mcp__console__Compact')).toBe('console');
    expect(mcpServerOf('mcp__chrome-devtools__list_pages')).toBe('chrome-devtools');
    expect(mcpServerOf('Read')).toBeNull();
    expect(mcpServerOf('mcp__')).toBeNull();
  });
});

describe('P0 baseline', () => {
  it('reads the reserved pair alone as no leak', () => {
    expect(classifyBaseline(RESERVED_ONLY)).toEqual({
      undeclaredServers: [],
      undeclaredMcpTools: [],
      accountConnectorServers: [],
      accountConnectorTools: [],
      leak: false,
    });
  });

  it('reads an undeclared server OR an undeclared mcp__ tool as a leak, by name', () => {
    expect(classifyBaseline(WITH_AMBIENT)).toMatchObject({
      undeclaredServers: ['chrome-devtools'],
      undeclaredMcpTools: ['mcp__chrome-devtools__list_pages'],
      leak: true,
    });
    // A tool-only leak (server list clean, a foreign mcp__ name in tools) still counts.
    expect(classifyBaseline({ tools: [...RESERVED_ONLY.tools, 'mcp__drive__search'], mcpServers: RESERVED_ONLY.mcpServers }).leak).toBe(true);
  });

  /**
   * Section 4.1's accepted class. The executing account's claude.ai
   * connectors are present under today's battery on three measured SDK
   * versions and are NOT the P0 question; folding them into the leak would
   * make P0 a leak on every host with a connector configured and hide the
   * user-scope-config finding it exists to isolate.
   */
  it('sets account connectors aside instead of counting them as the leak', () => {
    const withConnector: InitObservation = {
      tools: [...RESERVED_ONLY.tools, 'mcp__claude_ai_Google_Drive__search_files'],
      mcpServers: [...RESERVED_ONLY.mcpServers, { name: 'claude_ai_Google_Drive', status: 'connected' }],
    };
    expect(isAccountConnector('claude_ai_Google_Drive')).toBe(true);
    expect(isAccountConnector('chrome-devtools')).toBe(false);
    expect(classifyBaseline(withConnector)).toEqual({
      undeclaredServers: [],
      undeclaredMcpTools: [],
      accountConnectorServers: ['claude_ai_Google_Drive'],
      accountConnectorTools: ['mcp__claude_ai_Google_Drive__search_files'],
      leak: false,
    });
    const v = classifyP0(withConnector, WITH_AMBIENT, 'chrome-devtools');
    expect(v.verdict).toStartWith('NO LEAK');
    expect(v.verdict).toContain('claude_ai_Google_Drive');
  });

  /**
   * Regression for the P0 run of 2026-09-20: `system:init.mcp_servers[].name`
   * reports the SAME four claude.ai connectors as a human-readable label
   * ("claude.ai Google Calendar"), not the tool-name slug form
   * ("claude_ai_Google_Calendar"). A server with no tools yet (e.g.
   * `needs-auth`, as measured for Calendar and Gmail) appears ONLY in
   * `mcp_servers`, so this label form must be recognized directly -- it
   * cannot be inferred from a tool-name prefix that never arrives.
   */
  it('recognizes the account-connector class in its mcp_servers[].name label form, not only the tool-name slug form', () => {
    expect(slugifyMcpServerName('claude.ai Google Calendar')).toBe('claude_ai_Google_Calendar');
    expect(slugifyMcpServerName('claude_ai_Google_Drive')).toBe('claude_ai_Google_Drive');
    expect(slugifyMcpServerName('agent-console')).toBe('agent_console');
    expect(isAccountConnector('claude.ai Google Calendar')).toBe(true);
    expect(isAccountConnector('claude.ai Gmail')).toBe(true);
    expect(isAccountConnector('claude_ai_Google_Drive')).toBe(true); // pre-existing slug form still matches
    expect(isAccountConnector('chrome-devtools')).toBe(false);
    expect(isAccountConnector('agent-console')).toBe(false);

    const labelFormOnly: InitObservation = {
      // Calendar/Gmail carry no tools while `needs-auth` -- the label-form
      // server entry is the ONLY signal available for them.
      tools: RESERVED_ONLY.tools,
      mcpServers: [...RESERVED_ONLY.mcpServers, { name: 'claude.ai Google Calendar', status: 'needs-auth' }],
    };
    expect(classifyBaseline(labelFormOnly)).toEqual({
      undeclaredServers: [],
      undeclaredMcpTools: [],
      accountConnectorServers: ['claude.ai Google Calendar'],
      accountConnectorTools: [],
      leak: false,
    });
  });

  it('is INCONCLUSIVE, never "no leak", when the positive control cannot see the seeded server', () => {
    const v = classifyP0(RESERVED_ONLY, RESERVED_ONLY, 'chrome-devtools');
    expect(v.conclusive).toBe(false);
    expect(v.verdict).toStartWith('INCONCLUSIVE');
    expect(exitCodeFor([v])).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('is INCONCLUSIVE when either session produced no system:init', () => {
    expect(classifyP0(null, WITH_AMBIENT, 'chrome-devtools').conclusive).toBe(false);
    expect(classifyP0(RESERVED_ONLY, null, 'chrome-devtools').conclusive).toBe(false);
  });

  it('reads NO LEAK when the control sees the server and the subject does not', () => {
    const v = classifyP0(RESERVED_ONLY, WITH_AMBIENT, 'chrome-devtools');
    expect(v).toMatchObject({ conclusive: true, stops: [] });
    expect(v.verdict).toStartWith('NO LEAK');
  });

  it('reads LEAK with a STOP when the subject sees the ambient server', () => {
    const v = classifyP0(WITH_AMBIENT, WITH_AMBIENT, 'chrome-devtools');
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('LEAK');
    expect(v.stops[0]).toContain('chrome-devtools');
  });
});

describe('P1 strict', () => {
  it('holds on the exact reserved pair with console connected and both console tools present', () => {
    const r = classifyStrict(RESERVED_ONLY, []);
    expect(r).toMatchObject({ namesExact: true, consoleConnected: true, consoleToolsPresent: true, agentConsoleStatus: 'connected' });
    const v = classifyP1(RESERVED_ONLY, []);
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('STRICT HOLDS');
    expect(v.stops).toEqual([]);
  });

  it('lets the post-turn status settle a pending init status', () => {
    const pendingInit: InitObservation = {
      tools: RESERVED_ONLY.tools,
      mcpServers: [
        { name: 'agent-console', status: 'pending' },
        { name: 'console', status: 'pending' },
      ],
    };
    const r = classifyStrict(pendingInit, [
      { name: 'agent-console', status: 'connected' },
      { name: 'console', status: 'connected' },
    ]);
    expect(r.consoleConnected).toBe(true);
    expect(r.agentConsoleStatus).toBe('connected');
  });

  it('deviates with a STOP when an extra name survives strict mode or console is not connected', () => {
    expect(classifyP1(WITH_AMBIENT, []).verdict).toStartWith('STRICT DEVIATES');
    expect(classifyP1(WITH_AMBIENT, []).stops.length).toBe(1);
    const consoleDown: InitObservation = {
      tools: RESERVED_ONLY.tools,
      mcpServers: [
        { name: 'agent-console', status: 'connected' },
        { name: 'console', status: 'failed' },
      ],
    };
    expect(classifyP1(consoleDown, []).verdict).toStartWith('STRICT DEVIATES');
  });

  it('keeps the exactness reading on the reserved pair when account connectors persist under strict, and reports them', () => {
    const strictWithConnector: InitObservation = {
      tools: RESERVED_ONLY.tools,
      mcpServers: [...RESERVED_ONLY.mcpServers, { name: 'claude_ai_Google_Drive', status: 'connected' }],
    };
    const r = classifyStrict(strictWithConnector, []);
    expect(r.namesExact).toBe(true);
    expect(r.accountConnectors).toEqual(['claude_ai_Google_Drive']);
    expect(classifyP1(strictWithConnector, []).verdict).toContain('accountConnectorsUnderStrict=["claude_ai_Google_Drive"]');
  });

  it('reports agent-console by NAME and never folds its status into the console check', () => {
    const acDown: InitObservation = {
      tools: RESERVED_ONLY.tools,
      mcpServers: [
        { name: 'agent-console', status: 'failed' },
        { name: 'console', status: 'connected' },
      ],
    };
    const r = classifyStrict(acDown, []);
    expect(r.agentConsoleStatus).toBe('failed');
    expect(r.consoleConnected).toBe(true);
    expect(r.namesExact).toBe(true);
  });

  it('is INCONCLUSIVE with no system:init', () => {
    expect(classifyP1(null, []).conclusive).toBe(false);
  });
});

describe('P2 declared', () => {
  const declaredInit: InitObservation = {
    tools: [...RESERVED_ONLY.tools, 'mcp__chrome-devtools__list_pages'],
    mcpServers: [
      ...RESERVED_ONLY.mcpServers,
      { name: 'chrome-devtools', status: 'connected' },
      { name: 'missing-command', status: 'failed' },
    ],
  };
  const base = { init: declaredInit, post: [], declaredName: 'chrome-devtools', missingName: 'missing-command', declaredToolCalls: 1, turnSettled: true };

  it('reads DECLARED WORKS with a clean negative control', () => {
    const v = classifyP2(base);
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('DECLARED WORKS');
    expect(v.verdict).toContain('clean failure');
    expect(v.stops).toEqual([]);
  });

  it('requires a real tool call, not just a connected status', () => {
    const v = classifyP2({ ...base, declaredToolCalls: 0 });
    expect(v.verdict).toStartWith('DECLARED DID NOT WORK');
  });

  it('flags the negative control by NAME when the missing command did not fail cleanly', () => {
    const leakyMissing: InitObservation = {
      tools: [...declaredInit.tools, 'mcp__missing-command__ghost'],
      mcpServers: declaredInit.mcpServers.map((s) => (s.name === 'missing-command' ? { ...s, status: 'connected' } : s)),
    };
    const v = classifyP2({ ...base, init: leakyMissing });
    expect(v.stops.some((s) => s.includes("'missing-command'"))).toBe(true);
    // The reserved console check and the declared-server reading are untouched by it.
    expect(v.verdict).toStartWith('DECLARED WORKS');
  });

  it('reads the reserved console independently of the declared servers', () => {
    const consoleDown: InitObservation = {
      tools: declaredInit.tools,
      mcpServers: declaredInit.mcpServers.map((s) => (s.name === 'console' ? { ...s, status: 'failed' } : s)),
    };
    const v = classifyP2({ ...base, init: consoleDown });
    expect(v.stops.some((s) => s.includes('console'))).toBe(true);
  });

  it('is INCONCLUSIVE without an init or an unsettled turn', () => {
    expect(classifyP2({ ...base, init: null }).conclusive).toBe(false);
    expect(classifyP2({ ...base, turnSettled: false }).conclusive).toBe(false);
  });
});

describe('P3 task', () => {
  const PARENT = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Write', 'Edit', 'Task', 'Agent'] as const;
  const taskInit: InitObservation = { tools: [...RESERVED_ONLY.tools, 'Task'], mcpServers: RESERVED_ONLY.mcpServers };
  const contained = {
    half: 'a' as const,
    init: taskInit,
    parentAllowlist: PARENT,
    subagentStarts: ['general-purpose'],
    childToolCalls: ['Read'],
    nonceRelayed: true,
    childClaimedTools: ['Read', 'Glob'],
    turnSettled: true,
  };

  it('reports which candidate name the CLI honored', () => {
    expect(honoredTaskToolName(taskInit)).toBe('Task');
    expect(honoredTaskToolName({ ...taskInit, tools: [...RESERVED_ONLY.tools, 'Agent'] })).toBe('Agent');
    expect(honoredTaskToolName({ ...taskInit, tools: [...RESERVED_ONLY.tools, 'Task', 'Agent'] })).toBe('both');
    expect(honoredTaskToolName(RESERVED_ONLY)).toBeNull();
  });

  it('reads "neither name honored" as a definite measurement with a STOP, no delegation needed', () => {
    const v = classifyP3({ ...contained, init: RESERVED_ONLY, turnSettled: false });
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('TASK NOT ENABLED');
    expect(v.stops.length).toBe(1);
  });

  it('reads a child that used only allowlisted tools as CONTAINED', () => {
    const v = classifyP3(contained);
    expect(v).toMatchObject({ arm: 'P3a', conclusive: true, stops: [] });
    expect(v.verdict).toStartWith('CONTAINED');
  });

  it('surfaces a child Bash call as a STOP when the parent allowlist has no Bash', () => {
    const v = classifyP3({ ...contained, childToolCalls: ['Read', 'Bash'] });
    expect(v.verdict).toStartWith('ESCAPED');
    expect(v.stops.some((s) => s.includes('CONTAINMENT BROKEN') && s.includes('Bash'))).toBe(true);
  });

  it('ignores mcp__ names in the child tally (governed by the mcp_servers set, not the allowlist)', () => {
    const v = classifyP3({ ...contained, childToolCalls: ['Read', 'mcp__console__Compact'] });
    expect(v.verdict).toStartWith('CONTAINED');
  });

  it('measures half (b) against the DECLARED subagent tools, not the parent allowlist', () => {
    const b = { ...contained, half: 'b' as const, declaredChildTools: ['Read'] as const };
    expect(classifyP3(b).verdict).toStartWith('CONTAINED');
    // Glob is in the parent allowlist but NOT in the declared subset -- an escape for half (b).
    const v = classifyP3({ ...b, childToolCalls: ['Read', 'Glob'] });
    expect(v.arm).toBe('P3b');
    expect(v.verdict).toStartWith('ESCAPED');
    expect(v.stops.some((s) => s.includes('Glob'))).toBe(true);
  });

  it('reads no subagent at all as a definite finding, not as containment', () => {
    const v = classifyP3({ ...contained, subagentStarts: [], childToolCalls: [] });
    expect(v.conclusive).toBe(true);
    expect(v.verdict).toStartWith('NO SUBAGENT RAN');
    expect(v.stops.length).toBe(1);
  });

  it('adds a STOP when the nonce was not relayed, without changing the containment reading', () => {
    const v = classifyP3({ ...contained, nonceRelayed: false });
    expect(v.verdict).toStartWith('CONTAINED');
    expect(v.stops.some((s) => s.includes('nonce'))).toBe(true);
  });

  it('is INCONCLUSIVE when the tool was honored but the delegation turn did not settle', () => {
    const v = classifyP3({ ...contained, turnSettled: false });
    expect(v.conclusive).toBe(false);
    expect(v.verdict).toStartWith('INCONCLUSIVE');
  });
});

describe('parseClaimedTools', () => {
  it('collects TOOL: lines in order, deduplicated', () => {
    expect(parseClaimedTools('TOOL: Read\nTOOL: Glob\nfoo\nTOOL: Read\n')).toEqual(['Read', 'Glob']);
    expect(parseClaimedTools('no tools here')).toEqual([]);
  });
});

/**
 * Regression for the P0 run of 2026-09-20: the `agent-console` stand-in
 * reported status `failed` on every arm because its single, process-lifetime
 * `WebStandardStreamableHTTPServerTransport` (stateless mode, no
 * `sessionIdGenerator`) threw "Stateless transport cannot be reused across
 * requests" from the SECOND request onward -- a probe session makes several
 * turns, each hitting this stand-in at least once. Free and deterministic:
 * real HTTP requests against a real in-process MCP server, no `claude` CLI,
 * no cost. Two independent `Client` handshakes (not two raw fetches) because
 * an MCP `initialize` is exactly what production's SDK does on every turn
 * that touches this server, and is what the pre-fix code could not survive
 * twice.
 */
describe('agent-console stand-in (regression: stateless transport reuse)', () => {
  it('answers a second, independent client handshake after the first has completed', async () => {
    const standIn = await startAgentConsoleStandIn();
    try {
      for (let i = 0; i < 2; i++) {
        const client = new Client({ name: `probe-test-client-${i}`, version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(standIn.url));
        await client.connect(transport);
        const result = await client.callTool({ name: 'probe_ping', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
        await client.close();
      }
    } finally {
      standIn.stop();
    }
  });
});
