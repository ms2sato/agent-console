/**
 * Unit tests for `assertNoClaudeAuth` / `seedIsolatedClaudeConfig` (Issue
 * #2315 follow-up, R3). Real temp dirs under `os.tmpdir()`, cleaned in
 * `afterEach` -- deliberately not memfs: this helper's whole job is reading
 * real files a real caller will have written (`.credentials.json`,
 * `.claude.json`, `settings.json`), and it is consumed by a smoke script
 * that never loads `mock-fs-helper.ts`.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertNoClaudeAuth, seedIsolatedClaudeConfig, CLAUDE_AUTH_ENV_VARS } from '../isolated-claude-config.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'isolated-claude-config-test-'));
  cleanupPaths.push(dir);
  return dir;
}

describe('assertNoClaudeAuth', () => {
  it('(a) throws when a .credentials.json file exists in the config dir', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, '.credentials.json'), '{"fake":"token"}');

    expect(() => assertNoClaudeAuth(dir, {})).toThrow(/credentials file exists/);
  });

  it('(b) throws when an auth env var from CLAUDE_AUTH_ENV_VARS has a non-empty value', () => {
    const dir = freshDir();
    expect(CLAUDE_AUTH_ENV_VARS.length).toBeGreaterThan(0);

    expect(() => assertNoClaudeAuth(dir, { [CLAUDE_AUTH_ENV_VARS[0]]: 'leaked-value' })).toThrow(
      new RegExp(CLAUDE_AUTH_ENV_VARS[0]),
    );
  });

  it('(c) does not throw against a clean temp dir and a clean env', () => {
    const dir = freshDir();

    expect(() => assertNoClaudeAuth(dir, {})).not.toThrow();
  });

  it('an empty-string env var value is not treated as leaked (only a non-empty value is)', () => {
    const dir = freshDir();

    expect(() => assertNoClaudeAuth(dir, { [CLAUDE_AUTH_ENV_VARS[0]]: '' })).not.toThrow();
  });

  it('throws when the seeded .claude.json still carries a credential-shaped top-level key', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-leaked' }));

    expect(() => assertNoClaudeAuth(dir, {})).toThrow(/primaryApiKey/);
  });

  it('throws when settings.json carries an apiKeyHelper key', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/leak' }));

    expect(() => assertNoClaudeAuth(dir, {})).toThrow(/apiKeyHelper/);
  });

  // M8 (reported in the final verification): removing the
  // `.credentials.json` existence check from `assertNoClaudeAuth` would
  // make test (a) above go red. Measured by temporarily commenting out that
  // check's body in the source and re-running this file, per the comment-
  // out mutation-demonstration convention in `.claude/rules/testing.md`.
});

describe('seedIsolatedClaudeConfig', () => {
  it('strips a credential-shaped top-level key from the base config before writing the isolated copy', () => {
    const realHome = freshDir();
    const claudeConfigDir = freshDir();
    writeFileSync(path.join(realHome, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-should-not-survive', numStartups: 3 }));

    const prevHome = process.env.HOME;
    process.env.HOME = realHome;
    try {
      seedIsolatedClaudeConfig(claudeConfigDir, ['/some/worktree']);
    } finally {
      process.env.HOME = prevHome;
    }

    expect(() => assertNoClaudeAuth(claudeConfigDir, {})).not.toThrow();
  });

  it('pre-trusts every given project dir', () => {
    const claudeConfigDir = freshDir();
    mkdirSync(claudeConfigDir, { recursive: true });

    seedIsolatedClaudeConfig(claudeConfigDir, ['/a', '/b']);

    const written = JSON.parse(readFileSync(path.join(claudeConfigDir, '.claude.json'), 'utf-8'));
    expect(written.projects['/a']).toEqual({ hasTrustDialogAccepted: true });
    expect(written.projects['/b']).toEqual({ hasTrustDialogAccepted: true });
  });
});
