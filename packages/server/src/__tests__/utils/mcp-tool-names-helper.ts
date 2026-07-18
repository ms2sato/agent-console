/**
 * Statically parses `mcp-server.ts` for every `mcpServer.tool('name', ...)`
 * registration. Used by `agent-operations-mcp.test.ts` /
 * `agent-operations-embedded.test.ts` to verify exposure-table `via` claims
 * name a tool that actually exists, instead of trusting a hand-maintained
 * duplicate list that could silently drift when a tool is renamed or
 * removed.
 *
 * Reads via `Bun.file()` rather than `node:fs` deliberately: sibling test
 * files in this package register process-global `mock.module('node:fs', …)`
 * memfs mocks (see `mock-fs-helper.ts`) that persist across test files
 * within the same `bun test` run. `Bun.file()` bypasses the `node:fs`
 * module entirely, so this helper reliably reads the real filesystem
 * regardless of test execution order.
 *
 * @example
 * ```typescript
 * import { getRegisteredMcpToolNames } from '../../__tests__/utils/mcp-tool-names-helper.js';
 *
 * const registeredNames = await getRegisteredMcpToolNames();
 * expect(registeredNames.has('list_agents')).toBe(true);
 * ```
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MCP_SERVER_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../mcp/mcp-server.ts',
);

const TOOL_REGISTRATION_RE = /mcpServer\.tool\(\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g;

/**
 * Reads the actual current source of `mcp-server.ts` and extracts every
 * literal MCP tool name registered via `mcpServer.tool('name', ...)`.
 */
export async function getRegisteredMcpToolNames(): Promise<Set<string>> {
  const source = await Bun.file(MCP_SERVER_SOURCE_PATH).text();
  const names = new Set<string>();
  for (const match of source.matchAll(TOOL_REGISTRATION_RE)) {
    names.add(match[1]);
  }
  return names;
}
