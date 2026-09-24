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
 * SCOPE: NON-ELEVATED BRANCH ONLY. The elevated branch (does a login shell's
 * profile, rather than the server process's own environment, supply the
 * value under `sudo -u <user> -i`?) needs a tier-2 container this session
 * cannot reach and is NOT attempted here -- no substitution, no
 * approximation. Every printed reading is prefixed NON-ELEVATED; the
 * elevated branch is reported as NOT REACHED, not as passing or failing.
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
 * file: 0 = MEASURED (both fixtures' tool calls completed and their JSON
 * payload was read, regardless of what the values turned out to be -- a
 * clean measurement is a success even if a reading deviates from
 * expectation, which is then a finding to report, not a script failure); 1 =
 * INCONCLUSIVE (a turn never settled, a tool call never happened, or its
 * JSON payload could not be parsed); 2 = HARNESS (activation failed, the
 * probe could not run at all).
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user; `bun install` already run; `git` on PATH (for the throwaway
 * repository's `.git`, needed by `RepositoryManager.registerRepository`).
 * BILLABLE -- one real turn, well under $1. A manual gate, never a CI job;
 * registered in `.claude/rules/test-trigger.md`.
 *
 * Usage: bun scripts/smoke/probe-sdk-phase5-pr2-pc.ts
 */

// --- CRITICAL ordering, same hazard as check-embedded-agent-idle-eviction.ts
// and probe-sdk-phase5-pr2-premises.ts's sibling: `serverConfig` computes its
// values at MODULE-LOAD time, so every env var this script sets (LOG_LEVEL,
// AGENT_CONSOLE_HOME, PROBE_VAR) must be assigned before any module that
// transitively imports server-config.ts is evaluated. Every such import
// below is therefore a DYNAMIC import made from inside main().

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// mcp-discovery.ts, mcp-names.ts, and probe-sdk-session-harness.ts are
// standalone (no transitive server-config.ts import), so they are safe as
// ordinary static imports -- unlike everything under packages/server/src,
// which is deferred below.
import { discoverProjectMcpServers } from '../../packages/embedded-agent/src/mcp-discovery.js';
import { mcpServerOf } from '../../packages/embedded-agent/src/mcp-names.js';
import { isolateClaudeConfigDir } from './probe-sdk-session-harness.js';
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
  toolCallSeen: boolean;
  toolResultParsed: boolean;
  envValue: string | null;
  argsTrailing: string | null;
  canaryExists: boolean;
  ledgerLineCount: number;
  raw: string | null;
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

async function main(): Promise<number> {
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

  try {
    console.log(`==> NON-ELEVATED branch only. ${PROBE_VAR_NAME}=${PROBE_VAR_VALUE} ${PROBE_UNSET_NAME}=(unset)`);
    console.log('==> ELEVATED branch: NOT REACHED (needs tier-2 container; not attempted here)');

    // Isolate this arm from the operator's real `~/.claude.json` -- the same
    // isolateClaudeConfigDir + `{}` `.claude.json` construction
    // check-embedded-agent-project-mcp-permission.ts's negative control (c)
    // uses (see this file's own header, "ISOLATION FROM THE OPERATOR'S REAL
    // ~/.claude.json"). Set before `createTestContext` / any spawn below, so
    // the isolated directory is in place before the `claude-sdk` subprocess
    // this script activates ever reads a config dir.
    const isolatedConfigDir = isolateClaudeConfigDir('phase5-pr2-pc');
    writeFileSync(path.join(isolatedConfigDir, '.claude.json'), '{}\n');
    console.log(`==> isolated CLAUDE_CONFIG_DIR: ${isolatedConfigDir}`);

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    homeDir = path.join(os.tmpdir(), `ac-pr2-pc-home-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', homeDir]);
    process.env.AGENT_CONSOLE_HOME = homeDir;

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
    const canaryUnset = path.join(locationPath, `${UNSET_SERVER_NAME}.touched`);
    const ledgerUnset = path.join(locationPath, `${UNSET_SERVER_NAME}-ledger.tsv`);

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

    const readFixture = (serverName: string, varName: string, canaryPath: string, ledgerPath: string): FixtureReading => {
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
      return {
        serverName,
        varName,
        canaryPath,
        ledgerPath,
        toolCallSeen: call !== undefined,
        toolResultParsed,
        envValue,
        argsTrailing,
        canaryExists: existsSync(canaryPath),
        ledgerLineCount: existsSync(ledgerPath)
          ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length
          : 0,
        raw,
      };
    };

    const setReading = readFixture(SET_SERVER_NAME, PROBE_VAR_NAME, canarySet, ledgerSet);
    const unsetReading = readFixture(UNSET_SERVER_NAME, PROBE_UNSET_NAME, canaryUnset, ledgerUnset);

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
    }

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
  }
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
