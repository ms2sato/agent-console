#!/usr/bin/env bun
/**
 * Shipping-path E2E for the per-user claude.ai connectors toggle
 * (`disableClaudeAiConnectors`, Issue #1836): a per-USER preference,
 * persisted on the `users` table, that -- when set -- causes a user's
 * `claude-sdk` embedded-agent workers to spawn with the SDK's own
 * claude.ai connectors (Google Drive, Gmail, etc.) disabled.
 *
 * Everything here is real: a real `AppContext`, a real app server with the
 * real `/api` router and real `/mcp` app, real `claude-sdk` embedded-agent
 * workers spawned by the real `EmbeddedAgentWorkerService`, the real Claude
 * Agent SDK talking to the real Anthropic API, and a real
 * `PATCH /api/auth/me/preferences` HTTP request through the real Hono route
 * -- never a direct `userRepository.setPreferences(...)` call. The observed
 * discovery of connectors is read from the worker's own persisted NDJSON
 * output file (`mcp-servers-discovered` events), never from the model's
 * prose.
 *
 * MECHANISM. The toggle has NO runtime setter (unlike compaction's
 * `auto`): it is composed into `Options.settings.disableClaudeAiConnectors`
 * once, at `SdkEngine` construction, and the SDK only reads
 * `Options.settings` at construction. A preference change therefore takes
 * effect at a worker's NEXT ACTIVATION, never live. This script exercises
 * exactly that: worker A is activated BEFORE the PATCH (baseline), and a
 * SEPARATE fresh worker B is activated AFTER the PATCH -- re-activating A
 * in place would conflate "the SDK resumed the old settings" with "the SDK
 * never re-read settings on a restart", and a fresh worker removes that
 * ambiguity entirely.
 *
 * WHAT IT ASSERTS (default run, no flags)
 *
 *   Worker A (POSITIVE CONTROL, activated with the toggle at its
 *   migration-default OFF -- connectors ON):
 *     - after one turn (system:init has arrived), A's persisted
 *       `mcp-servers-discovered` event(s) contain at least one row with
 *       `scope: 'connector'`.
 *     - If the host account genuinely has no claude.ai connectors
 *       configured, this is NOT a pass -- the run reports INCONCLUSIVE and
 *       exits 1. A false "pass" here would make every downstream assertion
 *       meaningless (there would be nothing for the toggle to suppress).
 *
 *   The real PATCH:
 *     - `PATCH /api/auth/me/preferences { disableClaudeAiConnectors: true }`
 *       against the real running server, no cookie needed (single-user
 *       mode's `authenticate()` always returns the cached server-process
 *       user -- see `SingleUserMode.authenticate`), returns 200 with
 *       `{ user, preferences: { disableClaudeAiConnectors: true } }`.
 *
 *   Worker B (fresh activation, AFTER the PATCH, same user):
 *     - B's persisted `mcp-servers-discovered` event(s) contain ZERO rows
 *       with `scope: 'connector'`.
 *     - B's event(s) still contain the reserved `agent-console` and
 *       `console` server names -- proving "connectors suppressed" is not
 *       merely "the discovered-event mechanism broke" or "nothing
 *       connected at all".
 *
 * `--expect-connectors-present` is a BREAK-THE-FIX POLARITY FLAG, same
 * convention as this file's Tier-4 siblings (`--expect-not-evictable`,
 * `--expect-underfire`): it drives the SAME real PATCH the default run
 * uses -- `PATCH /api/auth/me/preferences { disableClaudeAiConnectors:
 * true }` -- then activates a fresh worker B and asserts its discovered
 * event(s) DO contain a `scope: 'connector'` row, i.e. it asserts the
 * PRE-FIX BUG SHAPE (the toggle failing to suppress connectors).
 *
 * On THIS, correctly-fixed tree, that assertion is EXPECTED TO FAIL -- the
 * toggle correctly suppresses the connector, so B observes none, and this
 * flag's own `expect()` call reports a failure. That failure is the
 * CORRECT, documented outcome here: it is the confirmation that the
 * apparatus actually reaches the defect. Run this flag against a REVERTED
 * tree (the composition step removed from
 * `embedded-agent-worker-service.ts`, or `disableClaudeAiConnectors`
 * dropped from the `settings` object in `sdk-engine.ts`) to see it PASS,
 * which is what "the apparatus reaches the defect" means operationally --
 * see `workflow.md`'s "A check's existence is not its detection power".
 *
 * KNOWN LIMITATION: this flag has no INCONCLUSIVE gate of its own (unlike
 * worker A in the default run). If the invoking OS user's account has no
 * claude.ai connectors configured at all, this flag's assertion also fails
 * on the fixed tree -- indistinguishably from the toggle correctly
 * suppressing a connector. That is harmless for THIS flag specifically
 * (failing on the fixed tree is the expected outcome either way), but it
 * means a PASS under this flag (i.e. a reverted tree) is only meaningful
 * when the same host's default run has already cleared its own
 * INCONCLUSIVE gate in the same session.
 *
 * COST: two real Claude turns (default run: A's turn, B's turn) or one
 * (`--expect-connectors-present`: B's turn only). Small, but real money and
 * real usage -- this is a manual tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - A real, authenticated `claude` CLI for the invoking OS user (the
 *     `claude-sdk` builtin runs as the executing user and uses that user's
 *     own authentication -- there is no API key to configure).
 *   - The invoking OS user's Claude Code account must have at least one
 *     claude.ai connector configured (Google Drive, Gmail, etc.) for the
 *     positive control to be meaningful -- see the INCONCLUSIVE case above.
 *   - `bun install` already run in this checkout.
 *
 * USAGE
 *   bun scripts/smoke/check-claude-sdk-connectors-toggle.ts
 *   bun scripts/smoke/check-claude-sdk-connectors-toggle.ts --expect-connectors-present
 *
 * EXIT CODES
 *   0  every assertion passed (default run: the fix holds; polarity run:
 *      the pre-fix bug shape REPRODUCED -- a connector was observed with the
 *      toggle on, i.e. the tree under test is reverted/broken; see the
 *      polarity section above for the documented EXPECTED exit-1 case)
 *   1  an assertion failed (default run: the system is wrong), OR the run
 *      was INCONCLUSIVE (the host account has no connectors to observe) --
 *      never conflated with a clean pass. For `--expect-connectors-present`
 *      specifically, exit 1 on the current, correctly-fixed tree is the
 *      EXPECTED and CORRECT outcome -- see the polarity section above.
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure)
 *
 * Registered in `.claude/rules/test-trigger.md` -- Tier 4 (billable;
 * dogfood host only -- permanent residue).
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every env var this script sets must be assigned before any
// module that transitively imports server-config.ts is evaluated. Every
// such import below is therefore a DYNAMIC import made from inside main().
// See check-embedded-agent-idle-eviction.ts's identical header note.

export interface ParsedArgs {
  expectConnectorsPresent: boolean;
}

/**
 * @internal Exported for testing. Tolerates a leading `--` separator, same
 * convention as `check-embedded-agent-project-mcp-permission.ts`'s
 * `parseArgs` -- `bun run <alias> -- --flag` and direct `bun scripts/...ts
 * --flag` invocations both parse identically.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let expectConnectorsPresent = false;
  for (const arg of args) {
    if (arg === '--expect-connectors-present') {
      expectConnectorsPresent = true;
    } else {
      console.error(`unknown flag: ${arg}`);
      console.error(
        'Usage: bun scripts/smoke/check-claude-sdk-connectors-toggle.ts [--] [--expect-connectors-present]',
      );
      process.exit(2);
    }
  }
  return { expectConnectorsPresent };
}

import * as os from 'node:os';
import * as path from 'node:path';
// `lib/config.ts` (NOT `lib/server-config.ts`) only imports `node:path`/
// `node:os` at module load, so it is safe as a static import here too --
// same reasoning the sibling smokes use (see e.g.
// check-restart-all-embedded.ts).
import { getConfigDir } from '../../packages/server/src/lib/config.js';
import type { AppContext } from '../../packages/server/src/app-context.js';

const failures: string[] = [];
let passes = 0;
let inconclusive: string | null = null;

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

export interface DiscoveredServer {
  name: string;
  scope: string;
  status: string;
}

/**
 * @internal Exported for testing. `true` iff `servers` contains at least
 * one `scope: 'connector'` row -- the single classifier both the default
 * run's positive control (worker A) and the polarity run's assertion
 * (worker B) key on.
 */
export function hasConnectorScope(servers: DiscoveredServer[]): boolean {
  return servers.some((s) => s.scope === 'connector');
}

/**
 * @internal Exported for testing. `true` iff `servers` contains a row named
 * `name` (any scope) -- used to confirm the reserved `agent-console` /
 * `console` servers survive alongside a suppressed connector, so
 * "connectors suppressed" is not merely "the discovered-event mechanism
 * broke" or "nothing connected at all".
 */
export function hasServerNamed(servers: DiscoveredServer[], name: string): boolean {
  return servers.some((s) => s.name === name);
}

async function main(): Promise<void> {
  const { expectConnectorsPresent } = parseArgs(process.argv.slice(2));

  // Ad-hoc invocation inherits the caller's cwd, which the spawn machinery
  // evaluates; an unreadable inherited cwd produces EACCES on posix_spawn.
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
  const { isolateClaudeConfigDir, verifyIsolation } = await import(
    './probe-sdk-session-harness.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import(
    '../../packages/server/src/services/worktree-deletion-service.js'
  );

  // `hono` is hoisted under packages/server/node_modules, not under any
  // node_modules ancestor of scripts/smoke/ -- resolve it the way
  // packages/server would and import the resolved absolute path.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realConfigDir: string | undefined;
  let realCwd: string | undefined;
  let claudeConfigDir: string | undefined;

  try {
    console.log(
      `==> mode: ${expectConnectorsPresent ? '--expect-connectors-present (POLARITY: the pre-fix bug shape must reproduce; EXPECTED TO FAIL on the fixed tree)' : 'default (the fix must hold)'}`,
    );

    // Isolated CLAUDE_CONFIG_DIR: preserves the real account's login
    // credentials (so the real, account-scoped claude.ai connectors are
    // still discoverable) while never touching the operator's real project
    // list / session history.
    claudeConfigDir = isolateClaudeConfigDir('connectors-toggle');

    // AGENT_CONSOLE_HOME pointed at a real temp dir BEFORE createTestContext
    // ever runs -- createTestContext's own first statement is a
    // mkdir(getConfigDir()), and with AGENT_CONSOLE_HOME unset that resolves
    // to the operator's real data root, not this smoke's disposable home.
    // getConfigDir() reads process.env.AGENT_CONSOLE_HOME at CALL time (not
    // module load time), so this override is safe post-import.
    realConfigDir = path.join(os.tmpdir(), `ac-connectors-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    // Guard: createTestContext's own initial mkdir(getConfigDir()) must
    // never run against the operator's real data root. Two explicit checks
    // -- before and after createTestContext -- each throwing an Error
    // (which the outer `main().catch(...)` below maps to `process.exit(2)`)
    // directly on a mismatch, mirroring the shape probe-sdk-phase5-pr2-pc.ts's
    // elevated arm landed at, rather than a bare `expect()` whose
    // result the final exit check might not consult before the rest of the
    // run has already touched the wrong root.
    const configDirBeforeContext = getConfigDir();
    if (configDirBeforeContext !== realConfigDir) {
      throw new Error(
        `context data root is not the disposable home before createTestContext: ` +
          `getConfigDir()=${configDirBeforeContext} realConfigDir=${realConfigDir}`,
      );
    }

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });
    const contextConfigDir = getConfigDir();
    if (contextConfigDir !== realConfigDir) {
      throw new Error(
        `context data root is not the disposable home after createTestContext: ` +
          `getConfigDir()=${contextConfigDir} realConfigDir=${realConfigDir}`,
      );
    }

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realCwd = path.join(os.tmpdir(), `ac-connectors-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);

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

    const isolation = verifyIsolation(claudeConfigDir);
    console.log(`==> CLAUDE_CONFIG_DIR isolation: ${claudeConfigDir}`);
    console.log(`  evidence so far (pre-spawn, expected empty): ${JSON.stringify(isolation.evidence)}`);

    const readEvents = async (
      sessionId: string,
      workerId: string,
    ): Promise<Array<Record<string, unknown> & { type: string }>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      const events: Array<Record<string, unknown> & { type: string }> = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') {
            events.push(json as Record<string, unknown> & { type: string });
          }
        } catch {
          // A trailing torn line is expected while the stream is live.
        }
      }
      return events;
    };

    /** Drive one turn and return the assistant text it produced. */
    const runTurn = async (
      sessionId: string,
      workerId: string,
      text: string,
      timeoutMs = 120_000,
    ): Promise<string> => {
      const before = (await readEvents(sessionId, workerId)).length;
      const res = await ctx!.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, text);
      if (!res.ok) throw new Error(`sendEmbeddedAgentUserMessage failed: ${res.code} ${res.error}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(before);
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

    /** Every `mcp-servers-discovered` server row across a worker's whole persisted stream. */
    const discoveredServers = async (
      sessionId: string,
      workerId: string,
    ): Promise<DiscoveredServer[]> => {
      const events = await readEvents(sessionId, workerId);
      const out: DiscoveredServer[] = [];
      for (const e of events) {
        if (e.type !== 'mcp-servers-discovered') continue;
        const servers = (e as { servers?: unknown }).servers;
        if (Array.isArray(servers)) out.push(...(servers as DiscoveredServer[]));
      }
      return out;
    };

    const makeWorker = async (label: string): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      });
      if (!worker) throw new Error(`createWorker returned null for ${label}`);
      return { sessionId: session.id, workerId: worker.id };
    };

    const TURN_TEXT = 'Reply with only the word READY.';

    /**
     * The real PATCH, through the real route, no cookie needed (single-user
     * mode's `authenticate()` always returns the cached server-process
     * user). Common to both modes -- the default run and the polarity run
     * both set the toggle to `true`; they differ only in what precedes
     * (worker A, default-only) and what is asserted about worker B
     * afterward.
     */
    const patchDisableConnectorsOn = async (): Promise<void> => {
      console.log('==> PATCH /api/auth/me/preferences { disableClaudeAiConnectors: true }');
      const patchRes = await fetch(`http://localhost:${appServer!.port}/api/auth/me/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableClaudeAiConnectors: true }),
      });
      const patchBody = (await patchRes.json()) as {
        user?: { id: string };
        preferences?: { disableClaudeAiConnectors: boolean };
      };
      console.log(`  PATCH response: ${patchRes.status} ${JSON.stringify(patchBody)}`);
      expect(patchRes.status === 200, 'PATCH /api/auth/me/preferences returned 200');
      expect(
        patchBody.preferences?.disableClaudeAiConnectors === true,
        'PATCH response preferences.disableClaudeAiConnectors === true',
        JSON.stringify(patchBody),
      );
      expect(
        patchBody.user?.id === owner.id,
        'PATCH response user is the same owner that owns this run\'s workers',
        `expected ${owner.id}, got ${patchBody.user?.id}`,
      );
    };

    if (!expectConnectorsPresent) {
      // --- Worker A: baseline, toggle at its migration default (OFF ->
      // connectors ON). No preference PATCH has happened yet for this user.
      console.log('==> worker A: activate + one turn (baseline, connectors expected ON)');
      const a = await makeWorker('A');
      await ctx.sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
      await runTurn(a.sessionId, a.workerId, TURN_TEXT);
      const aServers = await discoveredServers(a.sessionId, a.workerId);
      console.log(`  A discovered servers: ${JSON.stringify(aServers)}`);

      const aHasConnector = hasConnectorScope(aServers);
      if (!aHasConnector) {
        inconclusive =
          'the invoking OS user\'s Claude Code account has no claude.ai connectors configured -- ' +
          'worker A observed zero scope:"connector" rows, so there is nothing for the toggle to ' +
          'suppress and every downstream assertion in this run would be meaningless';
      } else {
        expect(true, 'worker A (baseline): observed at least one scope:"connector" row');

        await patchDisableConnectorsOn();

        // --- Worker B: a FRESH worker, activated AFTER the PATCH. The
        // toggle has no runtime setter, so this is the "next activation"
        // that must observe the new preference -- re-activating A in place
        // would not distinguish "the fix works" from "the SDK never
        // re-reads settings on a restart, for either value".
        console.log('==> worker B: activate + one turn (fresh, toggle expected ON, connectors expected OFF)');
        const b = await makeWorker('B');
        await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
        await runTurn(b.sessionId, b.workerId, TURN_TEXT);
        const bServers = await discoveredServers(b.sessionId, b.workerId);
        console.log(`  B discovered servers: ${JSON.stringify(bServers)}`);

        expect(
          !hasConnectorScope(bServers),
          'worker B: zero scope:"connector" rows after the toggle was turned on',
          JSON.stringify(bServers),
        );
        expect(
          hasServerNamed(bServers, 'agent-console'),
          'worker B: the reserved "agent-console" server is still present (not "nothing connected at all")',
          JSON.stringify(bServers),
        );
        expect(
          hasServerNamed(bServers, 'console'),
          'worker B: the reserved "console" (Compact tool) server is still present',
          JSON.stringify(bServers),
        );
      }
    } else {
      // --- Polarity run: the SAME real PATCH as the default run (toggle
      // SET to true), then a fresh worker B, activated after the PATCH.
      // Asserts the PRE-FIX bug shape -- a connector STILL observed despite
      // the toggle being on. On this, correctly-fixed tree, that assertion
      // is EXPECTED TO FAIL; see the header's polarity section for why a
      // failure here is the correct, documented outcome.
      await patchDisableConnectorsOn();

      console.log('==> worker B (polarity): activate + one turn (toggle SET, connector presence asserted)');
      const b = await makeWorker('B');
      await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
      await runTurn(b.sessionId, b.workerId, TURN_TEXT);
      const bServers = await discoveredServers(b.sessionId, b.workerId);
      console.log(`  B (polarity) discovered servers: ${JSON.stringify(bServers)}`);

      expect(
        hasConnectorScope(bServers),
        '--expect-connectors-present: worker B (toggle SET) still observed a scope:"connector" row -- ' +
          'EXPECTED TO FAIL on this, correctly-fixed tree; a PASS here means the toggle is NOT ' +
          'actually suppressing connectors, or (see the KNOWN LIMITATION in the header) the host ' +
          'account has no connectors to observe at all',
        JSON.stringify(bServers),
      );
    }
  } finally {
    // Removed FIRST, before anything else in this block: claudeConfigDir
    // holds a COPY of the operator's real Claude Code credentials, so this
    // minimizes how long that copy sits on disk if a later cleanup step
    // (deactivate / shutdownAppContext / appServer.stop()) throws.
    if (claudeConfigDir) Bun.spawnSync(['rm', '-rf', claudeConfigDir]);
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
    for (const dir of [realConfigDir, realCwd]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
  }

  if (inconclusive) {
    console.error(`\n==> INCONCLUSIVE: ${inconclusive}`);
    console.error(`==> ${passes} passed, ${failures.length} failed before the inconclusive stop`);
    process.exit(1);
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then(() => {
      console.log(`\n==> ${passes} passed, ${failures.length} failed`);
      if (failures.length > 0) {
        for (const f of failures) console.error(`  FAILED: ${f}`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nPROBE COULD NOT RUN (or aborted before completing its assertions):');
      console.error(err);
      console.error(`\n==> ${passes} passed, ${failures.length} failed before the abort`);
      process.exit(2);
    });
}
