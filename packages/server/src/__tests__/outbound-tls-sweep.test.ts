/**
 * Sweep pin: every outbound-TLS-capable call in the server and the
 * embedded-agent loop goes through the two `outbound-tls` helpers, so the
 * OS CA bundle governs it. A new bare `fetch(`, `node:https`, `node:tls`,
 * client `WebSocket` or `Bun.connect` (or a new MCP client transport) fails
 * here and names the file; the author either routes it through the helper or
 * records why it cannot take a `ca` by adding it to ALLOWLIST with a reason.
 *
 * Uses `grep` via `Bun.spawn`, never `fs` (memfs may be active in this
 * process; see real-fs-invocation.test.ts for the same rationale).
 *
 * Polarity, measured 2026-10-24: adding a bare `fetch('https://x')` line to
 * packages/server/src/lib/path-validator.ts fails the "no unrouted outbound
 * TLS call sites" test naming that file; removing it restores green.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__ -> packages
const PACKAGES_ROOT = join(__dirname, '..', '..', '..');

const SCAN_DIRS = ['server/src', 'embedded-agent/src'];

/** Calls that open an outbound TLS-capable connection from our own code. */
const OUTBOUND_PATTERN =
  "\\bfetch\\(|node:https|node:tls|from 'https'|from 'tls'|new WebSocket\\(|Bun\\.connect|StreamableHTTPClientTransport\\(|SSEClientTransport\\(|WebSocketClientTransport\\(";

/** path (relative to packages/) -> why it may contain a match. */
const ALLOWLIST: Record<string, string> = {
  'server/src/lib/outbound-tls.ts': 'the server helper itself: the one place that calls fetch with tls.ca',
  'embedded-agent/src/outbound-tls.ts': 'the loop helper itself: the one place that calls fetch with tls.ca',
  'embedded-agent/src/mcp.ts':
    'StreamableHTTPClientTransport to our own MCP server over plain http on localhost (getMcpBaseUrl); no TLS to verify',
};

async function findCandidateFiles(): Promise<string[]> {
  const proc = Bun.spawn(
    [
      'grep', '-rlE', '--include=*.ts', '--include=*.tsx',
      '--exclude=*.test.ts', '--exclude=*.test.tsx', '--exclude-dir=__tests__',
      OUTBOUND_PATTERN, ...SCAN_DIRS,
    ],
    { cwd: PACKAGES_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode > 1) {
    throw new Error(`grep failed (exit ${exitCode}): ${await new Response(proc.stderr).text()}`);
  }
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('outbound TLS sweep', () => {
  it('no unrouted outbound TLS call sites outside the allowlisted helpers', async () => {
    const offenders = (await findCandidateFiles()).filter((f) => !(f in ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it('positive control: the scan sees the allowlisted files (the instrument can see)', async () => {
    const found = await findCandidateFiles();
    for (const allowed of Object.keys(ALLOWLIST)) {
      expect(found).toContain(allowed);
    }
  });
});
