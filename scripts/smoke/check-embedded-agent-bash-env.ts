#!/usr/bin/env bun
/**
 * Post-deploy smoke test for the embedded-agent `Bash` builtin tool's
 * multi-user env non-leakage contract (FF-1b, Issue #1043).
 *
 * This is the sibling of `check-embedded-agent-elevation.ts` that goes one
 * step further: that script stops at the init handshake's `ready` event and
 * never dials the provider. This script drives a REAL scripted turn through
 * to an actual `Bash` tool-call/result round trip, against a REAL second OS
 * user, so it can assert:
 *
 *   (a) the Bash tool's `env` output shows `USER=`/`LOGNAME=` equal to the
 *       target user -- proof the tool actually ran as the target OS user
 *       under real elevation, not the server-process user.
 *   (b) no `AGENT_CONSOLE_*`-prefixed env var appears in that output --
 *       proof `buildBashEnv`'s strip (packages/embedded-agent/src/tools/
 *       env-cleaner.ts) survives the real spawnAsUser -> login-shell-init ->
 *       loop-subprocess -> Bash-child chain, not just the unit-test's direct
 *       in-process call.
 *   (c) the provider's fake API key does not leak into that output either.
 *
 * This is the smoke bullet Issue #1043's AC calls "Multi-user smoke: on the
 * dogfood host, running the smoke script under a second user asserts (a)
 * `whoami` in Bash tool output = target user, (b) env does not leak."
 *
 * What this smoke does NOT exercise:
 *   - MCP bearer-token / enforce-mode auth (already covered end-to-end by
 *     `check-embedded-agent-elevation.ts`; this script does not bother
 *     capturing the `/mcp` Authorization header).
 *   - Anything about `Read`/`Glob`/`Grep` (FF-1a) or `Write`/`Edit` (FF-1c).
 *   - Process-group-kill-on-timeout semantics (already unit-tested in
 *     `packages/embedded-agent/src/tools/__tests__/bash.test.ts`; a
 *     multi-second real-machine kill test is not worth the smoke's runtime).
 *
 * Usage:
 *   bun scripts/smoke/check-embedded-agent-bash-env.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with elevation privilege for <target-user> (a working,
 *     non-interactive `sudo -u <target-user> -i ...` path). On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (sudoers rules from scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *   - `bun install` must have wired `@agent-console/embedded-agent` into the
 *     server package's workspace resolution (true for any checkout that ran
 *     the repo's normal install step).
 *   - Degenerate mode: passing the CURRENT process user as <target-user>
 *     exercises the entire pipeline (Bash tool spawn, env strip, tool-call
 *     round trip) EXCEPT the actual cross-user `sudo` boundary crossing,
 *     since `spawnAsUser` bypasses elevation when the target user equals the
 *     server-process user. Useful when no second OS user + configured
 *     elevation is available.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing target user, launch failure)
 *
 * Sync contract: this smoke never replicates the Bash tool's spawn or env-
 * strip logic. It drives the REAL loop subprocess (spawned via the REAL
 * production `spawnAsUser`, itself resolved the same way
 * `check-embedded-agent-elevation.ts` verifies) through a scripted provider
 * turn that requests the REAL `Bash` tool, whose implementation is entirely
 * `packages/embedded-agent/src/tools/bash.ts` + `env-cleaner.ts`. No env-
 * cleaning or process-spawn logic is duplicated here.
 */

// Ad-hoc invocation inherits cwd from the caller (often /root or an
// interactive user's home, neither readable by an elevation-target service
// account). Bun's spawn machinery evaluates the calling process's cwd, and an
// inherited unreadable cwd produces EACCES on posix_spawn (same root cause
// documented in check-multiuser-pty-env.ts). Neutralize at script start.
process.chdir('/');

const targetUsername = process.argv[2];
if (!targetUsername) {
  console.error('usage: bun scripts/smoke/check-embedded-agent-bash-env.ts <target-user>');
  process.exit(2);
}

// --- CRITICAL ordering: env vars must be set before ANY module that reads
// `serverConfig.AUTH_MODE` is evaluated. See the identical header comment in
// `check-embedded-agent-elevation.ts` for the full explanation of why every
// import that transitively touches `packages/server/src/lib/server-config.ts`
// must be a DYNAMIC `import()` from inside `main()`, made AFTER this
// assignment runs.
process.env.AUTH_MODE = 'multi-user';

import * as os from 'node:os';
import * as path from 'node:path';
// Type-only imports are erased at compile time -- safe above the env-var
// prelude despite the module they point at transitively importing
// server-config.ts.
import type { AppContext } from '../../packages/server/src/app-context.js';

/**
 * Minimal shape this smoke needs from an `EmbeddedAgentStreamEvent` line.
 * Deliberately NOT full valibot schema validation -- see the identical
 * rationale in `check-embedded-agent-elevation.ts`'s doc comment
 * (protocol-conformance is already exhaustively covered elsewhere; this
 * smoke's job is to detect the specific event types that decide pass/fail,
 * and `scripts/smoke/` has no `node_modules` ancestry containing `valibot`).
 */
function parseStreamEventLine(line: string): ({ type: string } & Record<string, unknown>) | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof json === 'object' && json !== null && typeof (json as { type?: unknown }).type === 'string') {
    return json as { type: string } & Record<string, unknown>;
  }
  return undefined;
}

/**
 * Marks a setup/launch failure (e.g. fixture creation, definition creation,
 * worker creation) distinct from an unexpected exception during the actual
 * probe run. Caught separately in `main()`'s catch block so a setup failure
 * exits `2` (per this script's documented exit-code contract) instead of
 * being folded into `failures` and exiting `1` like a genuine assertion
 * failure.
 */
class SmokeSetupError extends Error {}

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string): void => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** First provider turn (no role:'tool' message present yet): one Bash tool call. */
function bashToolCallSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: 'Dumping the environment.' }, finish_reason: null }] }) +
    sseEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'env' }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  );
}

/** Second provider turn (a role:'tool' message is now present): short final answer. */
function finalAnswerSse(): string {
  return (
    sseEvent({ choices: [{ delta: { content: 'Done.' }, finish_reason: null }] }) +
    sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n'
  );
}

async function main(): Promise<void> {
  // --- Deferred imports: everything below transitively imports server-config.ts,
  // so it must be dynamically imported AFTER the env vars above are set.
  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.js');
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');

  // `hono` is only hoisted under packages/server/node_modules (and
  // packages/client, packages/shared), not under any node_modules ancestor of
  // scripts/smoke/ -- a bare `import { Hono } from 'hono'` in THIS file would
  // fail to resolve at runtime. Resolve it as packages/server would, same
  // technique as `check-embedded-agent-elevation.ts`.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // Not typed against the `hono` package's own declarations -- see the
  // identical note in check-embedded-agent-elevation.ts. scripts/smoke/ is
  // not part of `bun run typecheck` (no tsconfig covers `scripts/`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;
  let realConfigDir: string | undefined;
  let sessionId: string | undefined;
  let workerId: string | undefined;

  try {
    // --- Resolve the REAL target OS user (uid + home) via the production lookup. ---
    console.log('==> resolving real target OS user');
    const osUser = await lookupOsUser(targetUsername);
    if (!osUser) {
      console.error(`PROBE FAILED: could not resolve OS user '${targetUsername}' via lookupOsUser`);
      process.exit(2);
    }
    console.log(`  uid=${osUser.uid} home=${osUser.homeDir}`);
    const serverUsername = os.userInfo().username;
    const degenerate = targetUsername === serverUsername;
    if (degenerate) {
      console.warn(
        `  WARN  target user '${targetUsername}' equals the server-process user; spawnAsUser` +
          ' will bypass elevation (degenerate same-user mode). This still exercises the full' +
          ' Bash tool-call round trip except the actual sudo OS-user-boundary crossing.',
      );
    }

    // --- Fixture 1: scripted stub OpenAI-compatible provider. Dispatches on
    // whether the request's `messages` array already contains a role:'tool'
    // entry -- first turn asks for a Bash `env` call, second turn (after the
    // tool result is fed back) returns a short final answer. Mirrors
    // packages/integration/src/embedded-agent-e2e.test.ts's stub dispatch. ---
    interface ChatCompletionRequestBody {
      messages?: Array<{ role?: string; content?: string }>;
    }
    stubServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const body = (await req.json()) as ChatCompletionRequestBody;
          const hasToolMsg = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
          const sse = hasToolMsg ? finalAnswerSse() : bashToolCallSse();
          return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const stubBaseUrl = `http://localhost:${stubServer.port}`;

    // --- Real AppContext (in-memory SQLite via createTestContext), with the
    // loop's MCP base URL late-bound to the real app server's ephemeral port. ---
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    // Real target-user identity: session.createdBy -> resolveSpawnUsername
    // resolves to this user's REAL username, so spawnAsUser actually elevates.
    const targetUser = await ctx.userRepository.upsertByOsUid(
      osUser.uid,
      targetUsername,
      osUser.homeDir,
    );

    // --- Real temp provider-keys.json (0600), AGENT_CONSOLE_HOME pointed at a
    // real temp dir BEFORE any activation reads it via loadProviderKey/getConfigDir.
    // getConfigDir() reads process.env.AGENT_CONSOLE_HOME at CALL time (not
    // module load time), so this override is safe post-import. ---
    realConfigDir = path.join(os.tmpdir(), `ac-embedded-bash-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;
    const apiKeyRef = 'smoke-provider-key';
    const fakeApiKey = `smoke-test-fake-key-${crypto.randomUUID()}`;
    const providerKeysPath = path.join(realConfigDir, 'provider-keys.json');
    await Bun.write(providerKeysPath, JSON.stringify({ [apiKeyRef]: fakeApiKey }));
    Bun.spawnSync(['chmod', '600', providerKeysPath]);

    // --- Fixture 2: real app server (real /api router + real /mcp app),
    // mirroring check-embedded-agent-elevation.ts. This smoke's job is the
    // Bash env-leak assertion, not MCP-auth verification (already covered by
    // the elevation smoke), so no auth-header capture middleware here. ---
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    const mcpApp = createMcpApp({
      sessionManager: ctx.sessionManager,
      repositoryManager: ctx.repositoryManager,
      agentManager: ctx.agentManager,
      timerManager: ctx.timerManager,
      conditionalWakeupManager: ctx.conditionalWakeupManager,
      interactiveProcessManager: ctx.interactiveProcessManager,
      worktreeService: ctx.worktreeService,
      annotationService: ctx.annotationService,
      interSessionMessageService: ctx.interSessionMessageService,
      suggestSessionMetadata: ctx.suggestSessionMetadata,
      createWorktreeWithSession: (
        await import('../../packages/server/src/services/worktree-creation-service.js')
      ).createWorktreeWithSession,
      deleteWorktree: (await import('../../packages/server/src/services/worktree-deletion-service.js'))
        .deleteWorktree,
      userRepository: ctx.userRepository,
      broadcastToApp: ctx.broadcastToApp,
      fetchPullRequestUrl: ctx.fetchPullRequestUrl,
      findOpenPullRequest: ctx.findOpenPullRequest,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
    });
    app.route('', mcpApp);

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;
    console.log(`==> real app server on :${appServer.port}`);

    // Subprocess cwd must exist on the REAL filesystem.
    realCwd = path.join(os.tmpdir(), `ac-embedded-bash-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);

    // --- Create the embedded-agent definition through the REAL REST route,
    // with `enabledTools: ['Bash']` -- the critical difference from the
    // elevation smoke's definition (no enabledTools -> read-only default,
    // under which Bash is never even represented in the provider's tools
    // list, let alone invoked). ---
    const createRes = await app.fetch(
      new Request('http://localhost/api/embedded-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Smoke Bash-env LLM',
          provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'smoke-model', apiKeyRef },
          enabledTools: ['Bash'],
        }),
      }),
    );
    if (createRes.status !== 201) {
      console.error(`PROBE FAILED: definition create returned ${createRes.status}`);
      console.error(await createRes.text());
      throw new SmokeSetupError(`embedded-agent definition create returned ${createRes.status}`);
    }
    const createBody = (await createRes.json()) as { embeddedAgent: { id: string } };
    const embeddedAgentId = createBody.embeddedAgent.id;

    // --- Session owned by the REAL target user, worker, activation. ---
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: realCwd, agentId: 'claude-code-builtin' },
      { createdBy: targetUser.id },
    );
    sessionId = session.id;

    const worker = await ctx.sessionManager.createWorker(sessionId, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    if (!worker) {
      throw new SmokeSetupError('createWorker returned null');
    }
    workerId = worker.id;

    console.log(`==> activating embedded-agent worker (session=${sessionId} worker=${workerId})`);
    console.log(`  spawnAsUser target username: ${targetUsername} (elevated: ${!degenerate})`);
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

    // --- Poll the replayed NDJSON history for `ready` (or a loud failure). ---
    const readEvents = async (): Promise<Array<{ type: string } & Record<string, unknown>>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId!, workerId!);
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      if (hist) {
        for (const line of hist.data.split('\n')) {
          if (line.trim() === '') continue;
          const parsed = parseStreamEventLine(line);
          if (parsed) events.push(parsed);
        }
      }
      return events;
    };

    console.log('==> waiting for `ready` (init handshake)');
    const readyDeadline = Date.now() + 30_000;
    let sawReady = false;
    let lastEvents: Array<{ type: string } & Record<string, unknown>> = [];
    while (Date.now() < readyDeadline) {
      const events = await readEvents();
      lastEvents = events;
      const fatal = events.find((e) => e.type === 'fatal');
      if (fatal) {
        console.error(`PROBE FAILED: loop emitted a fatal event: ${String(fatal.message)}`);
        break;
      }
      const turnErr = events.find((e) => e.type === 'turn-error');
      if (turnErr) {
        console.error(`PROBE FAILED: loop emitted a turn-error event: ${String(turnErr.message)}`);
        break;
      }
      if (events.some((e) => e.type === 'ready')) {
        sawReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!sawReady) {
      console.error(
        'PROBE FAILED: did not reach `ready` within 30s -- this could mean elevation failed or' +
          ' the loop crashed. Observed event types: ' +
          JSON.stringify(lastEvents.map((e) => e.type)),
      );
    }
    expect(sawReady, 'reached `ready` (init handshake)');

    if (!sawReady) {
      // No point sending a user message into a loop that never became ready.
      return;
    }

    // --- Drive the scripted turn: send a user message, wait for the Bash
    // tool-result (or a loud failure). ---
    console.log('==> sending user message to trigger the scripted Bash tool call');
    const sendResult = await ctx.sessionManager.sendEmbeddedAgentUserMessage(
      sessionId,
      workerId,
      'dump the environment',
    );
    expect(sendResult.ok === true, 'sendEmbeddedAgentUserMessage accepted the message', JSON.stringify(sendResult));

    console.log('==> waiting for the Bash tool-result (or a loud failure)');
    const turnDeadline = Date.now() + 30_000;
    let bashResult: string | undefined;
    let sawTurnFailure = false;
    lastEvents = [];
    while (Date.now() < turnDeadline) {
      const events = await readEvents();
      lastEvents = events;
      const fatal = events.find((e) => e.type === 'fatal');
      if (fatal) {
        console.error(`PROBE FAILED: loop emitted a fatal event: ${String(fatal.message)}`);
        sawTurnFailure = true;
        break;
      }
      const turnErr = events.find((e) => e.type === 'turn-error');
      if (turnErr) {
        console.error(`PROBE FAILED: loop emitted a turn-error event: ${String(turnErr.message)}`);
        sawTurnFailure = true;
        break;
      }
      // `tool-result` events do not carry the tool name (only `callId`); look
      // up the matching `tool-call` by callId to confirm it was the Bash call.
      const bashCall = events.find((e) => e.type === 'tool-call' && e.name === 'Bash');
      if (bashCall) {
        const matchingResult = events.find(
          (e) => e.type === 'tool-result' && e.callId === bashCall.callId,
        );
        if (matchingResult && typeof matchingResult.result === 'string') {
          bashResult = matchingResult.result;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!sawTurnFailure && bashResult === undefined) {
      console.error(
        'PROBE FAILED: did not observe a Bash tool-result within 30s. Observed event types: ' +
          JSON.stringify(lastEvents.map((e) => e.type)),
      );
    }
    // A silently-skipped assertion (never finding the tool-result event) is a
    // FAILURE, not a pass -- same discipline as the elevation smoke's /proc
    // checks.
    expect(bashResult !== undefined, 'observed the Bash tool-result event');

    if (bashResult !== undefined) {
      console.log('==> Bash tool-result env-leak assertions');

      // (a) whoami-equivalent: the `env` dump's USER=/LOGNAME= line matches
      // the target OS user -- proof the Bash tool ran as the target user
      // under real elevation, not the server-process user.
      const escapedUser = targetUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const userLineRe = new RegExp(`(^|\\n)(USER|LOGNAME)=${escapedUser}($|\\n)`);
      expect(
        userLineRe.test(bashResult),
        `Bash tool env output shows USER=/LOGNAME=${targetUsername}`,
        bashResult.slice(0, 2000),
      );

      // (b) Negative: no AGENT_CONSOLE_*-prefixed env var leaked into the
      // Bash child's env. Line-anchored regex, NOT a bare substring check --
      // see packages/embedded-agent/src/tools/__tests__/bash.test.ts's
      // identical caveat: a delegated/elevated agent-console session's
      // ambient SUDO_COMMAND env var can legitimately contain the literal
      // text "AGENT_CONSOLE_" (from the sudo invocation's own `export
      // AGENT_CONSOLE_SESSION_ID=...` command line) without that being a
      // leak of buildBashEnv's key-based filtering.
      const leakedAgentConsoleVar = /(^|\n)AGENT_CONSOLE_[A-Za-z0-9_]*=/.test(bashResult);
      expect(!leakedAgentConsoleVar, 'no AGENT_CONSOLE_*-prefixed env var leaked into the Bash tool output');

      // (c) Negative: the provider's fake API key does not leak either.
      expect(!bashResult.includes(fakeApiKey), 'provider API key does not appear in the Bash tool output');
    }

    // --- Wait for the turn to fully settle (final assistant message / idle)
    // before deactivating, so deactivation doesn't race an in-flight turn. ---
    const idleDeadline = Date.now() + 10_000;
    while (Date.now() < idleDeadline) {
      const events = await readEvents();
      const lastState = [...events].reverse().find((e) => e.type === 'state');
      if (lastState && lastState.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    if (err instanceof SmokeSetupError) {
      console.error('PROBE FAILED: smoke could not run to completion (setup/launch failure)');
      console.error(err.stack ?? err.message);
      process.exitCode = 2;
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup');
    if (ctx && sessionId && workerId) {
      try {
        await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);
      } catch (err) {
        console.warn('  cleanup: deactivate failed (best-effort):', err);
      }
    }
    if (ctx) {
      try {
        await shutdownAppContext(ctx);
      } catch (err) {
        console.warn('  cleanup: shutdownAppContext failed (best-effort):', err);
      }
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    try {
      stubServer?.stop(true);
    } catch {
      // best-effort
    }
    if (realCwd) {
      Bun.spawnSync(['rm', '-rf', realCwd]);
    }
    if (realConfigDir) {
      Bun.spawnSync(['rm', '-rf', realConfigDir]);
    }
  }

  console.log();
  if (process.exitCode === 2) {
    // Setup/launch failure was already logged above; finally-block cleanup
    // has already run (normal try/catch/finally ordering) by the time we
    // reach this point.
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
