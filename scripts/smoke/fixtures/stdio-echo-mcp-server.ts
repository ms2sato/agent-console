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
 * Three jobs:
 *
 *   1. SPAWN CANARY. Touches `--canary <path>` immediately, before opening
 *      the stdio transport. A probe reading THAT FILE'S existence
 *      afterward gets ground truth that the underlying OS process was
 *      actually exec'd -- independent of whatever `system:init`'s
 *      `mcp_servers[].status` reports, which cannot by itself distinguish
 *      "the CLI decided not to even attempt this server" (native-load
 *      scope filtered it out before spawn) from any other blocked/absent
 *      shape (see the calling probe's header for why that distinction is
 *      load-bearing for its arms). This file is RESET (deleted and
 *      re-touched) by the caller before each session that tests a given
 *      server, so it answers "did THIS session's attempt spawn the
 *      process" -- it is not a durable record across the whole run.
 *
 *   2. SPAWN LEDGER (Architect ruling, PR #1782, CodeRabbit M1). `--ledger
 *      <path>` is a SEPARATE, APPEND-ONLY file (never truncated by this
 *      fixture or by the caller across a run) that every spawned instance
 *      appends exactly one line to, before opening the transport:
 *      `<pid>\t<starttime>\t<serverName>\t<iso-timestamp>\n`. `serverName`
 *      is derived from the canary path's own basename (stripping the
 *      `.touched` suffix), and `starttime` is this process's own
 *      `/proc/self/stat` starttime field (see `proc-stat.ts`) -- the value
 *      teardown's identity check (job 3 below, in the CALLING probe) later
 *      re-reads from `/proc/<pid>/stat` and compares, so a PID that the OS
 *      reassigned to an unrelated process after this one exited can never
 *      be mistaken for a survivor of this run. The `.touched` canary above
 *      answers "did the LATEST session's attempt spawn something"; this
 *      ledger answers "every process THIS RUN ever spawned, so a sweep can
 *      find one that outlived the session that spawned it even if a LATER
 *      session's reset already overwrote that server's own canary file."
 *
 *   3. ECHO TOOL. Registers one tool, `probe_echo`, that reports this
 *      process's own `argv` and one named environment variable back to the
 *      caller. The `argv` echo is what a settingSources-array-expansion
 *      question (does the CLI expand `${VAR}` inside a declared server's
 *      `args` before spawning, or pass it through literally?) is measured
 *      with: whatever string shows up in the reported argv IS what actually
 *      reached this process, without relying on any assumption about the
 *      CLI's own expansion behavior.
 *
 * Usage: bun scripts/smoke/fixtures/stdio-echo-mcp-server.ts --canary <path> --ledger <path> [--env-var <NAME>]
 *   --canary <path>    Required. Touched (created, zero-length is fine) at
 *                       startup, before the transport connects.
 *   --ledger <path>    Required. One line APPENDED at startup (never
 *                       truncated), before the transport connects.
 *   --env-var <NAME>   Optional, default PROBE_MCP_ECHO_VAR. The single
 *                       named env var whose value (or null if unset) is
 *                       included in the tool's response.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { McpServer } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../../packages/embedded-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { parseProcStatStarttime } from './proc-stat.js';

const DEFAULT_ENV_VAR = 'PROBE_MCP_ECHO_VAR';

interface FixtureArgs {
  canaryPath: string;
  ledgerPath: string;
  envVarName: string;
}

function parseFixtureArgs(argv: string[]): FixtureArgs {
  let canaryPath: string | null = null;
  let ledgerPath: string | null = null;
  let envVarName = DEFAULT_ENV_VAR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--canary') {
      canaryPath = argv[++i] ?? null;
    } else if (argv[i] === '--ledger') {
      ledgerPath = argv[++i] ?? null;
    } else if (argv[i] === '--env-var') {
      envVarName = argv[++i] ?? envVarName;
    }
  }
  if (!canaryPath) {
    throw new Error('stdio-echo-mcp-server: --canary <path> is required');
  }
  if (!ledgerPath) {
    throw new Error('stdio-echo-mcp-server: --ledger <path> is required');
  }
  return { canaryPath, ledgerPath, envVarName };
}

/** `/proc/self/stat` is Linux-only; a non-Linux run records an empty starttime field (the caller's identity check treats that as unverifiable, never as a match). */
function readOwnStarttime(): string {
  if (process.platform !== 'linux') return '';
  try {
    return parseProcStatStarttime(readFileSync('/proc/self/stat', 'utf8')) ?? '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const { canaryPath, ledgerPath, envVarName } = parseFixtureArgs(process.argv.slice(2));
  const serverName = basename(canaryPath).replace(/\.touched$/, '');

  // Touched BEFORE the transport connects: a probe must be able to observe
  // "this process was exec'd" even if the MCP handshake never completes
  // (e.g. the client disconnects early, or the tool is never called).
  writeFileSync(canaryPath, `${process.pid}\n${new Date().toISOString()}\n`);

  // Appended, never truncated -- see this file's own header, job 2.
  const starttime = readOwnStarttime();
  appendFileSync(ledgerPath, `${process.pid}\t${starttime}\t${serverName}\t${new Date().toISOString()}\n`);

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
