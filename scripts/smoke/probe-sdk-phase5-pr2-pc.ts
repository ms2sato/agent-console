#!/usr/bin/env bun
/**
 * P-c premise measurement for epic #1636 Phase 5 PR-2 (Issue #1785), the
 * `claude-sdk` engine's `.mcp.json` discovery/permission machinery
 * (`docs/design/embedded-agent-sdk-engine.md` §4.5's design II, D-F). This is
 * a SIBLING of `probe-sdk-phase5-pr2-premises.ts` (P-a/P-b), not an extension
 * of it -- P-a/P-b measure the SDK's own `Query` behavior via the
 * `ProbeSession` harness (a direct `query()` construction); P-c measures the
 * PRODUCTION shipping path itself: a real `claude-sdk` embedded-agent worker
 * spawned by the real `EmbeddedAgentWorkerService.activate`, through a real
 * disposable `AppContext`, exactly the pattern
 * `check-embedded-agent-idle-eviction.ts` uses. Forcing this into the
 * `ProbeSession` abstraction would be awkward -- there is no `Query` object
 * here to hold, only a subprocess and its NDJSON stream.
 *
 * WHAT THIS MEASURES. `applyArgSubstitution` (mcp-discovery.ts) exists
 * because §4.5 D-F measured (arm G / probe-sdk-mcp-settings-sources.ts) that
 * the CLI itself expands `${VAR}` for a declared server's `env` but NOT for
 * `args` -- our loader fills that gap for `args` only. This script measures,
 * end to end through the real subprocess boundary:
 *
 *   - For a SET var (`PROBE_VAR`, set in the server process's own
 *     environment before activation -- the NON-ELEVATED branch only): does
 *     the CLI's native expansion deliver the real value into the fixture's
 *     reported `env`? Does our loader's substitution deliver the same real
 *     value into the fixture's reported `args`?
 *   - For an UNSET var (`PROBE_UNSET`, deliberately never set): does the CLI
 *     leave `env` empty/literal? Does our loader leave the `args` placeholder
 *     LITERAL (never throwing) per `applyArgSubstitution`'s documented
 *     unset-with-no-default behavior?
 *
 * Both channels are read from ONE tool call's response per fixture server --
 * the fixture's `probe_echo` tool reports its own `process.argv` (proves
 * what our loader put into `args`) and one named env var's value (proves
 * what the CLI put into `env`) in a single JSON payload, read directly off
 * the worker's persisted `tool-result` event, never inferred from the
 * model's prose.
 *
 * TWO FIXTURE SERVERS, not one, because the shared `stdio-echo-mcp-server.ts`
 * fixture only echoes ONE named env var per instance (`--env-var NAME`):
 * `probe-pc-fixture` references `${PROBE_VAR}` (SET case) in both its `args`
 * and `env`; `probe-pc-fixture-unset` references `${PROBE_UNSET}` (UNSET
 * case, the Issue's own "Control") the same way. Both are seeded as `allow`
 * rows through the REAL `McpServerPermissionRepository`, hashed via the REAL
 * `discoverProjectMcpServers` against the real `.mcp.json` this script
 * writes -- never hand-computed.
 *
 * TWO ARMS, ONE PROCESS INVOCATION EACH (Issue #1799). Run with no arguments
 * for the NON-ELEVATED branch above (billable, one real turn). Run with
 * `--elevated <target-user>` for the ELEVATED branch: does a login shell's
 * profile, rather than the server process's own environment, supply the
 * value under `sudo -u <user> -i`? That arm is TURN-FREE -- it never sends a
 * user message -- because the observable it needs (each fixture's `argv` and
 * named env var) is read from the fixture's own `--spawn-report` file
 * (`fixtures/stdio-echo-mcp-server.ts` job 4), written at spawn time, before
 * any model turn could exist. The elevated arm's reading is licensed by the
 * non-elevated arm's own same-run positive control (below): a run has shown
 * the spawn report and the tool-result reading are byte-equal, so reading
 * the elevated arm from the spawn report alone stands in for the tool-result
 * observable the elevated arm has no turn to produce. Every printed reading
 * is prefixed with its arm (NON-ELEVATED or ELEVATED); the two arms never
 * run in the same process invocation, so neither can be reported as "not
 * reached" by the OTHER arm's own run.
 *
 * A CLI FACT, NOT A HARNESS QUIRK: `ready` does not imply every declared
 * project MCP server has finished connecting. `ready` (`sdk-engine.ts`) means
 * the engine constructed the SDK query and started its consumer; it is NOT
 * gated on the CLI's own `system:init`, which does not arrive until the
 * FIRST PROMPT is sent -- so `ready` fires essentially immediately, before
 * the CLI has necessarily finished (or even started reporting on) its
 * connections to `.mcp.json`-declared servers. Measured directly (both in a
 * free, local degenerate-mode dry run and in the real tier-2 container):
 * `ready` -> fixture spawn report, WITH NO PROMPT SENT, observed lag roughly
 * 1.5-3.2s. This is a property of the `claude` CLI's own startup sequencing,
 * not an artifact of this script's harness, and any future reader of the
 * elevated arm's boundary-detection code should read it as such. The
 * elevated arm's grace-window poll (below) exists because of this fact.
 *
 * ISOLATION FROM THE OPERATOR'S REAL `~/.claude.json` (Issue 1813). Observed
 * 2026-09-22 (a prompted run of this same non-elevated arm, recorded on
 * Issue 1799): before this isolation existed, the `system:init` form-(b)
 * `mcp-servers-discovered` event reported the operator's own user-scope MCP
 * servers and claude.ai connectors, spawned/connected as a side effect of a
 * measurement that has nothing to do with them. This script now adopts the
 * same `isolateClaudeConfigDir` + `{}` `.claude.json` construction
 * `check-embedded-agent-project-mcp-permission.ts`'s negative control (c)
 * uses: a throwaway `CLAUDE_CONFIG_DIR` holding only a copy of the
 * operator's own credentials (so the `claude` CLI can still authenticate),
 * with `.claude.json` written as a genuinely-empty `{}` rather than left
 * absent (an absent file makes `readUserLocalMcpNames` report
 * `unavailable: true`, which would make this isolation check untestable --
 * see that file's own comment). The turn this script sends is what makes
 * `system:init` -- and therefore the form-(b) event this isolation check
 * reads -- fire at all (`sdk-engine.ts`'s own comments: zero events of any
 * kind arrive from the SDK until the first prompt is yielded).
 *
 * LIMITATION, RULED (Architect, Issue 1813): this isolation covers only the
 * `user`/`local` FILE channel (`.claude.json`); claude.ai connectors ride on
 * the copied CREDENTIALS rather than on that file, so they still appear in
 * the discovered event and are accepted here as the executing user's own
 * capability surface under `docs/design/embedded-agent-sdk-engine.md`
 * section 4.1's TUI parity -- the only suppressor is the construction-time
 * `Options.settings.disableClaudeAiConnectors`, which `SdkEngine.buildOptions()`
 * does not expose on this shipping path. Their presence is therefore a
 * RECORDED reading below, never a gated assertion.
 *
 * STDERR WARNING OBSERVABILITY (best-effort, not gated). `applyArgSubstitution`
 * logs one `console.warn` per unresolved placeholder inside the embedded-agent
 * SUBPROCESS -- there is no public getter for a live worker's stderr tail
 * (`embedded-agent-worker-service.ts`'s `runtime.stderrTail` is internal and
 * only surfaced on an UNEXPECTED exit, which this script's graceful
 * deactivate never produces). This script sets `LOG_LEVEL=debug` before the
 * server boots so the subprocess's piped stderr is logged via pino at debug
 * level, which -- absent a custom pino transport -- lands on this process's
 * own stdout/stderr and is therefore visible in the full console capture a
 * human reviews. This is NOT a structural observation the script's own exit
 * code depends on: if pino's destination or format differs on a given build,
 * the warning simply will not appear in the capture, and that limitation is
 * stated rather than a presence/absence being fabricated.
 *
 * VERDICT / EXIT CODES (`PROBE_EXIT`), same convention as the sibling P-a/P-b
 * file, for BOTH arms: 0 = MEASURED (non-elevated: both fixtures' tool calls
 * completed and their JSON payload was read; elevated: both spawn reports
 * appeared and the control fixture's shape matched -- regardless of what the
 * SET fixture's values turned out to be, a clean measurement is a success
 * even if a reading deviates from expectation, which is then a finding to
 * report, not a script failure); 1 = INCONCLUSIVE (non-elevated: a turn
 * never settled, a tool call never happened, or its JSON payload could not
 * be parsed; elevated: exactly one of the two spawn reports appeared, or the
 * control fixture disagreed with the non-elevated arm's own control shape);
 * 2 = HARNESS (non-elevated: activation failed; elevated: outcome (ii),
 * neither spawn report appeared within the gate's timeout).
 *
 * Requirements (non-elevated branch): a real, authenticated `claude` CLI
 * session for the invoking OS user; `bun install` already run; `git` on PATH
 * (for the throwaway repository's `.git`, needed by
 * `RepositoryManager.registerRepository`). BILLABLE -- one real turn, well
 * under $1.
 *
 * Requirements (--elevated <target-user> branch): elevation privilege for
 * <target-user> (a real OS user); `AUTH_MODE=multi-user` is forced on by
 * this arm. FREE and TURN-FREE -- no `claude` CLI login is needed for
 * <target-user>, no model turn is ever sent; this is exactly what item 4's
 * "free gate" measures (does the CLI start its declared MCP servers without
 * one?). See `.claude/rules/test-trigger.md`'s section for this probe for
 * the gate's two outcomes.
 *
 * A manual gate, never a CI job; registered in `.claude/rules/test-trigger.md`.
 *
 * Usage:
 *   bun scripts/smoke/probe-sdk-phase5-pr2-pc.ts                      # non-elevated (billable)
 *   bun scripts/smoke/probe-sdk-phase5-pr2-pc.ts --elevated <target-user>  # elevated (free, turn-free)
 */

// --- CRITICAL ordering, same hazard as check-embedded-agent-idle-eviction.ts
// and probe-sdk-phase5-pr2-premises.ts's sibling: `serverConfig` computes its
// values at MODULE-LOAD time, so every env var this script sets (LOG_LEVEL,
// AGENT_CONSOLE_HOME, PROBE_VAR) must be assigned before any module that
// transitively imports server-config.ts is evaluated. Every such import
// below is therefore a DYNAMIC import made from inside main().

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// mcp-discovery.ts, mcp-names.ts, and probe-sdk-session-harness.ts are
// standalone (no transitive server-config.ts import), so they are safe as
// ordinary static imports -- unlike everything under packages/server/src,
// which is deferred below. `lib/config.ts` (NOT `lib/server-config.ts`, a
// different file) only imports `node:path`/`node:os`, so it is safe here too.
import { discoverProjectMcpServers } from '../../packages/embedded-agent/src/mcp-discovery.js';
import { mcpServerOf } from '../../packages/embedded-agent/src/mcp-names.js';
import { getConfigDir } from '../../packages/server/src/lib/config.js';
import {
  isolateClaudeConfigDir,
  snapshotIsolationEvidence,
  verifyIsolationStrict,
} from './probe-sdk-session-harness.js';
// No transitive server-config.ts import (pure node:fs/promises + node:os +
// node:path), so this is safe as a static import above the env-var prelude,
// the same reasoning check-embedded-agent-elevation.ts documents for its own
// use of this helper.
import { createDisposableMultiUserHome } from './disposable-multi-user-home.js';
import type { AppContext } from '../../packages/server/src/app-context.js';

const PROBE_VAR_NAME = 'PROBE_VAR';
const PROBE_UNSET_NAME = 'PROBE_UNSET';
const PROBE_VAR_VALUE = `probe-pc-value-${Math.floor(Math.random() * 900000 + 100000)}`;

const SET_SERVER_NAME = 'probe-pc-fixture';
const UNSET_SERVER_NAME = 'probe-pc-fixture-unset';

const failures: string[] = [];
let passes = 0;

function expect(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const PROBE_EXIT = {
  MEASURED: 0,
  INCONCLUSIVE: 1,
  HARNESS: 2,
} as const;

interface FixtureReading {
  serverName: string;
  varName: string;
  canaryPath: string;
  ledgerPath: string;
  reportPath: string;
  toolCallSeen: boolean;
  toolResultParsed: boolean;
  envValue: string | null;
  argsTrailing: string | null;
  canaryExists: boolean;
  ledgerLineCount: number;
  raw: string | null;
  reportExists: boolean;
  reportEnvValue: string | null;
  reportArgsTrailing: string | null;
}

/**
 * Whether any `mcp-servers-discovered` event in `events` reported a `user` /
 * `local`-scope row -- the two scopes the isolated, empty `.claude.json`
 * (Issue 1813) is actually able to close. Deliberately narrowed to match
 * `check-embedded-agent-project-mcp-permission.ts`'s own precedent
 * `hasUserOrLocalScopeEntry`: `connector`-scope rows are NOT included here
 * (Architect ruling, Issue 1813) -- they ride on the copied credentials, not
 * on `.claude.json`, so no isolation this script can perform suppresses
 * them; see {@link collectConnectorScopeRows} for the recorded (non-gated)
 * reading instead, and this file's header comment for the full rationale.
 */
function hasUserOrLocalScopeEntry(events: Array<Record<string, unknown> & { type: string }>): boolean {
  return events.some(
    (e) =>
      e.type === 'mcp-servers-discovered' &&
      Array.isArray(e.servers) &&
      (e.servers as Array<{ scope?: string }>).some((s) => s.scope === 'user' || s.scope === 'local'),
  );
}

/**
 * Whether any `mcp-servers-discovered` event in `events` declared
 * `userLocalNamesUnavailable` -- would mean the isolated `.claude.json`
 * could not be read, which makes the isolation negative control above
 * untestable rather than genuinely passing (see this file's header comment,
 * "ISOLATION FROM THE OPERATOR'S REAL ~/.claude.json").
 */
function anyUserLocalNamesUnavailable(events: Array<Record<string, unknown> & { type: string }>): boolean {
  return events.some((e) => e.type === 'mcp-servers-discovered' && e.userLocalNamesUnavailable === true);
}

/**
 * Every `connector`-scope row (name + status) reported across any
 * `mcp-servers-discovered` event in `events`, deduplicated by name (the
 * event fires repeatedly per activation -- see `sdk-engine.ts`'s
 * `emitMcpServersDiscovered` doc comment on forms (a)/(b)/(c) -- and the
 * same connector reports identically each time). A RECORDED reading, never
 * a gated assertion (Architect ruling, Issue 1813): these rows are expected
 * to be present, tied to the copied credentials rather than to
 * `.claude.json`, and this function exists so a future `buildOptions()`
 * change that starts suppressing them shows up as a changed reading instead
 * of a silent pass.
 */
function collectConnectorScopeRows(
  events: Array<Record<string, unknown> & { type: string }>,
): Array<{ name: string; status: string }> {
  const byName = new Map<string, { name: string; status: string }>();
  for (const e of events) {
    if (e.type !== 'mcp-servers-discovered' || !Array.isArray(e.servers)) continue;
    for (const s of e.servers as Array<{ name?: string; scope?: string; status?: string }>) {
      if (s.scope === 'connector' && typeof s.name === 'string') {
        byName.set(s.name, { name: s.name, status: String(s.status ?? 'unknown') });
      }
    }
  }
  return [...byName.values()];
}

/** Non-elevated branch -- unchanged from before Issue #1799's `--elevated` arm was added, aside from this rename. */
async function runNonElevated(): Promise<number> {
  process.env.LOG_LEVEL = 'debug';
  process.env[PROBE_VAR_NAME] = PROBE_VAR_VALUE;
  // Deliberately never set: PROBE_UNSET_NAME stays absent from this process's
  // (and therefore the spawned subprocess's) environment.
  delete process.env[PROBE_UNSET_NAME];

  // Ad-hoc invocation inherits the caller's cwd; neutralized at script start,
  // same as the sibling smokes.
  process.chdir('/');

  // --- Deferred imports: everything below transitively reaches server-config.ts.
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agent-manager.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import(
    '../../packages/server/src/services/worktree-deletion-service.js'
  );

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let repoDir: string | undefined;
  let locationPath: string | undefined;
  let homeDir: string | undefined;
  // Declared here (not `const` inside the `try` block) so the `finally`
  // block below can reach it for cleanup (CodeRabbit MAJOR, Issue 1813).
  let isolatedConfigDir: string | undefined;

  try {
    console.log(`==> NON-ELEVATED branch. ${PROBE_VAR_NAME}=${PROBE_VAR_VALUE} ${PROBE_UNSET_NAME}=(unset)`);
    console.log('==> ELEVATED branch: not run by this invocation -- see --elevated <target-user>');

    // CodeRabbit MAJOR (Issue 1813, outside-diff finding 2): this MUST be set
    // before `createTestContext` runs below -- its first statement is a
    // `mkdir` of `getConfigDir()`, and with `AGENT_CONSOLE_HOME` unset that
    // resolves to `~/.agent-console`, the OPERATOR's real data root. Same
    // ordering `check-embedded-agent-project-mcp-permission.ts` uses (home
    // dir + env var, then isolation, then `createTestContext`).
    homeDir = path.join(os.tmpdir(), `ac-pr2-pc-home-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', homeDir]);
    process.env.AGENT_CONSOLE_HOME = homeDir;

    // Isolate this arm from the operator's real `~/.claude.json` -- the same
    // isolateClaudeConfigDir + `{}` `.claude.json` construction
    // check-embedded-agent-project-mcp-permission.ts's negative control (c)
    // uses (see this file's own header, "ISOLATION FROM THE OPERATOR'S REAL
    // ~/.claude.json"). Set before `createTestContext` / any spawn below, so
    // the isolated directory is in place before the `claude-sdk` subprocess
    // this script activates ever reads a config dir.
    isolatedConfigDir = isolateClaudeConfigDir('phase5-pr2-pc');
    // CodeRabbit MAJOR (Issue 1813): the event-content checks below cannot by
    // themselves prove the child actually READ this isolated directory --
    // an operator `~/.claude.json` with no user/local servers declared would
    // pass those checks identically. This snapshot, taken BEFORE the `{}`
    // write and BEFORE any session runs, is the "before" baseline
    // `verifyIsolationStrict` (probe-sdk-session-harness.ts) requires of any
    // caller that seeds `.claude.json` itself -- see that function's own
    // TAUTOLOGY WARNING doc comment.
    const isolationBefore = snapshotIsolationEvidence(isolatedConfigDir);
    writeFileSync(path.join(isolatedConfigDir, '.claude.json'), '{}\n');
    console.log(`==> isolated CLAUDE_CONFIG_DIR: ${isolatedConfigDir}`);

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
    // CodeRabbit MAJOR (Issue 1813, outside-diff finding 2): hard assertion,
    // not a recorded reading -- proves `createTestContext` actually resolved
    // the disposable `homeDir` above, not the operator's real data root, at
    // the one point where a future reordering of these lines would silently
    // reintroduce the bug.
    expect(getConfigDir() === homeDir, 'context data root is the disposable home', `getConfigDir()=${getConfigDir()} homeDir=${homeDir}`);

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    const app = new Hono();
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    app.route(
      '',
      createMcpApp({
        sessionManager: ctx.sessionManager,
        repositoryManager: ctx.repositoryManager,
        agentManager: ctx.agentManager,
        agentDirectory: ctx.agentDirectory,
        timerManager: ctx.timerManager,
        conditionalWakeupManager: ctx.conditionalWakeupManager,
        interactiveProcessManager: ctx.interactiveProcessManager,
        worktreeService: ctx.worktreeService,
        annotationService: ctx.annotationService,
        interSessionMessageService: ctx.interSessionMessageService,
        suggestSessionMetadata: ctx.suggestSessionMetadata,
        createWorktreeWithSession,
        deleteWorktree,
        userRepository: ctx.userRepository,
        artifactRepository: ctx.artifactRepository,
        bookmarkRepository: ctx.bookmarkRepository,
        broadcastToApp: ctx.broadcastToApp,
        fetchPullRequestUrl: ctx.fetchPullRequestUrl,
        findOpenPullRequest: ctx.findOpenPullRequest,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
      }),
    );

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    // --- Real repository row: registerRepository requires a real `.git`, so
    // this is a real (but empty) git init -- no worktree, no commits, no
    // real `git worktree add`. Separate from `locationPath` below, which is
    // where `.mcp.json` actually lives (session cwd, not the repository's
    // own registered path).
    repoDir = path.join(os.tmpdir(), `ac-pr2-pc-repo-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', repoDir]);
    const gitInit = Bun.spawnSync(['git', 'init', '-q'], { cwd: repoDir });
    if (gitInit.exitCode !== 0) {
      throw new Error(`git init failed in ${repoDir}: ${new TextDecoder().decode(gitInit.stderr)}`);
    }
    const repository = await ctx.repositoryManager.registerRepository(repoDir);
    console.log(`==> repository registered: ${repository.id} (${repoDir})`);

    locationPath = path.join(os.tmpdir(), `ac-pr2-pc-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', locationPath]);

    const fixtureScriptPath = path.resolve(import.meta.dir, 'fixtures/stdio-echo-mcp-server.ts');
    const canarySet = path.join(locationPath, `${SET_SERVER_NAME}.touched`);
    const ledgerSet = path.join(locationPath, `${SET_SERVER_NAME}-ledger.tsv`);
    const reportSet = path.join(locationPath, `${SET_SERVER_NAME}-report.ndjson`);
    const canaryUnset = path.join(locationPath, `${UNSET_SERVER_NAME}.touched`);
    const ledgerUnset = path.join(locationPath, `${UNSET_SERVER_NAME}-ledger.tsv`);
    const reportUnset = path.join(locationPath, `${UNSET_SERVER_NAME}-report.ndjson`);

    // `--spawn-report` is inserted BEFORE the trailing `${VAR}` placeholder
    // argument so that placeholder stays the LAST element of `args` -- the
    // same position `readFixture`'s `argv.at(-1)` reads for the tool-result
    // reading below, and the same position the fixture's own spawn report
    // reads argv from (Issue #1799 item 2's same-run positive control: the
    // two must be byte-equal for the SAME trailing element).
    const mcpJson = {
      mcpServers: {
        [SET_SERVER_NAME]: {
          command: process.execPath,
          args: [
            fixtureScriptPath,
            '--canary',
            canarySet,
            '--ledger',
            ledgerSet,
            '--env-var',
            'PROBE_TOKEN',
            '--spawn-report',
            reportSet,
            `\${${PROBE_VAR_NAME}}`,
          ],
          env: { PROBE_TOKEN: `\${${PROBE_VAR_NAME}}` },
        },
        [UNSET_SERVER_NAME]: {
          command: process.execPath,
          args: [
            fixtureScriptPath,
            '--canary',
            canaryUnset,
            '--ledger',
            ledgerUnset,
            '--env-var',
            'PROBE_TOKEN2',
            '--spawn-report',
            reportUnset,
            `\${${PROBE_UNSET_NAME}}`,
          ],
          env: { PROBE_TOKEN2: `\${${PROBE_UNSET_NAME}}` },
        },
      },
    };
    await Bun.write(path.join(locationPath, '.mcp.json'), JSON.stringify(mcpJson, null, 2));
    console.log(`==> wrote .mcp.json at ${locationPath}`);

    // --- Compute the real hash for each entry via the real production
    // loader, against an empty allow-list (decision is discarded; only
    // `hash` is read). Never hand-computed.
    const discovery = await discoverProjectMcpServers(locationPath, []);
    if (discovery.mcpJsonError) {
      throw new Error(`discoverProjectMcpServers reported an error: ${discovery.mcpJsonError}`);
    }
    const setEntry = discovery.servers.find((s) => s.name === SET_SERVER_NAME);
    const unsetEntry = discovery.servers.find((s) => s.name === UNSET_SERVER_NAME);
    if (!setEntry || !unsetEntry) {
      throw new Error(`discoverProjectMcpServers did not report both fixture entries: ${JSON.stringify(discovery.servers.map((s) => s.name))}`);
    }
    console.log(`==> discovered hashes: ${SET_SERVER_NAME}=${setEntry.hash} ${UNSET_SERVER_NAME}=${unsetEntry.hash}`);

    // --- Seed both as `allow` rows through the REAL repository.
    await ctx.mcpServerPermissionRepository.upsert({
      repositoryId: repository.id,
      serverName: SET_SERVER_NAME,
      configHash: setEntry.hash,
      decision: 'allow',
      decidedBy: owner.id,
    });
    await ctx.mcpServerPermissionRepository.upsert({
      repositoryId: repository.id,
      serverName: UNSET_SERVER_NAME,
      configHash: unsetEntry.hash,
      decision: 'allow',
      decidedBy: owner.id,
    });
    console.log('==> seeded both fixtures as allow rows');

    // --- Worktree session with the claude-sdk engine as its initial worker.
    // Two-arg createSession (embeddedAgentId set directly) rather than
    // create-then-createWorker: the initial worker IS the embedded-agent
    // worker, so no separate terminal/git-diff worker juggling is needed
    // beyond what createSession does on its own (it always also creates a
    // git-diff worker in parallel, which is harmless and ignored here).
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        repositoryId: repository.id,
        worktreeId: crypto.randomUUID(),
        locationPath,
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      },
      { createdBy: owner.id },
    );
    const worker = session.workers.find((w) => w.type === 'embedded-agent');
    if (!worker) throw new Error('createSession did not produce an embedded-agent worker');
    console.log(`==> session ${session.id} worker ${worker.id} created (not yet activated)`);

    await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, worker.id);
    console.log('==> activated');

    const readEvents = async (): Promise<Array<Record<string, unknown> & { type: string }>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(session.id, worker.id);
      const events: Array<Record<string, unknown> & { type: string }> = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') events.push(json as Record<string, unknown> & { type: string });
        } catch {
          // A trailing torn line is expected while the stream is live.
        }
      }
      return events;
    };

    const runTurn = async (text: string, timeoutMs = 120_000): Promise<string> => {
      const before = (await readEvents()).length;
      const res = await ctx!.sessionManager.sendEmbeddedAgentUserMessage(session.id, worker.id, text);
      if (!res.ok) throw new Error(`sendEmbeddedAgentUserMessage failed: ${res.code} ${res.error}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents()).slice(before);
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal) throw new Error(`loop emitted fatal: ${JSON.stringify(fatal)}`);
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr) throw new Error(`loop emitted turn-error: ${JSON.stringify(turnErr)}`);
        const sawIdle = events.some((e) => e.type === 'state' && e.state === 'idle');
        if (sawIdle) {
          return events
            .filter((e) => e.type === 'assistant-message')
            .map((e) => String(e.text ?? ''))
            .join('\n');
        }
        await delay(500);
      }
      throw new Error('turn did not complete before the deadline');
    };

    const turnMarker = (await readEvents()).length;
    const prompt =
      `Call the tool mcp__${SET_SERVER_NAME}__probe_echo exactly once with no arguments. ` +
      `Then call the tool mcp__${UNSET_SERVER_NAME}__probe_echo exactly once with no arguments. ` +
      'Report back both raw tool results verbatim, then reply with nothing else.';
    const reply = await runTurn(prompt);
    console.log(`==> turn settled. reply: ${reply.trim().slice(0, 300)}`);
    const turnEvents = (await readEvents()).slice(turnMarker);

    const readFixture = (
      serverName: string,
      varName: string,
      canaryPath: string,
      ledgerPath: string,
      reportPath: string,
    ): FixtureReading => {
      const call = turnEvents.find(
        (e) => e.type === 'tool-call' && mcpServerOf(String(e.name ?? '')) === serverName,
      );
      const result = call
        ? turnEvents.find((e) => e.type === 'tool-result' && e.callId === call.callId)
        : undefined;
      let envValue: string | null = null;
      let argsTrailing: string | null = null;
      let raw: string | null = null;
      let toolResultParsed = false;
      if (result && typeof result.result === 'string') {
        raw = result.result;
        try {
          // `tool-result.result` is a JSON-encoded MCP content-block array
          // (`[{ type: 'text', text: '<the tool's own text>' }]`), not the
          // tool's text directly -- the fixture's `probe_echo` response is
          // itself JSON, so this is a double decode: outer content array,
          // then the inner JSON string it carries.
          const outer = JSON.parse(result.result) as Array<{ type: string; text?: string }>;
          const innerText = outer.find((b) => b.type === 'text')?.text;
          if (typeof innerText === 'string') {
            const parsed = JSON.parse(innerText) as { argv: string[]; envValue: string | null };
            envValue = parsed.envValue;
            argsTrailing = parsed.argv.at(-1) ?? null;
            toolResultParsed = true;
          }
        } catch {
          // reported below as toolResultParsed: false
        }
      }

      // Same-run positive control (Issue #1799 item 2): the fixture's own
      // spawn report, written BEFORE the MCP transport ever connects -- read
      // here purely from disk, no dependency on the tool-result parse above.
      let reportExists = false;
      let reportEnvValue: string | null = null;
      let reportArgsTrailing: string | null = null;
      if (existsSync(reportPath)) {
        const reportLines = readFileSync(reportPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
        if (reportLines.length > 0) {
          try {
            const parsed = JSON.parse(reportLines[0]) as { argv: string[]; envValue: string | null };
            reportExists = true;
            reportEnvValue = parsed.envValue;
            reportArgsTrailing = parsed.argv.at(-1) ?? null;
          } catch {
            // reported below via reportExists staying false
          }
        }
      }

      return {
        serverName,
        varName,
        canaryPath,
        ledgerPath,
        reportPath,
        toolCallSeen: call !== undefined,
        toolResultParsed,
        envValue,
        argsTrailing,
        canaryExists: existsSync(canaryPath),
        ledgerLineCount: existsSync(ledgerPath)
          ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length
          : 0,
        raw,
        reportExists,
        reportEnvValue,
        reportArgsTrailing,
      };
    };

    const setReading = readFixture(SET_SERVER_NAME, PROBE_VAR_NAME, canarySet, ledgerSet, reportSet);
    const unsetReading = readFixture(UNSET_SERVER_NAME, PROBE_UNSET_NAME, canaryUnset, ledgerUnset, reportUnset);

    // --- Isolation negative control (Issue 1813): with CLAUDE_CONFIG_DIR
    // pointed at an isolated, empty (but present) config, no discovered
    // event ever reports a user/local-scope row, and userLocalNamesUnavailable
    // is never set (the isolated config was readable) -- the operator's own
    // ~/.claude.json is never read. Checked over the FULL event history (not
    // just `turnEvents`), the same scope
    // check-embedded-agent-project-mcp-permission.ts's own negative control
    // (c) uses, since a `mcp-servers-discovered` event can also arrive from
    // `main.ts`'s activation-time form (a) or `applyMcpServersOnce`'s form
    // (c), not only from `handleSystemInit`'s form (b) this turn drives.
    //
    // claude.ai connectors are DELIBERATELY NOT part of this gated check
    // (Architect ruling, Issue 1813 -- see this file's header, "LIMITATION,
    // RULED"): they are printed as a RECORDED reading below instead, never
    // asserted against.
    console.log('\n==> isolation negative control (Issue 1813)');
    // CodeRabbit MAJOR: a HARD assertion that the CHILD actually used
    // `isolatedConfigDir`, independent of the event-content checks below --
    // those checks answer "did the child's own reporting show a leaked
    // row", not "did the child read this directory at all". A child that
    // silently fell back to the operator's real ~/.claude.json (which may
    // happen to declare no user/local servers) would pass the event checks
    // vacuously; this cannot, because `ok` requires the CHILD's own writes
    // (a grown transcript count or a newly-appeared `sessions/` dir) against
    // the `isolationBefore` baseline captured before either the `{}` write
    // or any session ran.
    const isolationEvidence = verifyIsolationStrict(isolatedConfigDir, isolationBefore);
    expect(
      isolationEvidence.ok,
      'isolation: the child actually used the isolated CLAUDE_CONFIG_DIR (verifyIsolationStrict)',
      JSON.stringify(isolationEvidence),
    );
    const allDiscoveredEvents = (await readEvents()).filter((e) => e.type === 'mcp-servers-discovered');
    expect(allDiscoveredEvents.length > 0, 'isolation: at least one mcp-servers-discovered event exists to check');
    expect(
      !hasUserOrLocalScopeEntry(allDiscoveredEvents),
      'isolation: no discovered event ever reported a user/local-scope row',
      JSON.stringify(allDiscoveredEvents.map((e) => e.servers)),
    );
    expect(
      !anyUserLocalNamesUnavailable(allDiscoveredEvents),
      'isolation: userLocalNamesUnavailable was never set (the isolated config was readable)',
    );
    const connectorRows = collectConnectorScopeRows(allDiscoveredEvents);
    console.log(
      `  connectors present (credential-bound, accepted under section 4.1 TUI parity; not suppressible ` +
        `through the shipping path -- see PS14 / Issue 1813): ${JSON.stringify(connectorRows)}`,
    );

    console.log('\n==> READINGS (non-elevated branch only)');
    for (const r of [setReading, unsetReading]) {
      console.log(`  ${r.serverName} (\${${r.varName}}, ${r.varName === PROBE_VAR_NAME ? 'SET' : 'UNSET'}):`);
      console.log(`    canary exists: ${r.canaryExists}   ledger lines: ${r.ledgerLineCount}`);
      console.log(`    tool-call seen: ${r.toolCallSeen}   tool-result JSON parsed: ${r.toolResultParsed}`);
      console.log(`    env  (CLI-native expansion) -> ${JSON.stringify(r.envValue)}`);
      console.log(`    args (our loader's applyArgSubstitution) -> ${JSON.stringify(r.argsTrailing)}`);
      if (r.raw) console.log(`    raw tool-result: ${r.raw}`);
      console.log(
        `    spawn report -- exists: ${r.reportExists}  env: ${JSON.stringify(r.reportEnvValue)}  args: ${JSON.stringify(r.reportArgsTrailing)}`,
      );
    }

    // --- Same-run positive control (Issue #1799 item 2): the spawn report
    // must be byte-equal to the tool-result reading it stands in for. A
    // mismatch is a HARNESS failure (exit 2), never a finding -- this
    // equality is what licenses reading the elevated branch (which has no
    // tool-result at all) from the spawn report alone.
    for (const r of [setReading, unsetReading]) {
      if (!r.reportExists) {
        throw new Error(`${r.serverName}: spawn report at ${r.reportPath} was not written or could not be parsed`);
      }
      // No tool-result to compare against: the expect() gates below report
      // this as INCONCLUSIVE, per the header's verdict convention. Without
      // this guard, a missing tool call (envValue/argsTrailing both null)
      // would compare against the report's real values and throw HARNESS
      // instead.
      if (!r.toolResultParsed) continue;
      if (r.reportEnvValue !== r.envValue) {
        throw new Error(
          `${r.serverName}: spawn report envValue (${JSON.stringify(r.reportEnvValue)}) does not match ` +
            `tool-result envValue (${JSON.stringify(r.envValue)}) -- these must be byte-equal in the same run`,
        );
      }
      if (r.reportArgsTrailing !== r.argsTrailing) {
        throw new Error(
          `${r.serverName}: spawn report argsTrailing (${JSON.stringify(r.reportArgsTrailing)}) does not match ` +
            `tool-result argsTrailing (${JSON.stringify(r.argsTrailing)}) -- these must be byte-equal in the same run`,
        );
      }
    }
    console.log('\n==> same-run positive control (item 2): spawn report byte-equal to tool-result for both fixtures -- OK');

    expect(setReading.canaryExists, `${SET_SERVER_NAME}: spawn canary exists (process was actually exec'd)`);
    expect(unsetReading.canaryExists, `${UNSET_SERVER_NAME}: spawn canary exists (process was actually exec'd)`);
    expect(setReading.toolCallSeen, `${SET_SERVER_NAME}: a tool-call for this server was observed`);
    expect(unsetReading.toolCallSeen, `${UNSET_SERVER_NAME}: a tool-call for this server was observed`);
    expect(setReading.toolResultParsed, `${SET_SERVER_NAME}: tool-result JSON parsed`);
    expect(unsetReading.toolResultParsed, `${UNSET_SERVER_NAME}: tool-result JSON parsed`);

    // Recorded observations (findings, not gates -- per this script's own
    // header, a deviation here is a measurement to report, not a failure):
    console.log('\n==> FINDINGS (recorded, not gated)');
    console.log(
      `  SET  env expanded to real value:   ${setReading.envValue === PROBE_VAR_VALUE}`,
    );
    console.log(
      `  SET  args substituted to real value: ${setReading.argsTrailing === PROBE_VAR_VALUE}`,
    );
    // The Issue's own AC anticipates EITHER outcome for the CLI's unset-var
    // handling ("env arrives empty/literal per the CLI") -- both count as
    // "not expanded to a real value", the property actually under test.
    const unsetPlaceholder = `\${${PROBE_UNSET_NAME}}`;
    console.log(
      `  UNSET env NOT expanded by CLI (empty/null/literal):   ${
        unsetReading.envValue === null || unsetReading.envValue === '' || unsetReading.envValue === unsetPlaceholder
      } (raw value: ${JSON.stringify(unsetReading.envValue)})`,
    );
    console.log(
      `  UNSET args left literal by loader:  ${unsetReading.argsTrailing === unsetPlaceholder}`,
    );

    console.log('\n==> STDERR WARNING (best-effort; see this file\'s header on observability limits)');
    console.log(
      '  Grep this script\'s own full console capture for a line containing both ' +
        `"${UNSET_SERVER_NAME}" and "is unset and has no default" -- that is ` +
        "applyArgSubstitution's warning, logged via the subprocess's piped " +
        'stderr at LOG_LEVEL=debug. Its absence here is not proof the warning ' +
        'was not emitted -- only that this harness could not observe it (see header).',
    );

    await ctx.sessionManager.deactivateEmbeddedAgentWorker(session.id, worker.id).catch(() => {});

    console.log(`\n==> ${passes} passed, ${failures.length} failed`);
    return failures.length === 0 ? PROBE_EXIT.MEASURED : PROBE_EXIT.INCONCLUSIVE;
  } finally {
    if (ctx) {
      for (const s of ctx.sessionManager.getAllSessions()) {
        for (const w of s.workers) {
          if (w.type === 'embedded-agent') {
            await ctx.sessionManager.deactivateEmbeddedAgentWorker(s.id, w.id).catch(() => {});
          }
        }
      }
      await shutdownAppContext(ctx).catch(() => {});
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    for (const dir of [repoDir, locationPath, homeDir]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
    // CodeRabbit MAJOR (Issue 1813): `isolateClaudeConfigDir` copies the
    // operator's own `.credentials.json` into this throwaway directory --
    // leaving it in place would leak a credential copy outside the probe's
    // own lifetime.
    if (isolatedConfigDir) rmSync(isolatedConfigDir, { recursive: true, force: true });
  }
}

/**
 * Elevated branch (Issue #1799 items 3-4). Activates a real `claude-sdk`
 * embedded-agent worker through the real `spawnAsUser`, as <target-user>,
 * with the SAME fixtures/.mcp.json/permission-seeding shape as the
 * non-elevated branch above -- but NEVER sends a user message. The
 * observable is each fixture's `--spawn-report` file (fixtures/stdio-echo-
 * mcp-server.ts job 4), read from disk once the worker has reported `ready`
 * OR its subprocess has emitted a terminal failure signal, whichever comes
 * first -- the boundary past which neither event would add anything
 * (test-trigger.md's absence-assertion discipline: snapshot after the
 * boundary, never at the first sign of anything).
 *
 * THE FREE GATE (item 4): if BOTH spawn reports appear by that boundary,
 * outcome (i) -- the CLI started its declared MCP servers without a login,
 * so this arm runs turn-free at tier 2. If not, outcome (ii) -- NOT
 * REACHED; this function returns PROBE_EXIT.HARNESS with the captured
 * reason printed. Exactly one report appearing is a third, partial shape,
 * reported as PROBE_EXIT.INCONCLUSIVE rather than forced into either
 * outcome.
 *
 * After outcome (i) is confirmed, this function records and classifies the
 * item-5 readings. The SET readings are measurements, not pass/fail
 * assertions -- either a real value or a literal placeholder is a valid
 * finding to report. The never-set control fixture IS checked against its
 * expected (deterministic, environment-independent) shape; disagreement
 * returns PROBE_EXIT.INCONCLUSIVE, since the SET reading cannot be trusted
 * without that baseline holding. Otherwise this arm returns
 * PROBE_EXIT.MEASURED with the readings printed for the record.
 */
async function runElevatedArm(targetUsername: string): Promise<number> {
  process.env.AUTH_MODE = 'multi-user';
  process.env.LOG_LEVEL = 'debug';
  process.env[PROBE_VAR_NAME] = PROBE_VAR_VALUE;
  delete process.env[PROBE_UNSET_NAME];
  process.chdir('/');

  // --- Deferred imports, same ordering hazard as runNonElevated: every
  // module below transitively reaches server-config.ts, which reads
  // AUTH_MODE at MODULE-LOAD time. lookupOsUser transitively imports
  // logger.ts -> server-config.ts, so it is deferred here too (unlike
  // createDisposableMultiUserHome, imported statically at the top of this
  // file -- see that import's own comment for why it is exempt).
  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.js');
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agent-manager.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import(
    '../../packages/server/src/services/worktree-deletion-service.js'
  );

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let repoDir: string | undefined;
  let locationPath: string | undefined;
  let homeDir: string | undefined;
  let prevUmask: number | undefined;
  let sessionId: string | undefined;
  let workerId: string | undefined;

  try {
    console.log(`==> ELEVATED arm (Issue #1799 item 4 free gate). target user = ${targetUsername}`);
    console.log('==> NON-ELEVATED branch: not run by this invocation -- run with no arguments for that arm');

    const osUser = await lookupOsUser(targetUsername);
    if (!osUser) {
      console.error(`ELEVATED branch: NOT REACHED (could not resolve OS user '${targetUsername}' via lookupOsUser)`);
      return PROBE_EXIT.HARNESS;
    }
    console.log(`  resolved target user: uid=${osUser.uid} home=${osUser.homeDir}`);

    // CodeRabbit MAJOR (Issue 1813, outside-diff finding 2): this MUST run
    // before `createTestContext` below -- its first statement is a `mkdir`
    // of `getConfigDir()`, and with `AGENT_CONSOLE_HOME` unset that resolves
    // to `~/.agent-console`, the OPERATOR's real data root. The disposable
    // AGENT_CONSOLE_HOME must satisfy the production data root's `2775`
    // setgid contract under AUTH_MODE=multi-user, or the memory layer's
    // verification (memory-dir.ts) fails closed before the worker ever
    // reaches its own init handshake -- the same requirement
    // check-embedded-agent-elevation.ts documents for its own use of this
    // helper.
    const homeResult = await createDisposableMultiUserHome('ac-pr2-pc-elevated-home-');
    if (!homeResult.ok) {
      console.error(
        `ELEVATED branch: NOT REACHED (cannot build a disposable AGENT_CONSOLE_HOME satisfying the ` +
          `multi-user 2775 contract: ${homeResult.reason})`,
      );
      return PROBE_EXIT.HARNESS;
    }
    homeDir = homeResult.path;
    prevUmask = homeResult.prevUmask;
    process.env.AGENT_CONSOLE_HOME = homeDir;

    let mcpBaseUrl = '';
    // CodeRabbit MINOR (Issue 1813, follow-up to outside-diff finding 2):
    // this arm's final return does NOT consult `failures` (it is a
    // measurement, not a pass/fail gate -- see the `MEASURED` return below),
    // so a plain `expect()` here could never actually stop the run on a
    // mismatch, defeating the Architect's original safety intent. Two
    // explicit guards instead, each returning `PROBE_EXIT.HARNESS` directly:
    // the first protects `createTestContext`'s own initial
    // `mkdir(getConfigDir())` from ever running against the operator's real
    // data root; the second re-confirms right after context creation, as a
    // pin against a future reordering of these lines.
    const configDirBeforeContext = getConfigDir();
    if (configDirBeforeContext !== homeDir) {
      console.error(
        `ELEVATED branch: NOT REACHED (context data root is not the disposable home: ` +
          `getConfigDir()=${configDirBeforeContext} homeDir=${homeDir})`,
      );
      return PROBE_EXIT.HARNESS;
    }
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
    const contextConfigDir = getConfigDir();
    if (contextConfigDir !== homeDir) {
      console.error(
        `ELEVATED branch: NOT REACHED (context data root is not the disposable home: ` +
          `getConfigDir()=${contextConfigDir} homeDir=${homeDir})`,
      );
      return PROBE_EXIT.HARNESS;
    }

    const osUid = process.getuid?.() ?? 0;
    const invokingUsername = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, invokingUsername, os.homedir());
    const targetUser = await ctx.userRepository.upsertByOsUid(osUser.uid, targetUsername, osUser.homeDir);

    const app = new Hono();
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    app.route(
      '',
      createMcpApp({
        sessionManager: ctx.sessionManager,
        repositoryManager: ctx.repositoryManager,
        agentManager: ctx.agentManager,
        agentDirectory: ctx.agentDirectory,
        timerManager: ctx.timerManager,
        conditionalWakeupManager: ctx.conditionalWakeupManager,
        interactiveProcessManager: ctx.interactiveProcessManager,
        worktreeService: ctx.worktreeService,
        annotationService: ctx.annotationService,
        interSessionMessageService: ctx.interSessionMessageService,
        suggestSessionMetadata: ctx.suggestSessionMetadata,
        createWorktreeWithSession,
        deleteWorktree,
        userRepository: ctx.userRepository,
        artifactRepository: ctx.artifactRepository,
        bookmarkRepository: ctx.bookmarkRepository,
        broadcastToApp: ctx.broadcastToApp,
        fetchPullRequestUrl: ctx.fetchPullRequestUrl,
        findOpenPullRequest: ctx.findOpenPullRequest,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
      }),
    );

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    repoDir = path.join(os.tmpdir(), `ac-pr2-pc-elevated-repo-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', repoDir]);
    const gitInit = Bun.spawnSync(['git', 'init', '-q'], { cwd: repoDir });
    if (gitInit.exitCode !== 0) {
      throw new Error(`git init failed in ${repoDir}: ${new TextDecoder().decode(gitInit.stderr)}`);
    }
    const repository = await ctx.repositoryManager.registerRepository(repoDir);
    console.log(`==> repository registered: ${repository.id} (${repoDir})`);

    locationPath = path.join(os.tmpdir(), `ac-pr2-pc-elevated-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', locationPath]);
    // The target user's login shell -- not this script's own user -- both
    // reads .mcp.json and writes the fixtures' canary/ledger/spawn-report
    // files inside this directory. A throwaway scratch dir this script both
    // creates and removes, so world read+write+traverse is the simplest
    // correct permission for it (`.claude/rules/os-environment-coupling.md`
    // Discipline 2 governs unilateral changes to paths OUTSIDE the
    // project's own scope, which this is not).
    Bun.spawnSync(['chmod', '0777', locationPath]);

    const fixtureScriptPath = path.resolve(import.meta.dir, 'fixtures/stdio-echo-mcp-server.ts');
    const canarySet = path.join(locationPath, `${SET_SERVER_NAME}.touched`);
    const ledgerSet = path.join(locationPath, `${SET_SERVER_NAME}-ledger.tsv`);
    const reportSet = path.join(locationPath, `${SET_SERVER_NAME}-report.ndjson`);
    const canaryUnset = path.join(locationPath, `${UNSET_SERVER_NAME}.touched`);
    const ledgerUnset = path.join(locationPath, `${UNSET_SERVER_NAME}-ledger.tsv`);
    const reportUnset = path.join(locationPath, `${UNSET_SERVER_NAME}-report.ndjson`);

    const mcpJson = {
      mcpServers: {
        [SET_SERVER_NAME]: {
          command: process.execPath,
          args: [
            fixtureScriptPath,
            '--canary',
            canarySet,
            '--ledger',
            ledgerSet,
            '--env-var',
            'PROBE_TOKEN',
            '--spawn-report',
            reportSet,
            `\${${PROBE_VAR_NAME}}`,
          ],
          env: { PROBE_TOKEN: `\${${PROBE_VAR_NAME}}` },
        },
        [UNSET_SERVER_NAME]: {
          command: process.execPath,
          args: [
            fixtureScriptPath,
            '--canary',
            canaryUnset,
            '--ledger',
            ledgerUnset,
            '--env-var',
            'PROBE_TOKEN2',
            '--spawn-report',
            reportUnset,
            `\${${PROBE_UNSET_NAME}}`,
          ],
          env: { PROBE_TOKEN2: `\${${PROBE_UNSET_NAME}}` },
        },
      },
    };
    await Bun.write(path.join(locationPath, '.mcp.json'), JSON.stringify(mcpJson, null, 2));
    console.log(`==> wrote .mcp.json at ${locationPath}`);

    const discovery = await discoverProjectMcpServers(locationPath, []);
    if (discovery.mcpJsonError) {
      throw new Error(`discoverProjectMcpServers reported an error: ${discovery.mcpJsonError}`);
    }
    const setEntry = discovery.servers.find((s) => s.name === SET_SERVER_NAME);
    const unsetEntry = discovery.servers.find((s) => s.name === UNSET_SERVER_NAME);
    if (!setEntry || !unsetEntry) {
      throw new Error(
        `discoverProjectMcpServers did not report both fixture entries: ${JSON.stringify(discovery.servers.map((s) => s.name))}`,
      );
    }
    console.log(`==> discovered hashes: ${SET_SERVER_NAME}=${setEntry.hash} ${UNSET_SERVER_NAME}=${unsetEntry.hash}`);

    await ctx.mcpServerPermissionRepository.upsert({
      repositoryId: repository.id,
      serverName: SET_SERVER_NAME,
      configHash: setEntry.hash,
      decision: 'allow',
      decidedBy: owner.id,
    });
    await ctx.mcpServerPermissionRepository.upsert({
      repositoryId: repository.id,
      serverName: UNSET_SERVER_NAME,
      configHash: unsetEntry.hash,
      decision: 'allow',
      decidedBy: owner.id,
    });
    console.log('==> seeded both fixtures as allow rows');

    // --- Worktree session owned by the TARGET user, not the operator.
    // resolveSpawnUsername(session.createdBy) is what routes activation
    // through spawnAsUser as <target-user> -- see resolve-spawn-username.ts.
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        repositoryId: repository.id,
        worktreeId: crypto.randomUUID(),
        locationPath,
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      },
      { createdBy: targetUser.id },
    );
    const worker = session.workers.find((w) => w.type === 'embedded-agent');
    if (!worker) throw new Error('createSession did not produce an embedded-agent worker');
    sessionId = session.id;
    workerId = worker.id;
    console.log(`==> session ${session.id} worker ${worker.id} created (not yet activated)`);

    console.log(`==> activating as ${targetUsername} via spawnAsUser (no user message will ever be sent)`);
    await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, worker.id);
    console.log('==> activation call returned; waiting for `ready` or a terminal failure signal');

    const readEvents = async (): Promise<Array<Record<string, unknown> & { type: string }>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId!, workerId!);
      const events: Array<Record<string, unknown> & { type: string }> = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') events.push(json as Record<string, unknown> & { type: string });
        } catch {
          // A trailing torn line is expected while the stream is live.
        }
      }
      return events;
    };

    // Wait for the boundary past which neither a spawn report nor a
    // `ready`/`fatal`/`turn-error` signal would add anything. Bounded so an
    // elevated spawn that never signals anything (e.g. hung on an
    // interactive prompt) still reaches a verdict.
    //
    // MEASURED (degenerate same-user run, local): `ready` does NOT imply
    // every declared project MCP server has finished connecting -- one run
    // observed `ready` fire, then an MCP-server stderr line (and its spawn
    // report) land ~350ms LATER. `ready` (`sdk-engine.ts`) means the engine
    // constructed the SDK query and started its consumer; it is NOT gated on
    // the CLI's own `system:init`, which does not arrive until the FIRST
    // PROMPT is sent -- so `ready` fires essentially immediately, and the
    // CLI's own project-server connections can still be in flight. A read
    // taken at the very instant of `ready` can therefore observe an ABSENT
    // report that is about to be written a moment later -- a false outcome (ii).
    // So after `ready` (or a terminal fatal/turn-error signal) fires, this
    // loop keeps polling the reports themselves for a short GRACE window
    // rather than reading immediately: it exits early the instant BOTH
    // reports appear, and otherwise keeps polling until the grace window
    // elapses (or the overall deadline). A `fatal`/`turn-error` still stops
    // the EVENT wait immediately -- the grace window applies to reading the
    // FILESYSTEM after that boundary, not to how long the loop keeps
    // watching the event stream.
    // Reads and parses one spawn report file, defined ABOVE the grace-window
    // loop below so the loop can call it directly -- the loop's own exit
    // condition needs to know whether a report is actually PARSEABLE, not
    // merely that its path exists (`stdio-echo-mcp-server.ts` creates and
    // appends the report in a CHILD process; this parent can observe the
    // path via `existsSync` while that child's write is still landing, same
    // race class as the `ready`-vs-connection lag documented below, one
    // layer further in).
    const readReport = (
      reportPath: string,
    ): { exists: boolean; envValue: string | null; argsTrailing: string | null; raw: string | null } => {
      if (!existsSync(reportPath)) return { exists: false, envValue: null, argsTrailing: null, raw: null };
      const lines = readFileSync(reportPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 0) return { exists: false, envValue: null, argsTrailing: null, raw: null };
      try {
        const parsed = JSON.parse(lines[0]) as { argv: string[]; envValue: string | null };
        return { exists: true, envValue: parsed.envValue, argsTrailing: parsed.argv.at(-1) ?? null, raw: lines[0] };
      } catch {
        return { exists: false, envValue: null, argsTrailing: null, raw: lines[0] };
      }
    };

    const ELEVATED_GATE_TIMEOUT_MS = 60_000;
    const ELEVATED_GATE_GRACE_MS = 8_000;
    const deadline = Date.now() + ELEVATED_GATE_TIMEOUT_MS;
    let boundaryEvents: Array<Record<string, unknown> & { type: string }> = [];
    let boundaryReason: 'ready' | 'fatal' | 'turn-error' | 'timeout' = 'timeout';
    let boundarySignalAt: number | undefined;
    let graceDeadline: number | undefined;
    while (Date.now() < deadline) {
      const events = await readEvents();
      boundaryEvents = events;
      if (boundarySignalAt === undefined) {
        if (events.some((e) => e.type === 'fatal')) {
          boundaryReason = 'fatal';
          boundarySignalAt = Date.now();
        } else if (events.some((e) => e.type === 'turn-error')) {
          boundaryReason = 'turn-error';
          boundarySignalAt = Date.now();
        } else if (events.some((e) => e.type === 'ready')) {
          boundaryReason = 'ready';
          boundarySignalAt = Date.now();
        }
        if (boundarySignalAt !== undefined) {
          graceDeadline = Math.min(deadline, boundarySignalAt + ELEVATED_GATE_GRACE_MS);
        }
      }
      if (boundarySignalAt !== undefined) {
        if (
          (readReport(reportSet).exists && readReport(reportUnset).exists) ||
          Date.now() >= (graceDeadline ?? deadline)
        ) {
          break;
        }
      }
      await delay(250);
    }
    console.log(
      `==> boundary reached: ${boundaryReason} (${boundaryEvents.length} events observed` +
        `${boundarySignalAt !== undefined ? `, +${Date.now() - boundarySignalAt}ms grace elapsed` : ''})`,
    );

    // --- Final snapshot, exactly once, at the boundary above -- never
    // polled for appearance on their own (test-trigger.md's absence-
    // assertion discipline: snapshot after the boundary past which the
    // event would no longer be written, not at the first sign of anything)
    // -- the grace window above IS that boundary, made wide enough to
    // survive the measured `ready`-before-MCP-connect race rather than
    // reading at the instant of `ready` itself.
    const setReport = readReport(reportSet);
    const unsetReport = readReport(reportUnset);

    console.log(`==> ELEVATED spawn report -- ${SET_SERVER_NAME}: exists=${setReport.exists} raw=${setReport.raw ?? '(none)'}`);
    console.log(`==> ELEVATED spawn report -- ${UNSET_SERVER_NAME}: exists=${unsetReport.exists} raw=${unsetReport.raw ?? '(none)'}`);

    if (!setReport.exists && !unsetReport.exists) {
      // --- OUTCOME (ii): capture the reason. LOG_LEVEL=debug (set above)
      // means the embedded subprocess's own piped stderr is already visible
      // in this run's full console capture via pino debug logging -- see
      // this file's header "STDERR WARNING OBSERVABILITY" paragraph, the
      // same technique, reused here for the elevated subprocess's refusal
      // message rather than applyArgSubstitution's warning.
      const lastEvent = boundaryEvents.at(-1);
      console.error(
        `ELEVATED branch: NOT REACHED (boundary=${boundaryReason}; neither fixture's spawn report appeared; ` +
          `last SDK event: ${lastEvent ? JSON.stringify(lastEvent).slice(0, 500) : '(none observed)'})`,
      );
      console.error(
        '  Grep this run\'s own full console capture for "Embedded-agent stderr" -- the subprocess\'s piped ' +
          'stderr is logged via pino at debug level (LOG_LEVEL=debug, set above) and should carry the CLI\'s ' +
          'own refusal reason when it could not start unauthenticated.',
      );
      return PROBE_EXIT.HARNESS;
    }

    if (!setReport.exists || !unsetReport.exists) {
      // Exactly one of the two spawn reports appeared -- neither a clean
      // gate pass (item 4's outcome (i) needs BOTH) nor a clean refusal
      // (which would show NEITHER). Something partial happened; report it
      // as inconclusive rather than forcing it into either outcome.
      console.error(
        `ELEVATED branch: INCONCLUSIVE (boundary=${boundaryReason}; ` +
          `${SET_SERVER_NAME} report exists=${setReport.exists}; ${UNSET_SERVER_NAME} report exists=${unsetReport.exists} ` +
          '-- exactly one fixture reported, expected both or neither)',
      );
      return PROBE_EXIT.INCONCLUSIVE;
    }

    console.log(
      '==> OUTCOME (i): both spawn reports appeared -- the CLI started its declared MCP servers without a login.',
    );

    // --- Item 5 readings. Both a real-value match and a literal-placeholder
    // match are legitimate readings -- per this file's header VERDICT
    // convention, a clean measurement is a success even when the value
    // deviates from a prior expectation; the deviation is then the finding.
    const setLiteral = `\${${PROBE_VAR_NAME}}`;
    const unsetLiteral = `\${${PROBE_UNSET_NAME}}`;
    const describeValue = (value: string | null, realValue: string, literal: string): string => {
      if (value === realValue) return 'REAL VALUE (crossed the elevation boundary)';
      if (value === literal || value === null || value === '') return 'LITERAL/EMPTY (did not cross)';
      return `UNEXPECTED (${JSON.stringify(value)})`;
    };
    console.log(`  ELEVATED ${SET_SERVER_NAME} (\${${PROBE_VAR_NAME}}, SET in the SERVER process only):`);
    console.log(
      `  ELEVATED    env  (CLI-native expansion under the target user's shell) -> ${JSON.stringify(setReport.envValue)} -- ${describeValue(setReport.envValue, PROBE_VAR_VALUE, setLiteral)}`,
    );
    console.log(
      `  ELEVATED    args (our loader's applyArgSubstitution)                 -> ${JSON.stringify(setReport.argsTrailing)} -- ${describeValue(setReport.argsTrailing, PROBE_VAR_VALUE, setLiteral)}`,
    );
    console.log(`  ELEVATED ${UNSET_SERVER_NAME} (\${${PROBE_UNSET_NAME}}, control -- never set anywhere):`);
    console.log(
      `  ELEVATED    env  -> ${JSON.stringify(unsetReport.envValue)}`,
    );
    console.log(
      `  ELEVATED    args -> ${JSON.stringify(unsetReport.argsTrailing)}`,
    );

    // --- Control agreement check: the UNSET fixture is never set in EITHER
    // the server process or the target user's shell, in EITHER arm, so its
    // shape must match what the non-elevated arm's own same-run positive
    // control already measured (item 2, 2026-09-22: env left literal/empty
    // by the CLI's native expansion, args left literal by
    // applyArgSubstitution's documented unset-with-no-default behavior --
    // never thrown, never a real value). A control that disagrees with that
    // deterministic, environment-independent behavior means something about
    // THIS run's apparatus is not comparable to the non-elevated run's, so
    // the elevated reading cannot be trusted on its own.
    const unsetEnvAsExpected =
      unsetReport.envValue === null || unsetReport.envValue === '' || unsetReport.envValue === unsetLiteral;
    const unsetArgsAsExpected = unsetReport.argsTrailing === unsetLiteral;
    if (!unsetEnvAsExpected || !unsetArgsAsExpected) {
      console.error(
        'ELEVATED branch: INCONCLUSIVE -- the control (never-set-anywhere) fixture disagreed with the ' +
          `non-elevated arm's own control shape (env as-expected=${unsetEnvAsExpected}, args as-expected=${unsetArgsAsExpected}); ` +
          'the SET fixture reading above cannot be trusted without this baseline holding.',
      );
      return PROBE_EXIT.INCONCLUSIVE;
    }

    console.log('==> ELEVATED control agreement: OK (matches the non-elevated arm\'s own control shape)');
    console.log(`\n==> ${passes} passed, ${failures.length} failed (elevated arm has no gated assertions of its own -- item 5 is a measurement, not a pass/fail gate)`);
    return PROBE_EXIT.MEASURED;
  } finally {
    // Restore the umask createDisposableMultiUserHome() changed, FIRST --
    // it was applied unconditionally the moment that call returned (see its
    // own header), so nothing else in this block should run under the
    // smoke's own 0o002 override. Same ordering as
    // check-embedded-agent-elevation.ts's cleanup.
    if (prevUmask !== undefined) {
      process.umask(prevUmask);
    }
    if (ctx && sessionId && workerId) {
      await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId).catch(() => {});
    }
    if (ctx) {
      await shutdownAppContext(ctx).catch(() => {});
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    for (const dir of [repoDir, locationPath, homeDir]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
  }
}

/**
 * `--elevated <target-user>` selects the elevated arm exclusively; no
 * arguments selects the non-elevated arm. The two never run in the same
 * process invocation (mirrors `check-login-shell-sentinel.ts`'s direct vs
 * `--elevated` mode dispatch).
 */
function parseCliArgs(argvIn: string[]): { mode: 'non-elevated' } | { mode: 'elevated'; targetUsername: string } {
  const argv = argvIn[0] === '--' ? argvIn.slice(1) : argvIn;
  if (argv.length === 0) return { mode: 'non-elevated' };
  if (argv[0] === '--elevated' && argv[1]) {
    return { mode: 'elevated', targetUsername: argv[1] };
  }
  console.error('usage: bun scripts/smoke/probe-sdk-phase5-pr2-pc.ts [--elevated <target-user>]');
  process.exit(2);
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  return parsed.mode === 'elevated' ? runElevatedArm(parsed.targetUsername) : runNonElevated();
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('PROBE COULD NOT RUN (or aborted before completing its assertions):');
      console.error(err);
      console.error(`\n==> ${passes} passed, ${failures.length} failed before the abort`);
      process.exitCode = PROBE_EXIT.HARNESS;
    });
}
