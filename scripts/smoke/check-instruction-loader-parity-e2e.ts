#!/usr/bin/env bun
/**
 * Shipping-path E2E for Issue #1343's Phase A slice (project-instruction
 * parity on the SDK arm: one loader, `.claude/rules`, both engines).
 *
 * Modeled closely on `check-restart-all-embedded.ts` / the idle-eviction
 * smokes -- same disposable-server boilerplate, same real `AppContext` +
 * real `/mcp` + real embedded-agent workers spawned by the real
 * `EmbeddedAgentWorkerService`. What differs is the mechanism under test:
 * this is not a lifecycle event (restart / eviction), it is a single FIRST
 * turn on each engine, asking whether three pieces of content reached the
 * composed system prompt at activation:
 *
 *   - CLAUDE.md at the scratch repo's root (the pre-existing instructions
 *     chain layer, unaffected by Phase A but re-confirmed here as a
 *     no-regression baseline)
 *   - an UNSCOPED rule under `.claude/rules/*.md` (the new R2 layer --
 *     included eagerly, no frontmatter)
 *   - a NEGATIVE CONTROL under `.claude/rules-not/*.md` -- same file shape,
 *     wrong directory name; the loader only ever scans `.claude/rules`, so
 *     this must NEVER be honoured, on either engine
 *
 * All three checks run on BOTH `openai-api` and `claude-sdk` engines,
 * against the SAME scratch repo -- proving `loadInstructions` composes
 * identically for both, which is the whole point of R1.
 *
 * `settingSources: []` on the SDK arm is UNCHANGED by this PR (sdk-engine.ts
 * is not touched) and is already pinned at the unit level
 * (`packages/embedded-agent/src/__tests__/sdk-engine.test.ts`'s
 * `expect(options.settingSources).toEqual([])`), which runs in this PR's
 * full suite -- this script does not re-implement that capture, since
 * intercepting a live billed SDK session's `Options` from outside would be
 * strictly less reliable than the deterministic unit pin that already exists
 * for a file this PR does not modify.
 *
 * COST: two real turns (one per engine, no tool call needed -- this content
 * is eagerly loaded into the system prompt at activation, not something a
 * tool call would reveal). Small, but real money and real usage for the
 * `openai-api` arm and real Claude usage for the `claude-sdk` arm -- a
 * manual tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - `claude-sdk` arm: a real, authenticated `claude` CLI for the invoking
 *     OS user (the builtin runs as the executing user and uses that user's
 *     own authentication -- no API key to configure).
 *   - `openai-api` arm: a provider key store resolvable for
 *     `PROVIDER_KEY_REF` (default `opencode-go`, read from the single-user
 *     dev home; override with `PROVIDER_KEY_FILE`).
 *   - `bun install` already run in this checkout.
 *
 * USAGE
 *   bun scripts/smoke/check-instruction-loader-parity-e2e.ts
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- distinct from 1 so an operator can tell "the loader is
 *      broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every module that transitively imports server-config.ts must be
// loaded via a DYNAMIC import made from inside main(), not a static import
// at the top of this file -- same hazard as the sibling smokes (see
// check-embedded-agent-idle-eviction.ts's header comment for the full
// account).

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const CLAUDE_NONCE = `PROJECT-${Math.floor(Math.random() * 9000 + 1000)}`;
const RULE_NONCE = `RULE-${Math.floor(Math.random() * 9000 + 1000)}`;
const IGNORED_NONCE = `IGNORED-${Math.floor(Math.random() * 9000 + 1000)}`;

const ASK_TEXT =
  'Three words may or may not be available to you right now, in your own context: ' +
  'a "project word", a "rule word", and an "ignored word". For each of the three, ' +
  'either quote it exactly if you can see it verbatim in your own context, or say ' +
  'UNKNOWN if you cannot. Do not guess.';

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

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

async function main(): Promise<void> {
  process.chdir('/');

  console.log(`==> CLAUDE.md nonce:        ${CLAUDE_NONCE}`);
  console.log(`==> .claude/rules nonce:    ${RULE_NONCE}`);
  console.log(`==> .claude/rules-not nonce (must NOT appear): ${IGNORED_NONCE}`);

  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agent-manager.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realConfigDir: string | undefined;
  let realCwd: string | undefined;

  try {
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-1343-instruction-loader-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    // The provider key is copied into the disposable home (resolved
    // relative to AGENT_CONSOLE_HOME) rather than borrowing the dev home
    // wholesale -- same rationale as the idle-eviction openai-api smoke.
    let apiKey: string;
    try {
      const store = JSON.parse(readFileSync(PROVIDER_KEY_FILE, 'utf-8')) as Record<string, string>;
      if (typeof store[PROVIDER_KEY_REF] !== 'string') {
        throw new Error(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
      }
      apiKey = store[PROVIDER_KEY_REF];
    } catch (err) {
      throw new Error(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
    }
    await Bun.write(
      path.join(realConfigDir, 'provider-keys.json'),
      JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }),
    );
    Bun.spawnSync(['chmod', '600', path.join(realConfigDir, 'provider-keys.json')]);

    // --- Scratch git repo shared by both engines' workers.
    realCwd = path.join(os.tmpdir(), `ac-1343-instruction-loader-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.git')]);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.claude', 'rules')]);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.claude', 'rules-not')]);
    await Bun.write(path.join(realCwd, 'CLAUDE.md'), `The project word is ${CLAUDE_NONCE}.\n`);
    await Bun.write(
      path.join(realCwd, '.claude', 'rules', 'nonce-rule.md'),
      `# Nonce Rule\n\nThe rule word is ${RULE_NONCE}.\n`,
    );
    await Bun.write(
      path.join(realCwd, '.claude', 'rules-not', 'ignored.md'),
      `# Should Never Be Read\n\nThe ignored word is ${IGNORED_NONCE}.\n`,
    );

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

    const openaiDefinition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `instruction-loader-smoke-${process.pid}`,
        description: 'Disposable definition for the instruction-loader-parity E2E (Issue #1343 Phase A).',
        provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
      },
      owner.id,
    );
    console.log(`==> openai-api definition ${openaiDefinition.id}`);

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

    async function checkEngine(
      label: string,
      makeWorker: () => Promise<{ sessionId: string; workerId: string }>,
    ): Promise<void> {
      console.log(`==> ${label}: activate + ask`);
      const w = await makeWorker();
      await ctx!.sessionManager.activateEmbeddedAgentWorker(w.sessionId, w.workerId);
      const reply = await runTurn(w.sessionId, w.workerId, ASK_TEXT);
      console.log(`  ${label} reply: ${reply.trim().slice(0, 300)}`);

      expect(
        reply.includes(CLAUDE_NONCE),
        `${label}: CLAUDE.md content (chain layer, no-regression baseline) reached the composed system prompt`,
        `expected ${CLAUDE_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );
      expect(
        reply.includes(RULE_NONCE),
        `${label}: unscoped .claude/rules content (R2, new) reached the composed system prompt`,
        `expected ${RULE_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );
      expect(
        !reply.includes(IGNORED_NONCE),
        `${label}: negative control -- .claude/rules-not content was NOT honoured`,
        `unexpectedly found ${IGNORED_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );

      await ctx!.sessionManager.deactivateEmbeddedAgentWorker(w.sessionId, w.workerId).catch(() => {});
    }

    await checkEngine('openai-api', async () => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: openaiDefinition.id,
      });
      if (!worker) throw new Error('createWorker returned null for openai-api');
      return { sessionId: session.id, workerId: worker.id };
    });

    await checkEngine('claude-sdk', async () => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      });
      if (!worker) throw new Error('createWorker returned null for claude-sdk');
      return { sessionId: session.id, workerId: worker.id };
    });
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
    for (const dir of [realConfigDir, realCwd]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
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
