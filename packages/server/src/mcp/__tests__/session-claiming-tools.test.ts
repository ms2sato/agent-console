/**
 * Reverse-direction guard for `SESSION_CLAIMING_TOOLS`: parses `mcp-server.ts`
 * by `mcpServer.tool(` registration and asserts the set of registrations whose
 * block calls `checkCallerOwnsSession(` equals the registry exactly. The
 * forward direction (an unlisted name passed to the gate) is a compile error
 * pinned in `mcp-auth.test.ts`.
 *
 * Positive controls come first: an empty or broken parse would otherwise make
 * "no missing, no extra" trivially true.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_CLAIMING_TOOLS } from '../session-claiming-tools.js';

const SOURCE = fs.readFileSync(path.join(import.meta.dir, '..', 'mcp-server.ts'), 'utf8');

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
