#!/usr/bin/env bun
/**
 * Post-deploy smoke test for embedded-agent worker elevation (Phase 4).
 *
 * Drives the REAL shipping path -- `SessionManager.activateEmbeddedAgentWorker`
 * spawning the REAL embedded-agent loop subprocess via the REAL production
 * `spawnAsUser` -- against a REAL second OS user, with `AUTH_MODE=multi-user`
 * and `AGENT_CONSOLE_MCP_AUTH=enforce` both forced on. This is the smoke bullet
 * referenced by docs/design/embedded-agent-worker.md Part II Testing plan.
 *
 * What this smoke exercises:
 *   - `resolveEmbeddedAgentEntryPath()` actually resolves via the
 *     package-resolution branch (`@agent-console/embedded-agent/package.json`),
 *     not the dev-source-tree fallback. Unit tests cannot distinguish the two
 *     branches on a dev checkout, where BOTH resolve to the same file -- only a
 *     real deploy layout (where the fallback's relative path would be wrong)
 *     can prove which branch actually ran.
 *   - The REAL `sudo -u <target-user> ... -i sh -c 'bun <entry>'` elevation
 *     argv, spawned by the REAL `spawnAsUser`, against a REAL second OS user.
 *   - The loop's init handshake completing end-to-end against a REAL `/mcp`
 *     Streamable-HTTP endpoint running in `AGENT_CONSOLE_MCP_AUTH=enforce`
 *     mode -- proving Phase 4's enforce-by-default flip does not break the
 *     already-working embedded-agent token delivery (Phase 2).
 *   - Negative secret assertions against the REAL `/proc/<pid>/cmdline` and
 *     `/proc/<pid>/environ` of the elevated subprocess: neither the MCP
 *     bearer token nor the provider API key must appear in either file.
 *
 * What this smoke does NOT exercise:
 *   - The full user-message / tool-call / final-answer turn. `ready` fires at
 *     the end of the init handshake (loop's own MCP `listTools()` call),
 *     BEFORE any user message -- this smoke stops there. The full turn is
 *     already covered by the shipping-path E2E test at
 *     `packages/integration/src/embedded-agent-e2e.test.ts` (single-user mode).
 *   - Provider round-trip behavior. The stub provider server is inert (404s
 *     everything); the smoke never sends a user-message, so the provider is
 *     never dialed. The `provider.baseUrl` field is only present because the
 *     embedded-agent definition schema requires it.
 *   - AGENT_CONSOLE_MCP_AUTH's "unset defaults to enforce in multi-user mode"
 *     resolution logic. That default is unit-tested directly
 *     (`packages/server/src/mcp/__tests__/mcp-auth.test.ts`); this smoke sets
 *     `AGENT_CONSOLE_MCP_AUTH=enforce` explicitly to exercise the enforce path
 *     without depending on that default.
 *
 * Usage:
 *   bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>
 *
 * Requirements:
 *   - Run as a user with elevation privilege for <target-user> (a working,
 *     non-interactive `sudo -u <target-user> -i ...` path). On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (sudoers rules from scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *   - `bun install` must have wired `@agent-console/embedded-agent` into the
 *     server package's workspace resolution (true for any checkout that ran
 *     the repo's normal install step) -- otherwise the package-resolution
 *     assertion below fails by design.
 *   - Degenerate mode: passing the CURRENT process user as <target-user>
 *     exercises the entire pipeline (entry resolution, real subprocess, real
 *     MCP enforce handshake, /proc negative checks) EXCEPT the actual
 *     cross-user `sudo` boundary crossing, since `spawnAsUser` bypasses
 *     elevation when the target user equals the server-process user. Useful
 *     when no second OS user + configured elevation is available.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing target user, launch failure)
 *
 * Sync contract: entry-path resolution is imported directly from
 * `resolveEmbeddedAgentEntryPath` (packages/server/src/services/
 * embedded-agent-worker-service.ts) -- the exact function
 * `EmbeddedAgentWorkerService` uses for its own default. No replication.
 */

// Ad-hoc invocation inherits cwd from the caller (often /root or an
// interactive user's home, neither readable by an elevation-target service
// account). Bun's spawn machinery evaluates the calling process's cwd, and an
// inherited unreadable cwd produces EACCES on posix_spawn (same root cause
// documented in check-multiuser-pty-env.ts). Neutralize at script start.
process.chdir('/');

const targetUsername = process.argv[2];
if (!targetUsername) {
  console.error('usage: bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>');
  process.exit(2);
}

// --- CRITICAL ordering: env vars must be set before ANY module that reads
// `serverConfig.AUTH_MODE` is evaluated. `packages/server/src/lib/
// server-config.ts` computes `AUTH_MODE` via a top-level IIFE at MODULE-LOAD
// time (`AUTH_MODE: (() => { ... })()`), not at call time. ES module static
// imports are evaluated in dependency order BEFORE this script's own
// top-level statements run, regardless of where an `import` declaration sits
// textually in the file -- so a `process.env.AUTH_MODE = ...` statement
// placed even at the literal top of this file would still run AFTER a static
// `import { createTestContext } from '../../packages/server/src/app-context.js'`
// elsewhere in the file, because that import's module graph (which pulls in
// server-config.ts transitively) is resolved and evaluated first.
//
// The only way to guarantee ordering in a single script is to defer every
// import that transitively touches server-config.ts to a DYNAMIC `import()`
// call, made from inside `main()`, AFTER the env vars below are set. Modules
// that do not transitively import server-config.ts (node:os, node:path,
// node:crypto, hono, @agent-console/shared) are safe as static imports.
//
// Verified empirically during smoke development: a temporary
// `console.log(serverConfig.AUTH_MODE)` placed as the first line inside
// `main()` printed 'multi-user' (not 'none'), confirming this ordering holds.
process.env.AUTH_MODE = 'multi-user';
process.env.AGENT_CONSOLE_MCP_AUTH = 'enforce';

import * as os from 'node:os';
import * as path from 'node:path';
// Type-only imports are erased at compile time -- they do NOT trigger module
// evaluation, so they are safe above the env-var prelude despite the module
// they point at (app-context.ts) transitively importing server-config.ts, and
// despite packages/shared internally importing valibot.
import type { AppContext } from '../../packages/server/src/app-context.js';

/**
 * Minimal shape this smoke needs from an `EmbeddedAgentStreamEvent` line.
 * Deliberately NOT full valibot schema validation (unlike the shipping-path
 * E2E test): the smoke's job is to detect the `ready` / `fatal` / `turn-error`
 * signals that decide pass/fail, not to re-prove protocol conformance (already
 * exhaustively covered by packages/shared/src/schemas/__tests__/embedded-agent.test.ts
 * and the E2E test). This also sidesteps a real dependency-resolution
 * constraint: `scripts/smoke/` has no `node_modules` ancestry containing
 * `valibot` (it is only hoisted under `packages/shared/node_modules` and
 * `packages/server/node_modules`), so importing the `valibot` package
 * directly from this script would fail to resolve at runtime.
 */
function parseStreamEventLine(line: string): { type: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof json === 'object' && json !== null && typeof (json as { type?: unknown }).type === 'string') {
    return json as { type: string };
  }
  return undefined;
}

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

async function main(): Promise<void> {
  // --- Deferred imports: everything below transitively imports server-config.ts,
  // so it must be dynamically imported AFTER the env vars above are set.
  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.js');
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { resolveEmbeddedAgentEntryPath } = await import(
    '../../packages/server/src/services/embedded-agent-worker-service.js'
  );

  // `hono` is only hoisted under packages/server/node_modules (and
  // packages/client, packages/shared), not under any node_modules ancestor of
  // scripts/smoke/ -- a bare `import { Hono } from 'hono'` in THIS file would
  // fail to resolve at runtime. Resolve it as packages/server would (same
  // technique `resolveEmbeddedAgentEntryPath` uses for the embedded-agent
  // package edge) and import the resolved absolute path instead.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // Not typed against the `hono` package's own declarations (that would
  // require resolving the 'hono' type-declaration module from THIS file's
  // location, hitting the same node_modules-ancestry gap as the runtime
  // import above). Loosely typed is acceptable here: scripts/smoke/ is not
  // part of the `bun run typecheck` pipeline (no tsconfig covers `scripts/`),
  // and Bun strips types at runtime regardless.
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
    // --- Assertion 1: entry-path resolution takes the package-resolution branch. ---
    console.log('==> entry-path resolution');
    const resolution = resolveEmbeddedAgentEntryPath();
    console.log(`  resolved path:   ${resolution.path}`);
    console.log(`  resolved source: ${resolution.source}`);
    expect(
      resolution.source === 'package',
      "resolveEmbeddedAgentEntryPath() took the package-resolution branch (not the dev-source-tree fallback)",
      `got source='${resolution.source}'; a real deploy where the workspace package edge is not installed is exactly the failure mode this smoke exists to catch`,
    );
    expect(
      await Bun.file(resolution.path).exists(),
      'resolved entry path exists on disk',
      resolution.path,
    );

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
          ' pipeline except the actual sudo OS-user-boundary crossing.',
      );
    }

    // --- Fixture 1: inert stub OpenAI-compatible provider. The loop is never
    // sent a user-message, so this server only needs to exist (its baseUrl is
    // a required definition field) -- it is never actually dialed. ---
    stubServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response('not found (smoke never sends a user-message)', { status: 404 });
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
    realConfigDir = path.join(os.tmpdir(), `ac-embedded-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;
    const apiKeyRef = 'smoke-provider-key';
    const fakeApiKey = `smoke-test-fake-key-${crypto.randomUUID()}`;
    const providerKeysPath = path.join(realConfigDir, 'provider-keys.json');
    await Bun.write(providerKeysPath, JSON.stringify({ [apiKeyRef]: fakeApiKey }));
    Bun.spawnSync(['chmod', '600', providerKeysPath]);

    // --- Fixture 2: real app server (real /api router + real /mcp app),
    // mirroring packages/integration/src/embedded-agent-e2e.test.ts almost
    // verbatim. Records the Authorization header of every real HTTP request to
    // /mcp (observes, does not intercept). ---
    const capturedMcpAuth: string[] = [];
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      c.set('appContext', ctx!);
      await next();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      if (c.req.path === '/mcp') {
        const auth = c.req.header('authorization');
        if (auth) capturedMcpAuth.push(auth);
      }
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
    console.log(`==> real app server on :${appServer.port}, /mcp in AGENT_CONSOLE_MCP_AUTH=enforce mode`);

    // Subprocess cwd must exist on the REAL filesystem.
    realCwd = path.join(os.tmpdir(), `ac-embedded-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);

    // --- Create the embedded-agent definition through the REAL REST route,
    // referencing the fake provider key via apiKeyRef. ---
    const createRes = await app.fetch(
      new Request('http://localhost/api/embedded-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Smoke inert LLM',
          provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'smoke-model', apiKeyRef },
        }),
      }),
    );
    if (createRes.status !== 201) {
      console.error(`PROBE FAILED: definition create returned ${createRes.status}`);
      console.error(await createRes.text());
      throw new Error(`embedded-agent definition create returned ${createRes.status}`);
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
      throw new Error('createWorker returned null');
    }
    workerId = worker.id;

    console.log(`==> activating embedded-agent worker (session=${sessionId} worker=${workerId})`);
    console.log(`  spawnAsUser target username: ${targetUsername} (elevated: ${!degenerate})`);
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

    // --- Poll the replayed NDJSON history for `ready` (or a loud failure). ---
    // Uses the lightweight `parseStreamEventLine` structural check (see its
    // doc comment) rather than full valibot schema validation.
    const readEvents = async (): Promise<Array<{ type: string } & Record<string, unknown>>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId!, workerId!);
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      if (hist) {
        for (const line of hist.data.split('\n')) {
          if (line.trim() === '') continue;
          const parsed = parseStreamEventLine(line);
          if (parsed) events.push(parsed as { type: string } & Record<string, unknown>);
        }
      }
      return events;
    };

    console.log('==> waiting for `ready` (init handshake incl. real MCP listTools() call)');
    const deadline = Date.now() + 30_000;
    let sawReady = false;
    let lastEvents: Array<{ type: string } & Record<string, unknown>> = [];
    while (Date.now() < deadline) {
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
        'PROBE FAILED: did not reach `ready` within 30s -- this could mean elevation failed,' +
          ' MCP enforce auth failed, or the loop crashed. Observed event types: ' +
          JSON.stringify(lastEvents.map((e) => e.type)),
      );
      const internalWorkerForStderr = ctx.sessionManager.getWorker(sessionId, workerId);
      if (internalWorkerForStderr?.type === 'embedded-agent' && internalWorkerForStderr.subprocess) {
        console.error(`  subprocess pid: ${internalWorkerForStderr.subprocess.pid}`);
      }
    }
    expect(sawReady, 'reached `ready` (init handshake incl. real MCP call under AGENT_CONSOLE_MCP_AUTH=enforce)');

    // --- Real bearer token hit the real /mcp endpoint (mirrors the E2E test's assertion). ---
    expect(capturedMcpAuth.length > 0, 'the init-minted MCP bearer token hit the real /mcp endpoint');
    let capturedToken: string | undefined;
    if (capturedMcpAuth.length > 0) {
      const match = /^Bearer\s+([0-9a-f]{64})$/.exec(capturedMcpAuth[0]);
      expect(match !== null, 'captured Authorization header has the expected Bearer <64-hex> shape', capturedMcpAuth[0]);
      capturedToken = match?.[1];
    }

    // --- Negative secret assertions against the REAL /proc of the elevated subprocess. ---
    console.log('==> /proc negative secret assertions (cmdline + environ)');
    if (process.platform !== 'linux') {
      console.warn('  WARN  not running on Linux -- /proc assertions gracefully skipped (did NOT run)');
    } else {
      const internalWorker = ctx.sessionManager.getWorker(sessionId, workerId);
      const pid =
        internalWorker && internalWorker.type === 'embedded-agent'
          ? internalWorker.subprocess?.pid
          : undefined;
      expect(pid !== undefined, 'subprocess pid is known while activated');

      const secrets: Array<{ label: string; value: string | undefined }> = [
        { label: 'MCP bearer token', value: capturedToken },
        { label: 'provider API key', value: fakeApiKey },
      ];

      for (const secret of secrets) {
        if (secret.value === undefined) {
          expect(false, `${secret.label} negative /proc check actually ran`, 'no captured value to check against');
          continue;
        }
        let procAssertionRan = false;
        let leaked = false;
        if (pid !== undefined) {
          for (const procFile of ['cmdline', 'environ']) {
            const file = Bun.file(`/proc/${pid}/${procFile}`);
            if (await file.exists()) {
              const content = await file.text().catch(() => null);
              if (content !== null) {
                procAssertionRan = true;
                if (content.includes(secret.value)) leaked = true;
              }
            }
          }
        }
        // A silently-skipped check (process already exited, unknown pid,
        // unreadable /proc) is a FAILURE, not a pass -- distinct from the
        // Linux-only graceful skip above.
        expect(
          procAssertionRan,
          `${secret.label} negative /proc check actually ran (not silently skipped)`,
        );
        expect(!leaked, `${secret.label} does NOT appear in /proc/${pid}/cmdline or /environ`);
      }
    }
  } catch (err) {
    console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    failures.push('unexpected exception during smoke run');
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
