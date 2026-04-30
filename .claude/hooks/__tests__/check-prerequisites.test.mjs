import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '..', 'check-prerequisites.sh');

function runHook({ env } = {}) {
  return spawnSync('/bin/bash', [HOOK], {
    encoding: 'utf-8',
    env: env ?? process.env,
  });
}

describe('check-prerequisites: jq prerequisite (Issue #730)', () => {
  it('exits 0 silently when jq is on PATH (happy path)', () => {
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('exits non-zero with actionable diagnostic when jq is NOT on PATH', () => {
    const r = runHook({ env: { PATH: '/nonexistent', HOME: process.env.HOME ?? '' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/jq/);
    expect(r.stderr).toMatch(/enforce-permissions\.sh/);
    expect(r.stderr).toMatch(/brew install jq/);
    expect(r.stderr).toMatch(/apt-get install jq/);
  });

  it('exits non-zero with diagnostic when PATH is empty', () => {
    const r = runHook({ env: { PATH: '', HOME: process.env.HOME ?? '' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/jq/);
  });
});
