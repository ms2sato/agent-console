import { describe, it, expect } from 'bun:test';
import { EXPECTED_ROOT_ENTRIES, buildFixtureScript } from '../check-file-viewer-elevated-read.js';

describe('check-file-viewer-elevated-read helpers', () => {
  it('expects directories first, then plain byte-order names (the order the service documents)', () => {
    const dirs = EXPECTED_ROOT_ENTRIES.filter((e) => e.kind === 'dir');
    const rest = EXPECTED_ROOT_ENTRIES.filter((e) => e.kind !== 'dir');
    expect(EXPECTED_ROOT_ENTRIES.slice(0, dirs.length)).toEqual(dirs);
    const names = rest.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('expects exactly the entries the fixture script creates', () => {
    const script = buildFixtureScript('/tmp/x');
    for (const { name } of EXPECTED_ROOT_ENTRIES) {
      expect(script).toContain(name);
    }
  });

  it('builds a script for `sh -s` stdin: starts failing fast, makes the 0700 directory, ends with a newline', () => {
    const script = buildFixtureScript('/tmp/agent-console-fv-smoke-abc');
    expect(script.startsWith('set -e\n')).toBe(true);
    expect(script).toContain("mkdir -m 700 '/tmp/agent-console-fv-smoke-abc'");
    expect(script.endsWith('\n')).toBe(true);
  });
});
