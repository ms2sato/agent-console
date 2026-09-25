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
 * `--expect-connectors-present` (a control run, not a "break-the-fix"
 * polarity run -- there is no source-level toggle to flip for this
 * mechanism the way other smokes' `--expect-*` flags revert a code fix).
 * It skips the PATCH step entirely and drives worker B through the SAME
 * activate-and-turn sequence with the preference left at its default
 * (false, connectors ON), then asserts B's discovered event(s) DO contain
 * a `scope: 'connector'` row. This is the same-run positive-control shape
 * `workflow.md`'s "a check's existence is not its detection power" asks
 * for, applied to worker B specifically: it confirms B's own harness
 * (fresh worker, fresh session, same user, same turn text) is capable of
 * observing connectors at all, so the default run's "B: zero connector
 * rows" assertion is attributable to the toggle rather than to some
 * unrelated property of a freshly-created worker. Run this BEFORE the
 * default run, the same way sibling smokes run their `--expect-no-*`
 * control first.
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
 *   bun scripts/smoke/check-claude-sdk-connectors-toggle.ts -- --expect-connectors-present
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong), OR the run was
 *      INCONCLUSIVE (the host account has no connectors to observe) --
 *      never conflated with a clean pass
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

function parseExpectConnectorsPresent(): boolean {
  return process.argv.includes('--expect-connectors-present');
}

import * as os from 'node:os';
import * as path from 'node:path';
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

interface DiscoveredServer {
  name: string;
  scope: string;
  status: string;
}

async function main(): Promise<void> {
  const expectConnectorsPresent = parseExpectConnectorsPresent();

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
    console.log(`==> mode: ${expectConnectorsPresent ? '--expect-connectors-present (control)' : 'default'}`);

    // Isolated CLAUDE_CONFIG_DIR: preserves the real account's login
    // credentials (so the real, account-scoped claude.ai connectors are
    // still discoverable) while never touching the operator's real project
    // list / session history.
    claudeConfigDir = isolateClaudeConfigDir('connectors-toggle');

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-connectors-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

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

    if (!expectConnectorsPresent) {
      // --- Worker A: baseline, toggle at its migration default (OFF ->
      // connectors ON). No preference PATCH has happened yet for this user.
      console.log('==> worker A: activate + one turn (baseline, connectors expected ON)');
      const a = await makeWorker('A');
      await ctx.sessionManager.activateEmbeddedAgentWorker(a.sessionId, a.workerId);
      await runTurn(a.sessionId, a.workerId, TURN_TEXT);
      const aServers = await discoveredServers(a.sessionId, a.workerId);
      console.log(`  A discovered servers: ${JSON.stringify(aServers)}`);

      const aHasConnector = aServers.some((s) => s.scope === 'connector');
      if (!aHasConnector) {
        inconclusive =
          'the invoking OS user\'s Claude Code account has no claude.ai connectors configured -- ' +
          'worker A observed zero scope:"connector" rows, so there is nothing for the toggle to ' +
          'suppress and every downstream assertion in this run would be meaningless';
      } else {
        expect(true, 'worker A (baseline): observed at least one scope:"connector" row');

        // --- The real PATCH, through the real route, no cookie needed
        // (single-user mode's authenticate() always returns the cached
        // server-process user).
        console.log('==> PATCH /api/auth/me/preferences { disableClaudeAiConnectors: true }');
        const patchRes = await fetch(`http://localhost:${appServer.port}/api/auth/me/preferences`, {
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
          'PATCH response user is the same owner that created worker A',
          `expected ${owner.id}, got ${patchBody.user?.id}`,
        );

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
          !bServers.some((s) => s.scope === 'connector'),
          'worker B: zero scope:"connector" rows after the toggle was turned on',
          JSON.stringify(bServers),
        );
        expect(
          bServers.some((s) => s.name === 'agent-console'),
          'worker B: the reserved "agent-console" server is still present (not "nothing connected at all")',
          JSON.stringify(bServers),
        );
        expect(
          bServers.some((s) => s.name === 'console'),
          'worker B: the reserved "console" (Compact tool) server is still present',
          JSON.stringify(bServers),
        );
      }
    } else {
      // --- Control run: no PATCH at all. Worker B, on its own, fresh
      // session, same user, same turn text, with the preference left at
      // its default (false, connectors ON) -- must still observe a
      // connector. This licenses reading the default run's "zero connector
      // rows" as attributable to the toggle, not to some unrelated
      // property of a freshly-created worker/session.
      console.log('==> worker B (control): activate + one turn, no PATCH (connectors expected ON)');
      const b = await makeWorker('B-control');
      await ctx.sessionManager.activateEmbeddedAgentWorker(b.sessionId, b.workerId);
      await runTurn(b.sessionId, b.workerId, TURN_TEXT);
      const bServers = await discoveredServers(b.sessionId, b.workerId);
      console.log(`  B (control) discovered servers: ${JSON.stringify(bServers)}`);

      const bHasConnector = bServers.some((s) => s.scope === 'connector');
      if (!bHasConnector) {
        inconclusive =
          'the invoking OS user\'s Claude Code account has no claude.ai connectors configured -- ' +
          'the control worker observed zero scope:"connector" rows even with no PATCH applied, so ' +
          'this run cannot license the default run\'s "zero connector rows" reading as toggle-caused';
      } else {
        expect(
          true,
          '--expect-connectors-present control: worker B observed at least one scope:"connector" row with no PATCH applied',
        );
      }
    }
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
    for (const dir of [realConfigDir, realCwd, claudeConfigDir]) {
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
