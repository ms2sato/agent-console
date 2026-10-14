/**
 * Reverse-direction guard for `SESSION_CLAIMING_TOOLS`: parses `mcp-server.ts`
 * by `mcpServer.tool(` registration and asserts the set of registrations whose
 * block calls `checkCallerOwnsSession(` equals the registry exactly. The
 * forward direction (an unlisted name passed to the gate) is a compile error
 * pinned in `mcp-auth.test.ts`.
 *
 * Positive controls come first: an empty or broken parse would otherwise make
 * "no missing, no extra" trivially true.
 *
 * The CONVERSE is a second `describe` below: the registry test cannot see a tool
 * that takes a `sessionId` and gates nothing, because it starts from the blocks
 * that gate. The converse starts from the blocks that take the param.
 */
import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { SESSION_CLAIMING_TOOLS, SESSION_ID_TAKING_UNGATED_TOOLS } from '../session-claiming-tools.js';

// `Bun.file` reads the real disk; `node:fs` is the in-memory layer once any other
// test file in the same process has loaded the memfs helper.
const SOURCE = await Bun.file(path.join(import.meta.dir, '..', 'mcp-server.ts')).text();

interface ToolBlock {
  name: string;
  /** Offset of the `mcpServer.tool(` line in the source. */
  index: number;
  body: string;
}

/** Split the source at each `mcpServer.tool(` registration; the name is the first string literal after it. */
function parseToolBlocks(source: string): ToolBlock[] {
  const marker = /^[ \t]*mcpServer\.tool\(\s*(['"])([a-z_]+)\1/gm;
  const starts: Array<{ name: string; index: number }> = [];
  for (const m of source.matchAll(marker)) {
    starts.push({ name: m[2], index: m.index! });
  }
  return starts.map((s, i) => ({
    name: s.name,
    index: s.index,
    body: source.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : source.length),
  }));
}

const blocks = parseToolBlocks(SOURCE);
const claiming = blocks.filter((b) => b.body.includes('checkCallerOwnsSession('));

describe('SESSION_CLAIMING_TOOLS registry', () => {
  it('positive control: the parser finds known claiming tools and not a known non-claiming one', () => {
    const allNames = blocks.map((b) => b.name);
    const claimingNames = claiming.map((b) => b.name);
    expect(allNames).toContain('set_orchestrator_session');
    expect(allNames).toContain('set_mcp_server_permission');
    expect(allNames).toContain('list_sessions');
    expect(claimingNames).toContain('set_orchestrator_session');
    expect(claimingNames).toContain('set_mcp_server_permission');
    expect(claimingNames).not.toContain('list_sessions');
  });

  it('every registration that calls checkCallerOwnsSession is listed, and every listed tool calls it', () => {
    const actual = new Set(claiming.map((b) => b.name));
    const registry = new Set<string>(SESSION_CLAIMING_TOOLS);
    const missing = [...actual].filter((n) => !registry.has(n)).sort();
    const extra = [...registry].filter((n) => !actual.has(n)).sort();
    expect({ missingFromRegistry: missing, listedButNotGated: extra }).toEqual({
      missingFromRegistry: [],
      listedButNotGated: [],
    });
  });

  it('lists update_html_artifact, and its registration calls the gate under that name', () => {
    expect(SESSION_CLAIMING_TOOLS).toContain('update_html_artifact');
    expect(claiming.map((b) => b.name)).toContain('update_html_artifact');
  });

  it('has no duplicate names', () => {
    expect(new Set(SESSION_CLAIMING_TOOLS).size).toBe(SESSION_CLAIMING_TOOLS.length);
  });

  it("each claiming block's toolName literal at the gate equals its own registered name", () => {
    const mismatches: string[] = [];
    for (const b of claiming) {
      const gateCall = b.body.slice(b.body.indexOf('checkCallerOwnsSession('));
      const literal = /toolName:\s*'([a-z_]+)'/.exec(gateCall)?.[1];
      if (literal !== b.name) mismatches.push(`${b.name} -> ${literal}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('every claiming block carries the one-line registry marker in the comment run above it', () => {
    const unmarked = claiming
      .filter((b) => {
        const lines = SOURCE.slice(0, b.index).split('\n');
        lines.pop(); // the (empty) remainder of the registration's own line
        const run: string[] = [];
        while (lines.length > 0 && lines[lines.length - 1].trim().startsWith('//')) {
          run.push(lines.pop()!);
        }
        return !run.some((l) => l.includes('session-claiming-tools.ts'));
      })
      .map((b) => b.name);
    expect(unmarked).toEqual([]);
  });
});

/** True when the block declares a caller-supplied `sessionId: z.string()` param (`sourceSessionId` etc. do not match: the `\b` needs a word start). */
function takesSessionId(b: ToolBlock): boolean {
  return /\bsessionId:\s*z\.string\(/.test(b.body);
}

/**
 * Gated = the claimed session is checked against the caller (`checkCallerOwnsSession(`)
 * or is not claimed at all but resolved from the caller's own bearer-token-proven
 * identity (`resolveSelfIdentity(`, which refuses a different `sessionId`).
 */
function gatesSessionId(b: ToolBlock): boolean {
  return b.body.includes('checkCallerOwnsSession(') || b.body.includes('resolveSelfIdentity(');
}

describe('sessionId-taking tools: the converse of the registry', () => {
  const taking = blocks.filter(takesSessionId);
  const exempt = new Map(SESSION_ID_TAKING_UNGATED_TOOLS.map((e) => [e.tool, e.reason]));

  // Mutations measured when this test was written (each restored):
  // - removing `write_memo` from SESSION_CLAIMING_TOOLS fails the registry
  //   test above (listedButNotGated / missingFromRegistry);
  // - removing the `get_session_status` exemption fails the "neither gates nor is
  //   exempted" half below;
  // - adding a third exemption for a tool that gates (e.g. `close_session`)
  //   fails the stale-exemption half below.
  it('positive control: the parser classifies known tools correctly', () => {
    const byName = new Map(blocks.map((b) => [b.name, b]));
    expect(takesSessionId(byName.get('write_memo')!)).toBe(true);
    expect(gatesSessionId(byName.get('write_memo')!)).toBe(true);
    expect(takesSessionId(byName.get('get_session_status')!)).toBe(true);
    expect(gatesSessionId(byName.get('get_session_status')!)).toBe(false);
    expect(takesSessionId(byName.get('close_session')!)).toBe(true);
    expect(gatesSessionId(byName.get('close_session')!)).toBe(true);
    expect(takesSessionId(byName.get('list_sessions')!)).toBe(false);
  });

  it('every tool that takes a sessionId gates it or is exempted with a reason, and no exemption is stale', () => {
    const ungatedAndUnexempted = taking
      .filter((b) => !gatesSessionId(b) && !exempt.has(b.name))
      .map((b) => b.name)
      .sort();
    const staleExemptions = [...exempt.keys()]
      .filter((name) => {
        const block = blocks.find((b) => b.name === name);
        return block === undefined || !takesSessionId(block) || gatesSessionId(block);
      })
      .sort();
    expect({ ungatedAndUnexempted, staleExemptions }).toEqual({
      ungatedAndUnexempted: [],
      staleExemptions: [],
    });
  });

  it('the exemptions are exactly the two team-visible reads, each with a final reason (none is waiting on a decision)', () => {
    expect(SESSION_ID_TAKING_UNGATED_TOOLS.map((e) => e.tool).sort()).toEqual(['get_session_status', 'list_timers']);
    const stillOpen = SESSION_ID_TAKING_UNGATED_TOOLS.filter((e) => /decid|pending/i.test(e.reason)).map((e) => e.tool);
    expect(stillOpen).toEqual([]);
    // A WRITE never belongs on this list: no exempt tool is a registered writer of session state.
    expect(SESSION_ID_TAKING_UNGATED_TOOLS.map((e) => e.tool)).not.toContain('write_memo');
    expect(SESSION_ID_TAKING_UNGATED_TOOLS.map((e) => e.tool)).not.toContain('close_session');
  });

  it('every exemption states a reason', () => {
    const blank = SESSION_ID_TAKING_UNGATED_TOOLS.filter((e) => e.reason.trim().length === 0).map((e) => e.tool);
    expect(blank).toEqual([]);
  });
});
