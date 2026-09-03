#!/usr/bin/env bun
/**
 * Shipping-path E2E for Issue #1571 (image content parts for message
 * attachments): a real image containing a nonce word, sent to a real
 * embedded-agent worker over the real HTTP upload route, must be answered
 * with the nonce -- on BOTH engines -- and a provider that declares
 * `supportsImages: false` must be unable to see it.
 *
 * WHAT IS REAL HERE: a real `AppContext` (real SQLite via `createTestContext`,
 * same pattern as `check-embedded-agent-idle-eviction-openai-api.ts`), a real
 * `/api` + `/mcp` on a real port, a real Chromium-rendered PNG (not a
 * hand-built byte fixture), the real `POST /api/sessions/:sessionId/messages`
 * multipart route -- the exact endpoint the browser composer calls, not a
 * shortcut through `sessionManager.sendMessage` -- two real `openai-api`
 * embedded-agent workers (one with `provider.supportsImages: true`, one
 * without) and one real `claude-sdk` embedded-agent worker (the
 * `claude-sdk-builtin` definition), each a real `sh -> bun -> <engine>`
 * subprocess tree.
 *
 * WHY A REAL SCREENSHOT AND NOT A HAND-BUILT PNG. The Issue's own AC asks for
 * "a real image containing a nonce word rendered as text (e.g. a screenshot
 * of the word)". A hand-built solid-color PNG would exercise the base64 /
 * content-part plumbing but never the thing a vision model actually has to
 * do -- read text out of pixels -- so it would prove the wire, not the
 * feature. This script renders an HTML page with the nonce as large,
 * high-contrast monospace text and screenshots it with headless Chromium,
 * mirroring how a user's pasted screenshot would look.
 *
 * THE SNAP-CONFINEMENT GOTCHA (measured on this machine, more precise than
 * "chromium can only write under $HOME"): the snap-packaged Chromium's `home`
 * interface denies writes to DOT-PREFIXED directories under $HOME, not just
 * paths outside $HOME. `chromium --screenshot=$HOME/.foo/out.png` fails
 * SILENTLY at the shell level (exit code can still read 0) with
 * `Permission denied (13)` buried in Chromium's own stderr; the same
 * invocation targeting `$HOME/foo/out.png` (no leading dot) succeeds.
 * Reading FROM a dot-directory works fine -- only writing is denied. This
 * script therefore has Chromium write into a plain (non-dot) staging
 * directory under $HOME, then copies the result into this repo's established
 * dot-prefixed capture convention (`~/.agent-console-smoke-captures/...`,
 * see `check-fatal-incarnation-replacement.ts`) via ordinary `node:fs` calls,
 * which are not subject to Chromium's own sandbox at all. Anyone re-deriving
 * this from scratch will hit the same silent failure the first time they
 * point `--screenshot=` at a dot-directory.
 *
 * CASES (all in one run):
 *   1. SUBJECT (`openai-api`, `supportsImages: true`, a real vision-capable
 *      model): sent the nonce image + "what word is in the image", over the
 *      real multipart route. Reply must contain the nonce.
 *   2. NEGATIVE CONTROL (`openai-api`, `supportsImages: false`, same route,
 *      same image): reply must NOT contain the nonce, and should reflect
 *      that the model cannot view images (loose substance check, not an
 *      exact-string match against `attachment-content.ts`'s notice text,
 *      which is an implementation detail).
 *   3. `claude-sdk` (the `claude-sdk-builtin` definition, unconditional --
 *      no `supportsImages` gate by design): same image, same question, over
 *      the real multipart route. Reply must contain the nonce. No negative
 *      control needed for this engine -- the capability gate is
 *      `openai-api`-only, and case 2 already covers it.
 *
 * Each case also confirms the persisted `user-message` server event actually
 * carries `attachments: [{ path, mimeType }]` for the request that used the
 * image, so a passing recall cannot be credited to the model imagining an
 * answer for a message that silently dropped its attachment.
 *
 * COST: real HTTP turns against a real OpenAI-compatible endpoint (SUBJECT +
 * CONTROL) plus real `claude` CLI turns (case 3) -- a handful of small
 * requests. Small, but real money for the `openai-api` half; billed at
 * whatever the invoking user's `claude` CLI plan charges for case 3. Manual
 * gate, never a CI job.
 *
 * REQUIREMENTS
 *   - A provider key store resolvable for `PROVIDER_KEY_REF` (default
 *     `opencode-go`, read from the single-user dev home; override with
 *     `PROVIDER_KEY_FILE`).
 *   - Headless Chromium at `CHROMIUM_BIN` (default `/snap/bin/chromium`).
 *   - A real, authenticated `claude` CLI for the invoking OS user (case 3
 *     only; same requirement as the other `claude-sdk`-touching smokes under
 *     this directory).
 *   - `bun install` already run in this checkout.
 *
 * USAGE
 *   bun scripts/smoke/check-embedded-agent-image-attachments.ts
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch failure)
 */

// --- Same ordering hazard as the idle-eviction siblings: `serverConfig`
// reads its values at MODULE-LOAD time, so every env var this script sets
// (AGENT_CONSOLE_HOME below) must be assigned before any module that
// transitively imports server-config.ts is evaluated. Every such import is
// therefore a DYNAMIC import made from inside main().

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const SUBJECT_MODEL = process.env.SUBJECT_PROVIDER_MODEL ?? 'deepseek-v4-flash-vision-exp';
const CONTROL_MODEL = process.env.CONTROL_PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/snap/bin/chromium';

const QUESTION = 'What word is shown in the attached image? Answer with just the word.';

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

/**
 * Renders `nonce` as large, high-contrast monospace text on a plain white
 * background and screenshots it with headless Chromium. See this file's
 * header comment for the dot-directory write restriction this works around.
 *
 * @internal Exported for testing (the import-safety smoke discovers this
 * module and must not execute a billed run as a side effect of importing
 * it -- see the `main()` guard at the bottom of this file).
 */
export async function generateNonceImage(
  nonce: string,
  stagingDir: string,
  finalDir: string,
): Promise<{ htmlPath: string; pngPath: string }> {
  mkdirSync(stagingDir, { recursive: true });
  const stagingHtml = path.join(stagingDir, 'nonce.html');
  const stagingPng = path.join(stagingDir, 'nonce.png');
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh; background: #ffffff; }
  div { font-family: 'DejaVu Sans Mono', monospace; font-size: 64px; font-weight: bold; color: #000000; }
</style>
</head>
<body><div>${nonce}</div></body>
</html>`;
  await Bun.write(stagingHtml, html);

  const res = Bun.spawnSync([
    CHROMIUM_BIN,
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--screenshot=${stagingPng}`,
    '--window-size=800,400',
    `file://${stagingHtml}`,
  ]);

  const pngFile = Bun.file(stagingPng);
  if (!(await pngFile.exists())) {
    const stderrText = new TextDecoder().decode(res.stderr);
    throw new Error(
      `chromium did not produce a PNG at ${stagingPng} (exit ${res.exitCode}); stderr tail: ${stderrText.slice(-2000)}`,
    );
  }

  mkdirSync(finalDir, { recursive: true });
  const finalHtml = path.join(finalDir, 'nonce.html');
  const finalPng = path.join(finalDir, 'nonce.png');
  cpSync(stagingHtml, finalHtml);
  cpSync(stagingPng, finalPng);
  rmSync(stagingDir, { recursive: true, force: true });

  return { htmlPath: finalHtml, pngPath: finalPng };
}

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const nonce = `IMAGEWORD-${Math.floor(Math.random() * 9000 + 1000)}`;
  const runId = `${Date.now()}-${process.pid}`;
  const captureDir = path.join(
    os.homedir(),
    '.agent-console-smoke-captures',
    'check-embedded-agent-image-attachments',
    runId,
  );
  // Non-dot: Chromium's snap `home` interface denies writes to dot-prefixed
  // directories (see header comment). This directory is removed once the
  // PNG has been copied into `captureDir` -- it is scratch, not the capture.
  const chromiumStagingDir = path.join(os.homedir(), `agent-console-image-attachments-stage-${runId}`);

  console.log(`==> nonce: ${nonce}`);
  console.log('==> generating nonce image via headless Chromium');
  const { pngPath } = await generateNonceImage(nonce, chromiumStagingDir, captureDir);
  console.log(`==> nonce image captured at: ${pngPath} (not auto-pruned -- see test-trigger.md)`);

  const disposableHome = path.join(os.tmpdir(), `ac-1571-image-attachments-smoke-cfg-${crypto.randomUUID()}`);
  mkdirSync(disposableHome, { recursive: true });
  process.env.AGENT_CONSOLE_HOME = disposableHome;

  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');
  const { CLAUDE_SDK_AGENT_ID } = await import('../../packages/server/src/services/embedded-agent-manager.js');

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;

  try {
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    // The provider key is copied into the disposable home (resolved relative
    // to AGENT_CONSOLE_HOME) rather than borrowing the dev home wholesale --
    // same rationale as the idle-eviction `openai-api` sibling.
    let apiKey: string;
    try {
      const store = JSON.parse(await Bun.file(PROVIDER_KEY_FILE).text()) as Record<string, string>;
      if (typeof store[PROVIDER_KEY_REF] !== 'string') {
        throw new Error(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
      }
      apiKey = store[PROVIDER_KEY_REF];
    } catch (err) {
      throw new Error(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
    }
    await Bun.write(path.join(disposableHome, 'provider-keys.json'), JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }));
    Bun.spawnSync(['chmod', '600', path.join(disposableHome, 'provider-keys.json')]);

    realCwd = path.join(os.tmpdir(), `ac-1571-image-attachments-smoke-cwd-${crypto.randomUUID()}`);
    mkdirSync(realCwd, { recursive: true });

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
    const apiBaseUrl = `http://localhost:${appServer.port}`;
    console.log(`==> real /api + /mcp served at ${apiBaseUrl}`);

    const subjectDefinition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `image-attachments-smoke-subject-${process.pid}`,
        description: 'Disposable supportsImages:true definition for the image-attachments smoke (Issue #1571).',
        provider: { baseUrl: PROVIDER_BASE_URL, model: SUBJECT_MODEL, apiKeyRef: PROVIDER_KEY_REF, supportsImages: true },
      },
      owner.id,
    );
    const controlDefinition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `image-attachments-smoke-control-${process.pid}`,
        description: 'Disposable supportsImages:false definition for the image-attachments smoke (Issue #1571).',
        provider: { baseUrl: PROVIDER_BASE_URL, model: CONTROL_MODEL, apiKeyRef: PROVIDER_KEY_REF, supportsImages: false },
      },
      owner.id,
    );
    console.log(`==> SUBJECT definition ${subjectDefinition.id} model=${SUBJECT_MODEL} supportsImages=true`);
    console.log(`==> CONTROL definition ${controlDefinition.id} model=${CONTROL_MODEL} supportsImages=false`);

    const readEvents = async (sessionId: string, workerId: string): Promise<StreamEvent[]> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      const events: StreamEvent[] = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') events.push(json as StreamEvent);
        } catch {
          // A previous incarnation may have been killed mid-write.
        }
      }
      return events;
    };

    const makeWorker = async (
      label: string,
      embeddedAgentId: string,
    ): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd! },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, { type: 'embedded-agent', embeddedAgentId });
      if (!worker) throw new Error(`createWorker returned null for ${label}`);
      return { sessionId: session.id, workerId: worker.id };
    };

    /**
     * Sends the nonce image plus `QUESTION` through the REAL multipart
     * upload route -- `POST /api/sessions/:sessionId/messages` -- the same
     * endpoint the browser composer calls, not a shortcut through
     * `sessionManager.sendMessage`.
     */
    const sendImageMessage = async (sessionId: string, workerId: string): Promise<void> => {
      const bytes = await Bun.file(pngPath).arrayBuffer();
      const form = new FormData();
      form.append('toWorkerId', workerId);
      form.append('content', QUESTION);
      form.append('files', new Blob([bytes], { type: 'image/png' }), 'nonce.png');
      const res = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/messages`, { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        throw new Error(`POST .../messages failed: ${res.status} ${body}`);
      }
    };

    const waitForTurnReply = async (sessionId: string, workerId: string, marker: number, timeoutMs = 120_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(marker);
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal) throw new Error(`loop emitted fatal: ${JSON.stringify(fatal)}`);
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr) throw new Error(`loop emitted turn-error: ${JSON.stringify(turnErr)}`);
        if (events.some((e) => e.type === 'state' && e.state === 'idle')) {
          return events
            .filter((e) => e.type === 'assistant-message')
            .map((e) => String(e.text ?? ''))
            .join('\n');
        }
        await delay(500);
      }
      throw new Error('turn did not complete before the deadline');
    };

    const runCase = async (
      label: string,
      embeddedAgentId: string,
      expectRecall: boolean,
    ): Promise<{ sessionId: string; workerId: string; reply: string }> => {
      console.log(`\n==> case: ${label}`);
      const { sessionId, workerId } = await makeWorker(label, embeddedAgentId);
      const marker = (await readEvents(sessionId, workerId)).length;
      await sendImageMessage(sessionId, workerId);
      const reply = await waitForTurnReply(sessionId, workerId, marker);
      console.log(`  ${label} reply: ${reply.trim().slice(0, 200)}`);

      const events = (await readEvents(sessionId, workerId)).slice(marker);
      const userMessageEvent = events.find((e) => e.type === 'user-message');
      const attachments = (userMessageEvent?.attachments ?? []) as Array<{ path: string; mimeType: string }>;
      expect(
        attachments.length === 1 && attachments[0].mimeType === 'image/png',
        `${label}: the persisted user-message event carries the image attachment`,
        `got ${JSON.stringify(userMessageEvent)}`,
      );

      if (expectRecall) {
        expect(reply.toLowerCase().includes(nonce.toLowerCase()), `${label}: reply recalls the nonce from the image`, `expected ${nonce} in: ${reply.trim().slice(0, 300)}`);
      } else {
        expect(!reply.toLowerCase().includes(nonce.toLowerCase()), `${label}: reply does NOT recall the nonce`, `got: ${reply.trim().slice(0, 300)}`);
      }

      return { sessionId, workerId, reply };
    };

    // --- Case 1: SUBJECT (openai-api, supportsImages: true) ---
    await runCase('SUBJECT (openai-api, supportsImages:true)', subjectDefinition.id, true);

    // --- Case 2: CONTROL (openai-api, supportsImages: false) ---
    const control = await runCase('CONTROL (openai-api, supportsImages:false)', controlDefinition.id, false);
    const controlLower = control.reply.toLowerCase();
    const mentionsInability =
      (controlLower.includes('cannot') || controlLower.includes("can't") || controlLower.includes('unable')) &&
      (controlLower.includes('image') || controlLower.includes('see') || controlLower.includes('view'));
    expect(
      mentionsInability,
      'CONTROL: reply reflects that the model cannot view images (loose substance check)',
      `got: ${control.reply.trim().slice(0, 300)}`,
    );

    // --- Case 3: claude-sdk (unconditional, no supportsImages gate) ---
    await runCase('claude-sdk (claude-sdk-builtin)', CLAUDE_SDK_AGENT_ID, true);
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
    for (const dir of [disposableHome, realCwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    // NOTE: `captureDir` (the nonce image + HTML) is intentionally NOT
    // removed here -- see this repo's smoke-capture convention
    // (test-trigger.md, "Fatal Incarnation Replacement" section): not
    // auto-pruned, the operator's responsibility to clean up.
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect.
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
