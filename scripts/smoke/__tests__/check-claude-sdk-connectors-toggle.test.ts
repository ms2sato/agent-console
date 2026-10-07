import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import {
  parseArgs,
  hasConnectorScope,
  hasServerNamed,
  type DiscoveredServer,
} from '../check-claude-sdk-connectors-toggle.js';

/**
 * Pure-function tests for `check-claude-sdk-connectors-toggle.ts`.
 * Never runs `main()` -- no `AppContext`, no `/api`, no real `PATCH`
 * request, no billed turn. This is the Q13 "proxy verification" discipline
 * `test-trigger.md` documents for every billable smoke in that file: it
 * verifies the WIRING (argument parsing, the classifier the script's
 * assertions key on) is correct, without the billable chain it sits
 * upstream of.
 */

describe('check-claude-sdk-connectors-toggle smoke: parseArgs', () => {
  it('defaults expectConnectorsPresent to false with no flags', () => {
    expect(parseArgs([])).toEqual({ expectConnectorsPresent: false });
  });

  it('sets expectConnectorsPresent on --expect-connectors-present', () => {
    expect(parseArgs(['--expect-connectors-present'])).toEqual({ expectConnectorsPresent: true });
  });

  it('tolerates a leading -- separator', () => {
    expect(parseArgs(['--', '--expect-connectors-present'])).toEqual({ expectConnectorsPresent: true });
  });

  it('exits 2 with a usage error for an unknown flag (real subprocess)', () => {
    const scriptPath = path.join(import.meta.dir, '../check-claude-sdk-connectors-toggle.ts');
    const proc = Bun.spawnSync([process.execPath, scriptPath, '--bogus'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('unknown flag: --bogus');
  });
});

const connector: DiscoveredServer = { name: 'gdrive', scope: 'connector', status: 'connected' };
const reserved: DiscoveredServer = { name: 'agent-console', scope: 'reserved', status: 'connected' };
const compactTool: DiscoveredServer = { name: 'console', scope: 'reserved', status: 'connected' };
const project: DiscoveredServer = { name: 'chrome-devtools', scope: 'project', status: 'connected' };

describe('check-claude-sdk-connectors-toggle smoke: hasConnectorScope', () => {
  it('detects a scope:"connector" row among others', () => {
    expect(hasConnectorScope([reserved, connector, project])).toBe(true);
  });

  it('returns false when no row has scope:"connector"', () => {
    expect(hasConnectorScope([reserved, compactTool, project])).toBe(false);
  });

  it('returns false on an empty array', () => {
    expect(hasConnectorScope([])).toBe(false);
  });
});

describe('check-claude-sdk-connectors-toggle smoke: hasServerNamed', () => {
  it('finds a row by name regardless of scope', () => {
    expect(hasServerNamed([reserved, connector], 'agent-console')).toBe(true);
    expect(hasServerNamed([reserved, compactTool], 'console')).toBe(true);
  });

  it('returns false for an absent name', () => {
    expect(hasServerNamed([reserved, connector], 'not-present')).toBe(false);
  });

  it('returns false on an empty array', () => {
    expect(hasServerNamed([], 'agent-console')).toBe(false);
  });
});
