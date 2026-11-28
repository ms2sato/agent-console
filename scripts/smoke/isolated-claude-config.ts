/**
 * Shared library (Issue #2315 follow-up, R3) for a smoke that needs to spawn
 * a real, interactive `claude` CLI PTY without ever reaching real billing or
 * a real account. Two things, used together by a caller:
 *
 *   1. `seedIsolatedClaudeConfig` -- build an isolated `CLAUDE_CONFIG_DIR`
 *      pre-trusting a set of worktree paths (bypassing the interactive
 *      "Do you trust the files in this folder?" prompt a brand-new worktree
 *      would otherwise trip, the same mechanism `check-webhook-issue-label-
 *      routing.ts` / `check-mcp-pause-resume.ts` already use inline), with
 *      any credential-shaped field stripped from the copy before it is
 *      written.
 *   2. `assertNoClaudeAuth` -- a fail-closed check: throws if the seeded
 *      config directory or a given child environment still carries any
 *      Claude Code credential, so a caller can refuse to spawn the real
 *      server (and therefore the real PTYs) rather than silently risk a
 *      real, billed turn. The caller maps a thrown error to a harness
 *      failure (exit 2), not an assertion failure -- this is a precondition
 *      check, not something the smoke is trying to prove true or false.
 *
 * NOT an entry point (`test-trigger.md`'s "Exceptions to the reachability
 * rule"): it has no top-level entry-point guard and no `main()`, and
 * running it directly does nothing. It is a shared library, reachable
 * through its consumer, `check-mcp-pause-resume.ts`.
 *
 * Deliberately NOT wired into `check-webhook-issue-label-routing.ts` --
 * that migration is tracked separately as Issue #2317.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Every environment variable through which Claude Code can authenticate or
 * route to a billed provider, per
 * https://code.claude.com/docs/en/env-vars.md. Exported so a caller can
 * reuse the same list to strip these from a child's spawn `env` before
 * calling {@link assertNoClaudeAuth} to verify the strip worked.
 */
export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
] as const;

/** Case-insensitive match for a credential-shaped top-level key (e.g. `primaryApiKey`). */
const API_KEY_FIELD_RE = /apikey/i;

function stripApiKeyFields(config: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (API_KEY_FIELD_RE.test(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * Build an isolated `CLAUDE_CONFIG_DIR` at `claudeConfigDir`, seeded from a
 * read-only copy of the invoking OS user's real `~/.claude.json` (never a
 * mutation of the real file) with `projects` entries pre-trusting
 * `trustedProjectDirs`, and any credential-shaped top-level field (matching
 * `apikey`, case-insensitive -- e.g. `primaryApiKey`) stripped before the
 * copy is written. `claudeConfigDir` is created (mode 0700) if it does not
 * already exist; the written `.claude.json` is mode 0600.
 */
export function seedIsolatedClaudeConfig(claudeConfigDir: string, trustedProjectDirs: string[]): void {
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });

  const realClaudeConfigPath = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '',
    '.claude.json',
  );
  let baseClaudeConfig: Record<string, unknown> = {};
  try {
    baseClaudeConfig = JSON.parse(readFileSync(realClaudeConfigPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No real ~/.claude.json (or it is unreadable) -- proceed with an empty base.
  }

  const projectsBase = (baseClaudeConfig.projects ?? {}) as Record<string, unknown>;
  const isolatedConfig: Record<string, unknown> = {
    ...stripApiKeyFields(baseClaudeConfig),
    projects: {
      ...projectsBase,
      ...Object.fromEntries(trustedProjectDirs.map((dir) => [dir, { hasTrustDialogAccepted: true }])),
    },
  };

  const claudeConfigPath = path.join(claudeConfigDir, '.claude.json');
  writeFileSync(claudeConfigPath, JSON.stringify(isolatedConfig), { mode: 0o600 });
}

/**
 * Throws if any Claude Code credential is reachable from the isolated
 * config directory a prior {@link seedIsolatedClaudeConfig} call built, or
 * from `childEnv` (the environment a caller is about to spawn a child
 * process with). The caller maps a thrown error to a harness failure (exit
 * 2), not an assertion failure -- this check runs BEFORE the thing it
 * guards is spawned, so a failure here means the run never attempted the
 * thing it was trying to keep free, not that the thing it was trying to
 * keep free turned out not to be.
 */
export function assertNoClaudeAuth(claudeConfigDir: string, childEnv: Record<string, string | undefined>): void {
  const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
  if (existsSync(credentialsPath)) {
    throw new Error(`assertNoClaudeAuth: a credentials file exists at ${credentialsPath}`);
  }

  const claudeConfigPath = path.join(claudeConfigDir, '.claude.json');
  if (existsSync(claudeConfigPath)) {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`assertNoClaudeAuth: failed to parse ${claudeConfigPath}: ${String(err)}`);
    }
    const leakedKeys = Object.keys(config).filter((key) => API_KEY_FIELD_RE.test(key));
    if (leakedKeys.length > 0) {
      throw new Error(
        `assertNoClaudeAuth: ${claudeConfigPath} still carries credential-shaped key(s): ${leakedKeys.join(', ')}`,
      );
    }
  }

  const settingsPath = path.join(claudeConfigDir, 'settings.json');
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`assertNoClaudeAuth: failed to parse ${settingsPath}: ${String(err)}`);
    }
    if ('apiKeyHelper' in settings) {
      throw new Error(`assertNoClaudeAuth: ${settingsPath} carries an apiKeyHelper key`);
    }
  }

  const leakedEnvVars = CLAUDE_AUTH_ENV_VARS.filter((name) => {
    const value = childEnv[name];
    return typeof value === 'string' && value.length > 0;
  });
  if (leakedEnvVars.length > 0) {
    throw new Error(`assertNoClaudeAuth: the child environment still carries: ${leakedEnvVars.join(', ')}`);
  }
}
