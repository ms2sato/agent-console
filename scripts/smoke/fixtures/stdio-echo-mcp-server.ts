#!/usr/bin/env bun
/**
 * Reusable stdio MCP server fixture for the settingSources/managedSettings
 * probe (Issue #1781) and the later PR-3 declared-MCP smoke it is explicitly
 * carried forward for. NOT a `scripts/smoke/*` entry point itself -- it lives
 * under `fixtures/` (outside the `scripts/smoke/*.{ts,mjs}` glob both
 * `registry-reachability.test.ts` and `import-safety.test.ts` scan) because
 * it is never imported by another script and never run as a smoke in its
 * own right; it is only ever spawned as a CHILD PROCESS by a `claude` CLI
 * session, over stdio, exactly like a real declared MCP server.
 *
 * Two jobs:
 *
 *   1. SPAWN CANARY. Touches `--canary <path>` immediately, before opening
 *      the stdio transport, writing `process.pid` as the file's first line
 *      (Architect finding, PR #1782: the calling probe's teardown claims a
 *      PID-based orphan check but the file originally carried only a
 *      timestamp, nothing parseable as a PID). A probe reading THAT FILE'S
 *      existence afterward gets ground truth that the underlying OS process
 *      was actually exec'd -- independent of whatever `system:init`'s
 *      `mcp_servers[].status` reports, which cannot by itself distinguish
 *      "the CLI decided not to even attempt this server" (native-load scope
 *      filtered it out before spawn) from any other blocked/absent shape
 *      (see the calling probe's header for why that distinction is
 *      load-bearing for its arms); the SAME file's first line now also lets
 *      the caller verify the spawned process does not outlive teardown.
 *
 *   2. ECHO TOOL. Registers one tool, `probe_echo`, that reports this
 *      process's own `argv` and one named environment variable back to the
 *      caller. The `argv` echo is what a settingSources-array-expansion
 *      question (does the CLI expand `${VAR}` inside a declared server's
 *      `args` before spawning, or pass it through literally?) is measured
 *      with: whatever string shows up in the reported argv IS what actually
 *      reached this process, without relying on any assumption about the
 *      CLI's own expansion behavior.
 *
 * Usage: bun scripts/smoke/fixtures/stdio-echo-mcp-server.ts --canary <path> [--env-var <NAME>]
 *   --canary <path>    Required. Touched (created, zero-length is fine) at
 *                       startup, before the transport connects.
 *   --env-var <NAME>   Optional, default PROBE_MCP_ECHO_VAR. The single
 *                       named env var whose value (or null if unset) is
 *                       included in the tool's response.
 */

import { writeFileSync } from 'node:fs';
import { McpServer } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';

const DEFAULT_ENV_VAR = 'PROBE_MCP_ECHO_VAR';

interface FixtureArgs {
  canaryPath: string;
  envVarName: string;
}

function parseFixtureArgs(argv: string[]): FixtureArgs {
  let canaryPath: string | null = null;
  let envVarName = DEFAULT_ENV_VAR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--canary') {
      canaryPath = argv[++i] ?? null;
    } else if (argv[i] === '--env-var') {
      envVarName = argv[++i] ?? envVarName;
    }
  }
  if (!canaryPath) {
    throw new Error('stdio-echo-mcp-server: --canary <path> is required');
  }
  return { canaryPath, envVarName };
}

async function main(): Promise<void> {
  const { canaryPath, envVarName } = parseFixtureArgs(process.argv.slice(2));

  // Touched BEFORE the transport connects: a probe must be able to observe
  // "this process was exec'd" even if the MCP handshake never completes
  // (e.g. the client disconnects early, or the tool is never called). The
  // PID on its own first line is what teardown's orphan check parses; the
  // timestamp on line two is diagnostic only.
  writeFileSync(canaryPath, `${process.pid}\n${new Date().toISOString()}\n`);

  const server = new McpServer({ name: 'stdio-echo', version: '0.0.0-probe' });
  server.registerTool(
    'probe_echo',
    { description: 'Probe fixture: reports this process argv and one named env var. Not for real use.' },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ argv: process.argv, envVarName, envValue: process.env[envVarName] ?? null }),
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('stdio-echo-mcp-server failed:', err);
    process.exit(1);
  });
}
