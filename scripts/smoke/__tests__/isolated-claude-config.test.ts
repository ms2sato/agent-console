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

  // CodeRabbit (PR #2320, isolated-claude-config.ts:39): the federation
  // credential variables (ANTHROPIC_FEDERATION_RULE_ID,
  // ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_IDENTITY_TOKEN_FILE) must be
  // stripped and caught the same way as any other entry in
  // CLAUDE_AUTH_ENV_VARS.
  it('throws when ANTHROPIC_FEDERATION_RULE_ID (a federation credential, not just an API key) is present', () => {
    const dir = freshDir();
    expect(CLAUDE_AUTH_ENV_VARS).toContain('ANTHROPIC_FEDERATION_RULE_ID');

    expect(() => assertNoClaudeAuth(dir, { ANTHROPIC_FEDERATION_RULE_ID: 'rule-123' })).toThrow(
      /ANTHROPIC_FEDERATION_RULE_ID/,
    );
  });

  // CodeRabbit follow-up (owner-approved, PR #2320): the same WIF credential
  // set also includes ANTHROPIC_SERVICE_ACCOUNT_ID and the literal-JWT form
  // ANTHROPIC_IDENTITY_TOKEN (sibling of ANTHROPIC_IDENTITY_TOKEN_FILE). The
  // mechanism is already covered by the test above; one assertion that
  // either new name is caught is enough.
  it('throws when ANTHROPIC_SERVICE_ACCOUNT_ID (the remaining WIF credential name) is present', () => {
    const dir = freshDir();
    expect(CLAUDE_AUTH_ENV_VARS).toContain('ANTHROPIC_SERVICE_ACCOUNT_ID');
    expect(CLAUDE_AUTH_ENV_VARS).toContain('ANTHROPIC_IDENTITY_TOKEN');

    expect(() => assertNoClaudeAuth(dir, { ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa-123' })).toThrow(
      /ANTHROPIC_SERVICE_ACCOUNT_ID/,
    );
  });

  // CodeRabbit (PR #2320, isolated-claude-config.ts:153): settings.json can
  // supply auth values via its own `env` object, not just `apiKeyHelper`;
  // this must be caught using the SAME CLAUDE_AUTH_ENV_VARS list the
  // childEnv check uses, not a hardcoded single key.
  it("throws when settings.json's env object carries a leaked CLAUDE_AUTH_ENV_VARS entry", () => {
    const dir = freshDir();
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-leaked-via-settings-env' } }),
    );

    expect(() => assertNoClaudeAuth(dir, {})).toThrow(/env object still carries.*ANTHROPIC_API_KEY/);
  });

  it("does not throw when settings.json's env object is absent or carries no auth key", () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { SOME_OTHER_VAR: 'fine' } }));

    expect(() => assertNoClaudeAuth(dir, {})).not.toThrow();
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
