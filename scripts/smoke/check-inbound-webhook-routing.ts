#!/usr/bin/env bun
/**
 * Shipping-path E2E for the generic signed inbound webhook:
 * management REST (create an endpoint, capture its one-time secret) ->
 * a REAL signed `POST /webhooks/in/:endpointId` (real Hono route) -> dedupe + enqueue (real
 * SQLite) -> real job queue -> `inbound-webhook:process` handler -> the action for the
 * repository's designated Orchestrators -> the real inbound pipeline (target resolution, the
 * notification ledger, the handlers) -> the real delivery seam.
 *
 * FREE AND DETERMINISTIC -- no `claude` CLI, no provider key, no LLM turn anywhere. The live PTY
 * target runs a custom agent whose command is plain `cat`; the embedded target talks to a stub
 * OpenAI-compatible provider hosted by this script.
 *
 * WHY A REAL CHILD PROCESS: the route, the queue and the PTY layer run exactly as `bun run dev`
 * boots them, in their own process, so nothing in this script shares module state with the code
 * under test (the same choice as `check-webhook-issue-label-routing.ts`).
 *
 * WHAT IS ASSERTED, in one run, against one repository with three designated sessions:
 *
 *   SETUP   The endpoint is created through `POST /api/repositories/:id/inbound-webhook-endpoints`
 *           and its generated secret is captured from that one response; a later read never
 *           returns a secret.
 *   (1) LIVE PTY target L: its real worker output file gains the `[inbound:external:message]`
 *           tag with the fields-only text (type, source, the real remote slug, the excerpt, both
 *           paths, intent); neither the second line of the instruction nor any sender-only
 *           key or file URL appears there. `body.md` and `instruction.md` exist in L's own
 *           delivery directory before the notification, `instruction.md` equals the stored
 *           multi-line CRLF text byte for byte, and `body.md` carries no `slack_message`
 *           key, no `slack_files` URL and no token-looking substring.
 *   (2) EMBEDDED target E (stub provider, the shape of scenario 4c in the issue-label smoke):
 *           the target's NDJSON gains exactly one `user-message` with
 *           `notification.kind === 'inbound-event'` carrying the tag, the stub saw exactly one
 *           chat request since the POST (baseline captured before the POST, read only after
 *           the turn settled with `state: 'idle'`), and E's delivery files exist.
 *   (3) PAUSED target P: no PTY write (its output file is unchanged), exactly one new
 *           `kind = 'inbound-event'` row in `deferred_worker_notifications` whose params carry
 *           `body_path` and `instruction_path`, and both files exist.
 *   (4) NEGATIVE ARMS, each with a positive control (the instrument demonstrably sees):
 *           a wrong signature is 401 and creates no deliveries row; an unknown endpoint id is
 *           404; a stale timestamp (301 s) is 401; an invalid webhook id (`../x`) is 400; a
 *           replay of the accepted webhook id is 200 and creates NO second job and NO second
 *           notification. The control for every arm is the first accepted delivery, which the
 *           same request helper and the same counters observed (a deliveries row, a job, a
 *           ledger row per target, tags in the output file).
 *
 * The request signature is computed HERE from the Standard Webhooks specification (HMAC-SHA256
 * over `{id}.{timestamp}.{body}`, keyed by the base64-decoded part of the secret after `whsec_`),
 * never by importing the production verifier, so a production signer or verifier that drifted
 * from the specification fails this smoke.
 *
 * Usage:
 *   NODE_ENV=development bun scripts/smoke/check-inbound-webhook-routing.ts
 *   (NODE_ENV must be set explicitly; the smoke refuses to guess.)
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (a real regression)
 *   2  bad usage / the smoke could not run (server failed to boot, git commands failed, etc.)
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createScratchGitRepo, type ScratchGitRepo } from '../../packages/server/src/__tests__/utils/scratch-git.js';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

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

class BailError extends Error {}
function bail(message: string): never {
  throw new BailError(message);
}

/** Find a free TCP port by letting the OS assign one, then releasing it. */
function getFreePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = s;
  s.stop(true);
  if (port === undefined) bail('Bun.serve() with port: 0 unexpectedly returned no port');
  return port;
}

async function waitForServerReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(150);
  }
  bail(`Disposable server did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Poll `cond` until it returns true or the timeout elapses; breaks as soon as it holds. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await Bun.sleep(150);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

/**
 * Standard Webhooks signature, from the specification: HMAC-SHA256 over `{id}.{timestamp}.{body}`
 * keyed by the base64-decoded bytes of the secret after its `whsec_` prefix, base64-encoded and
 * prefixed `v1,`. Deliberately independent of the production verifier.
 */
function standardWebhookSignature(secret: string, webhookId: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${webhookId}.${timestamp}.${body}`).digest('base64')}`;
}

let scratchRepo: ScratchGitRepo | undefined;

async function git(args: string[], cwd: string): Promise<void> {
  if (!scratchRepo) bail('git() called before the scratch repository was created');
  if (path.resolve(cwd) !== path.resolve(scratchRepo.dir)) {
    bail(`git() called with an unexpected cwd (expected ${scratchRepo.dir}, got ${cwd})`);
  }
  try {
    await scratchRepo.git(args);
  } catch (err) {
    bail(`git ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function initializeMcp(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'inbound-webhook-routing-smoke', version: '1.0.0' } },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function designate(baseUrl: string, mcpSessionId: string, sessionId: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': mcpSessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'set_orchestrator_session', arguments: { sessionId } }, id: 2 }),
  });
  const json = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  const text = json.result?.content?.[0]?.text;
  if (json.result?.isError || !text) bail(`set_orchestrator_session failed: ${JSON.stringify(json)}`);
  return (JSON.parse(text) as { orchestratorSessionIds: string[] }).orchestratorSessionIds;
}

interface CreatedSession {
  id: string;
  workers: { id: string; type: string }[];
}

async function createSession(baseUrl: string, body: Record<string, unknown>): Promise<CreatedSession> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) bail(`Session creation failed (status ${res.status}): ${await res.text()}`);
  return ((await res.json()) as { session: CreatedSession }).session;
}

// The stored instruction: multi-line, CRLF, blank line, trailing newline. Only its first line may
// ever reach a notification field.
const INSTRUCTION = 'Triage the message\r\nSECOND-LINE-MARKER must stay out of the notification\r\n\r\nlast line\n';
const EXCERPT = 'Triage the message';
const TOKEN_LOOKING = 'tok-SMOKE-TOKENLIKE-SUBSTRING';
const RAW_EVENT_TEXT = 'RAW-SLACK-EVENT-TEXT';
const TAG = '[inbound:external:message]';
const SENDER_BODY = {
  schema_version: 1,
  message: 'Deploy finished\nsecond sender line',
  slack_channel: 'C123',
  slack_ts: '1700000000.000100',
  slack_permalink: 'https://example.slack.com/archives/C123/p1700000000000100',
  slack_files: [{ name: 'a.png', url: `https://files.slack.com/files-pri/T1-F1/a.png?t=${TOKEN_LOOKING}` }],
  slack_message: { text: RAW_EVENT_TEXT, user: 'U1' },
};

async function main(): Promise<void> {
  // NODE_ENV-sensitive: this smoke boots the real `packages/server/src/index.ts` as a child
  // process inheriting NODE_ENV, whose static-file-serving branch is gated on it (see
  // `check-webhook-issue-label-routing.ts`). Listed in `NODE_ENV_SENSITIVE_SMOKES`.
  if (!process.env.NODE_ENV) {
    console.error(
      'check-inbound-webhook-routing.ts: NODE_ENV must be set explicitly (production|development|test) -- this smoke verifies behaviour that depends on it; refusing to guess.',
    );
    process.exit(2);
  }

  process.chdir(REPO_ROOT);
  const startedAt = Date.now();
  const runId = `${process.pid}-${Date.now()}`;
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-console-inbound-webhook-smoke-'));
  const disposableHome = path.join(scratchRoot, 'home');
  mkdirSync(disposableHome, { recursive: true });
  console.log(`==> scratch root: ${scratchRoot}`);

  const port = getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nonceOrg = `smoke-org-${process.pid}`;
  const nonceRepo = `smoke-repo-${process.pid}`;
  const expectedSlug = `${nonceOrg}/${nonceRepo}`;

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stdoutBuf = '';
  let stderrBuf = '';
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  const sessionsToDelete: string[] = [];
  let printStubStateOnFailure: (() => void) | undefined;

  try {
    console.log('==> setting up disposable git repository with a fake origin remote');
    scratchRepo = await createScratchGitRepo({ parentDir: scratchRoot, name: 'repo-' });
    const repoDir = scratchRepo.dir;
    await git(['remote', 'add', 'origin', `https://github.com/${expectedSlug}.git`], repoDir);
    const worktreeDirs = { l: path.join(scratchRoot, 'worktree-l'), p: path.join(scratchRoot, 'worktree-p'), e: path.join(scratchRoot, 'worktree-e') };
    await git(['worktree', 'add', worktreeDirs.l, '-b', 'smoke-branch-l'], repoDir);
    await git(['worktree', 'add', worktreeDirs.p, '-b', 'smoke-branch-p'], repoDir);
    await git(['worktree', 'add', worktreeDirs.e, '-b', 'smoke-branch-e'], repoDir);

    console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);
    console.log(`==> disposable server target: ${baseUrl}`);
    proc = Bun.spawn({
      cmd: ['bun', 'packages/server/src/index.ts'],
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_CONSOLE_HOME: disposableHome, AUTH_MODE: 'none', PORT: String(port), HOST: '127.0.0.1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of proc!.stdout as ReadableStream<Uint8Array>) stdoutBuf += decoder.decode(chunk);
    })();
    void (async () => {
      for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) stderrBuf += decoder.decode(chunk);
    })();
    await waitForServerReady(baseUrl);
    console.log('==> disposable server is ready');

    process.env.AGENT_CONSOLE_HOME = disposableHome;
    const configModule = await import('../../packages/server/src/lib/config.ts');
    const { computeSessionDataBaseDir } = await import('../../packages/server/src/lib/session-data-path.ts');
    const { SessionDataPathResolver } = await import('../../packages/server/src/lib/session-data-path-resolver.ts');
    const { JOB_TYPES, JOB_STATUS } = await import('../../packages/shared/src/types/job.ts');
    const { Database: BunDatabase } = await import('bun:sqlite');
    const dbPath = configModule.getDbPath();

    /** Run one read-only query against the disposable server's own SQLite file. */
    function queryOne<T>(sql: string, ...params: string[]): T | undefined {
      const handle = new BunDatabase(dbPath, { readonly: true });
      try {
        return handle.query(sql).get(...params) as T | undefined;
      } finally {
        handle.close();
      }
    }
    const countOf = (sql: string, ...params: string[]): number => queryOne<{ c: number }>(sql, ...params)?.c ?? 0;

    function resolverFor(sessionId: string) {
      const row = queryOne<{ data_scope: string | null; data_scope_slug: string | null }>(
        'SELECT data_scope, data_scope_slug FROM sessions WHERE id = ?',
        sessionId,
      );
      if (!row || !row.data_scope) bail(`session ${sessionId} has no data_scope row`);
      const baseDir = computeSessionDataBaseDir(disposableHome, row.data_scope as 'quick' | 'repository', row.data_scope_slug);
      return new SessionDataPathResolver(baseDir, disposableHome);
    }
    const readSafe = (p: string): string => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf-8') : '';
      } catch {
        return '';
      }
    };

    // -----------------------------------------------------------------
    // Repository, a plain `cat` agent (no claude, no billing), the stub provider, sessions.
    // -----------------------------------------------------------------
    console.log('\n==> registering the repository');
    const registerRes = await fetch(`${baseUrl}/api/repositories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoDir, description: 'inbound-webhook-routing smoke' }),
    });
    if (!registerRes.ok) bail(`Repository registration failed (status ${registerRes.status}): ${await registerRes.text()}`);
    const { repository } = (await registerRes.json()) as { repository: { id: string } };

    const agentRes = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke cat agent', commandTemplate: 'cat # {{prompt}}' }),
    });
    if (agentRes.status !== 201) bail(`POST /api/agents failed (status ${agentRes.status}): ${await agentRes.text()}`);
    const { agent } = (await agentRes.json()) as { agent: { id: string } };

    interface StubChatRequest {
      at: number;
      body: unknown;
    }
    const stubRequests: StubChatRequest[] = [];
    const sseEvent = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
    const finalAnswerSse = (): string =>
      sseEvent({ choices: [{ delta: { content: 'Acknowledged.' }, finish_reason: null }] }) +
      sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    stubServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          stubRequests.push({ at: Date.now(), body: (await req.json()) as unknown });
          return new Response(finalAnswerSse(), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const stubBaseUrl = `http://127.0.0.1:${stubServer.port}`;
    printStubStateOnFailure = () => {
      console.error(`==> stub provider port: ${stubServer?.port}; recorded chat requests (${stubRequests.length}):`);
      for (const r of stubRequests) console.error(`  at=${new Date(r.at).toISOString()} body=${JSON.stringify(r.body).slice(0, 1500)}`);
    };
    const apiKeyRef = 'smoke-provider-key';
    writeFileSync(path.join(disposableHome, 'provider-keys.json'), JSON.stringify({ [apiKeyRef]: `smoke-fake-key-${runId}` }), { mode: 0o600 });
    const definitionRes = await fetch(`${baseUrl}/api/embedded-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke inbound-webhook embedded Orchestrator',
        engine: 'openai-api',
        provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'smoke-model', apiKeyRef },
      }),
    });
    if (definitionRes.status !== 201) bail(`POST /api/embedded-agents failed (status ${definitionRes.status}): ${await definitionRes.text()}`);
    const { embeddedAgent } = (await definitionRes.json()) as { embeddedAgent: { id: string } };

    console.log('==> creating sessions L (live PTY), P (to be paused) and E (embedded)');
    const sessionL = await createSession(baseUrl, {
      type: 'worktree', repositoryId: repository.id, worktreeId: 'smoke-branch-l', locationPath: worktreeDirs.l, agentId: agent.id,
    });
    sessionsToDelete.push(sessionL.id);
    const sessionP = await createSession(baseUrl, {
      type: 'worktree', repositoryId: repository.id, worktreeId: 'smoke-branch-p', locationPath: worktreeDirs.p, agentId: agent.id,
    });
    const sessionE = await createSession(baseUrl, {
      type: 'worktree', repositoryId: repository.id, worktreeId: 'smoke-branch-e', locationPath: worktreeDirs.e, embeddedAgentId: embeddedAgent.id,
    });
    sessionsToDelete.unshift(sessionE.id);
    const workerL = sessionL.workers.find((w) => w.type === 'agent');
    const workerP = sessionP.workers.find((w) => w.type === 'agent');
    const workerE = sessionE.workers.find((w) => w.type === 'embedded-agent');
    if (!workerL || !workerP || !workerE) bail('a session is missing its deliverable worker');

    const mcpSessionId = await initializeMcp(baseUrl);
    await designate(baseUrl, mcpSessionId, sessionL.id);
    await designate(baseUrl, mcpSessionId, sessionP.id);
    const designated = await designate(baseUrl, mcpSessionId, sessionE.id);
    expect(
      designated.length === 3 && [sessionL.id, sessionP.id, sessionE.id].every((id) => designated.includes(id)),
      'SETUP: the designated set is exactly {L, P, E}',
      JSON.stringify(designated),
    );

    const pauseRes = await fetch(`${baseUrl}/api/sessions/${sessionP.id}/pause`, { method: 'POST' });
    expect(pauseRes.status === 200, 'SETUP: session P is paused (absent from the live session manager, row preserved)', `status=${pauseRes.status}`);

    const outputPathL = resolverFor(sessionL.id).getOutputFilePath(sessionL.id, workerL.id);
    const outputPathP = resolverFor(sessionP.id).getOutputFilePath(sessionP.id, workerP.id);
    const outputPathE = resolverFor(sessionE.id).getOutputFilePath(sessionE.id, workerE.id);

    // L's PTY starts a login shell and types the agent command only after a startup sentinel;
    // a notification written before that races with the injection. Wait for the shell's own
    // output, then a short settle.
    console.log('==> waiting for the live PTY to start its agent command');
    await waitFor(() => readSafe(outputPathL).length > 0, 30_000, "L's PTY to produce output");
    await Bun.sleep(4_000);

    // -----------------------------------------------------------------
    // SETUP: the endpoint through the real management REST.
    // -----------------------------------------------------------------
    console.log('\n==> creating the endpoint through the management REST');
    const createEndpointRes = await fetch(`${baseUrl}/api/repositories/${repository.id}/inbound-webhook-endpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Smoke Slack', instructionText: INSTRUCTION }),
    });
    expect(createEndpointRes.status === 201, 'SETUP: POST /api/repositories/:id/inbound-webhook-endpoints returns 201', `status=${createEndpointRes.status}`);
    const created = (await createEndpointRes.json()) as { endpoint?: { id: string }; secret?: string; secretSource?: string };
    const endpointId = created.endpoint?.id ?? '';
    const secret = created.secret ?? '';
    expect(
      endpointId.length > 0 && created.secretSource === 'generated' && secret.startsWith('whsec_'),
      'SETUP: the response carries the endpoint id and a generated whsec_ secret (the one-time reveal)',
      `secretSource=${created.secretSource}`,
    );
    if (!endpointId || !secret) bail('endpoint creation returned no id or secret');
    const readBackRes = await fetch(`${baseUrl}/api/repositories/${repository.id}/inbound-webhook-endpoints/${endpointId}`);
    const readBackText = await readBackRes.text();
    expect(
      readBackRes.status === 200 && !readBackText.includes(secret),
      'SETUP: a later read of the endpoint succeeds and never returns the secret',
      `status=${readBackRes.status}`,
    );

    const body = JSON.stringify(SENDER_BODY);
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    interface PostOptions {
      endpoint?: string;
      webhookId: string;
      timestamp?: number;
      secretToSign?: string;
      signature?: string;
    }
    /** One request through the real route; every arm and the control use this same helper. */
    const post = (o: PostOptions): Promise<Response> => {
      const timestamp = String(o.timestamp ?? nowSeconds());
      return fetch(`${baseUrl}/webhooks/in/${o.endpoint ?? endpointId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': o.webhookId,
          'webhook-timestamp': timestamp,
          'webhook-signature': o.signature ?? standardWebhookSignature(o.secretToSign ?? secret, o.webhookId, timestamp, body),
        },
        body,
      });
    };

    const WEBHOOK_ID = `Ev${process.pid}`;
    const deliveryId = `inbound-webhook:${endpointId}:${WEBHOOK_ID}`;
    const pathsFor = (sessionId: string, workerId: string) =>
      resolverFor(sessionId).getInboundWebhookDeliveryPaths(sessionId, workerId, deliveryId);
    const countDeferred = (): number =>
      countOf(
        "SELECT COUNT(*) as c FROM deferred_worker_notifications WHERE session_id = ? AND worker_id = ? AND kind = 'inbound-event'",
        sessionP.id,
        workerP.id,
      );
    const countDeliveries = (): number => countOf('SELECT COUNT(*) as c FROM inbound_webhook_deliveries WHERE endpoint_id = ?', endpointId);
    const countJobs = (): number => countOf('SELECT COUNT(*) as c FROM jobs WHERE type = ?', JOB_TYPES.INBOUND_WEBHOOK_PROCESS);
    const countLedger = (): number =>
      countOf("SELECT COUNT(*) as c FROM inbound_event_notifications WHERE event_type = 'external:message'");
    /** Whether the file holds exactly the stored instruction bytes; a missing file is simply false. */
    const holdsStoredInstruction = (file: string): boolean => {
      try {
        return Buffer.from(readFileSync(file)).equals(Buffer.from(INSTRUCTION, 'utf-8'));
      } catch {
        return false;
      }
    };
    const tagCount = (text: string): number => text.split(TAG).length - 1;

    // ===================================================================
    // (1) + (2) + (3): one accepted delivery to the live, embedded and paused targets.
    // ===================================================================
    console.log('\n==> DELIVERY: a signed POST reaches L (live PTY), E (embedded) and P (paused)');
    const beforeL = readSafe(outputPathL);
    const beforeP = readSafe(outputPathP);
    const beforeE = readSafe(outputPathE);
    const deferredBefore = countDeferred();
    expect(stubRequests.length === 0, "DELIVERY: E's worker is dormant before the event (the stub has seen no chat request)", `stubRequests=${stubRequests.length}`);
    const postedAt = Date.now();
    const accepted = await post({ webhookId: WEBHOOK_ID });
    const acceptedBody = (await accepted.json().catch(() => null)) as { ok?: boolean; duplicate?: boolean } | null;
    expect(accepted.status === 200 && acceptedBody?.ok === true && acceptedBody.duplicate !== true, 'DELIVERY: the signed POST is accepted (200, not a duplicate)', `status=${accepted.status} body=${JSON.stringify(acceptedBody)}`);
    expect(countDeliveries() === 1 && countJobs() === 1, 'DELIVERY: exactly one deliveries row and one inbound-webhook:process job were created', `deliveries=${countDeliveries()} jobs=${countJobs()}`);

    const tagFoundInL = await waitFor(() => readSafe(outputPathL).slice(beforeL.length).includes(TAG), 45_000, "L's output file to contain the external:message tag");
    const newL = readSafe(outputPathL).slice(beforeL.length);
    expect(tagFoundInL, `(1) L's real worker output file gained ${TAG}`, newL.slice(-600));

    const pathsL = pathsFor(sessionL.id, workerL.id);
    expect(
      pathsL.bodyPath.endsWith(`/messages/${sessionL.id}/${workerL.id}/inbound-webhook/${deliveryId}/body.md`) &&
        pathsL.instructionPath.endsWith(`/messages/${sessionL.id}/${workerL.id}/inbound-webhook/${deliveryId}/instruction.md`),
      "(1) L's delivery files live under messages/<session>/<worker>/inbound-webhook/<deliveryId>/",
      pathsL.dir,
    );
    for (const [needle, what] of [
      ['type=external:message', 'type'],
      ['source=webhook', 'source'],
      [`repo=${expectedSlug}`, 'the real remote slug'],
      ['branch=N/A', 'branch N/A'],
      [`instruction_excerpt="${EXCERPT}"`, 'the one-line instruction excerpt'],
      [`instruction_path=${pathsL.instructionPath}`, 'the instruction path'],
      [`body_path=${pathsL.bodyPath}`, 'the body path'],
      ['intent=triage', 'intent'],
    ] as const) {
      expect(newL.includes(needle), `(1) L's notification carries ${what}`, needle);
    }
    expect(
      !newL.includes('SECOND-LINE-MARKER') && !newL.includes(TOKEN_LOOKING) && !newL.includes('files.slack.com') && !newL.includes(RAW_EVENT_TEXT) && !newL.includes('slack_message'),
      "(1) L's output carries neither the instruction's second line nor any sender-only key, raw event text, file URL or token",
      newL.slice(-600),
    );
    expect(existsSync(pathsL.bodyPath) && existsSync(pathsL.instructionPath), '(1) body.md and instruction.md exist in L\'s delivery directory');
    expect(
      holdsStoredInstruction(pathsL.instructionPath),
      '(1) instruction.md equals the stored instruction byte for byte (multi-line, CRLF, trailing newline)',
    );
    const bodyL = readSafe(pathsL.bodyPath);
    expect(bodyL.includes('Deploy finished'), '(1) body.md carries the sender message (positive control for the absence checks below)', bodyL.slice(0, 300));
    expect(
      !bodyL.includes('slack_message') && !bodyL.includes('slack_files') && !bodyL.includes('files.slack.com') && !bodyL.includes(TOKEN_LOOKING) && !bodyL.includes(RAW_EVENT_TEXT),
      '(1) body.md carries no slack_message key, no slack_files URL and no token-looking substring',
      bodyL.slice(0, 600),
    );

    // (2) embedded: read only after the turn settles.
    interface NdjsonLine { type?: string; state?: string; text?: string; notification?: { kind?: string } }
    const parseNdjsonSince = (baseline: string): NdjsonLine[] =>
      readSafe(outputPathE).slice(baseline.length).split('\n').filter((l) => l.length > 0).flatMap((l) => {
        try { return [JSON.parse(l) as NdjsonLine]; } catch { return []; }
      });
    const settledE = await waitFor(
      () => stubRequests.filter((r) => r.at >= postedAt).length >= 1 && parseNdjsonSince(beforeE).some((e) => e.type === 'state' && e.state === 'idle'),
      60_000,
      "E's embedded worker to be activated by the event, answered by the stub, and report state:idle",
    );
    expect(settledE, "(2) E's turn settled (stub answered + state:idle persisted since the baseline)", readSafe(outputPathE).slice(beforeE.length).slice(-600));
    const inboundE = parseNdjsonSince(beforeE).filter(
      (e) => e.type === 'user-message' && e.notification?.kind === 'inbound-event' && typeof e.text === 'string' && e.text.includes(TAG),
    );
    expect(inboundE.length === 1, `(2) E's NDJSON gained exactly one user-message with notification.kind='inbound-event' carrying ${TAG}`, `matches=${inboundE.length}`);
    const pathsE = pathsFor(sessionE.id, workerE.id);
    expect(
      inboundE.length === 1 && inboundE[0]!.text!.includes(`body_path=${pathsE.bodyPath}`) && inboundE[0]!.text!.includes(`instruction_path=${pathsE.instructionPath}`) && !inboundE[0]!.text!.includes('SECOND-LINE-MARKER'),
      "(2) E's notification names E's own two paths and carries no second instruction line",
      inboundE[0]?.text,
    );
    const stubSince = stubRequests.filter((r) => r.at >= postedAt);
    expect(stubSince.length === 1, '(2) the stub saw exactly ONE chat request since the POST (E was dormant and woken by this event)', `count=${stubSince.length}`);
    expect(existsSync(pathsE.bodyPath) && existsSync(pathsE.instructionPath), "(2) body.md and instruction.md exist in E's delivery directory");
    expect(
      holdsStoredInstruction(pathsE.instructionPath),
      "(2) E's instruction.md equals the stored instruction byte for byte",
    );

    // (3) paused: the deferred row, no PTY write.
    const deferredLanded = await waitFor(() => countDeferred() > deferredBefore, 30_000, "a new inbound-event deferred row for P's agent worker");
    expect(deferredLanded && countDeferred() - deferredBefore === 1, "(3) P (paused) is a deferred TARGET: exactly one new kind='inbound-event' deferred_worker_notifications row", `before=${deferredBefore} after=${countDeferred()}`);
    const row = queryOne<{ params_json: string }>(
      "SELECT params_json FROM deferred_worker_notifications WHERE session_id = ? AND worker_id = ? AND kind = 'inbound-event' ORDER BY created_at DESC LIMIT 1",
      sessionP.id,
      workerP.id,
    );
    const deferredFields = (row ? (JSON.parse(row.params_json) as { fields?: Record<string, string> }).fields : undefined) ?? {};
    const pathsP = pathsFor(sessionP.id, workerP.id);
    expect(
      deferredFields.body_path === pathsP.bodyPath && deferredFields.instruction_path === pathsP.instructionPath,
      "(3) the stored params carry P's body_path and instruction_path",
      JSON.stringify(deferredFields),
    );
    expect(existsSync(pathsP.bodyPath) && existsSync(pathsP.instructionPath), "(3) body.md and instruction.md exist in P's delivery directory");
    expect(
      holdsStoredInstruction(pathsP.instructionPath),
      "(3) P's instruction.md equals the stored instruction byte for byte",
    );

    const jobDone = await waitFor(
      () => queryOne<{ status: string }>('SELECT status FROM jobs WHERE id = ?', deliveryId)?.status === JOB_STATUS.COMPLETED,
      30_000,
      'the delivery job to complete',
    );
    const job = queryOne<{ status: string; attempts: number }>('SELECT status, attempts FROM jobs WHERE id = ?', deliveryId);
    expect(jobDone && job?.attempts === 0, 'DELIVERY: the job id is the delivery id and it completed on its first attempt', JSON.stringify(job));
    await Bun.sleep(1_000);
    expect(readSafe(outputPathP) === beforeP, '(3) P received NO PTY write (its output file is unchanged)', readSafe(outputPathP).slice(beforeP.length).slice(-300));
    const ledgerAfterFirst = countLedger();
    expect(ledgerAfterFirst >= 3, 'DELIVERY: the notification ledger has a row per target (L, E, P)', `rows=${ledgerAfterFirst}`);

    // ===================================================================
    // (4) negative arms. Control: the accepted delivery above was seen by these very counters.
    // ===================================================================
    console.log('\n==> NEGATIVE ARMS (control: the accepted delivery above moved every counter used here)');
    const baseline = { deliveries: countDeliveries(), jobs: countJobs(), ledger: countLedger(), tagsL: tagCount(readSafe(outputPathL)), stub: stubRequests.length, deferred: countDeferred() };
    expect(baseline.deliveries === 1 && baseline.jobs === 1 && baseline.tagsL >= 1, 'ARMS: positive control -- the counters saw the accepted delivery (1 deliveries row, 1 job, the tag in L\'s output)', JSON.stringify(baseline));

    const wrongSignature = await post({ webhookId: `${WEBHOOK_ID}-bad`, secretToSign: 'whsec_' + Buffer.from('another-secret-another-secret!!').toString('base64') });
    expect(wrongSignature.status === 401, 'ARMS: a wrong signature is 401', `status=${wrongSignature.status}`);
    expect(countDeliveries() === baseline.deliveries, 'ARMS: the wrong signature created no deliveries row', `deliveries=${countDeliveries()}`);

    const unknownEndpoint = await post({ endpoint: 'no-such-endpoint-id', webhookId: `${WEBHOOK_ID}-404` });
    expect(unknownEndpoint.status === 404, 'ARMS: an unknown endpoint id is 404', `status=${unknownEndpoint.status}`);

    const stale = await post({ webhookId: `${WEBHOOK_ID}-stale`, timestamp: nowSeconds() - 301 });
    expect(stale.status === 401, 'ARMS: a timestamp 301 s old is 401', `status=${stale.status}`);

    const invalidId = await post({ webhookId: '../x' });
    expect(invalidId.status === 400, "ARMS: an invalid webhook id ('../x') is 400", `status=${invalidId.status}`);
    expect(countDeliveries() === baseline.deliveries && countJobs() === baseline.jobs, 'ARMS: no refused request created a deliveries row or a job', `deliveries=${countDeliveries()} jobs=${countJobs()}`);

    const replay = await post({ webhookId: WEBHOOK_ID, timestamp: nowSeconds() + 1 });
    const replayBody = (await replay.json().catch(() => null)) as { duplicate?: boolean } | null;
    expect(replay.status === 200 && replayBody?.duplicate === true, 'ARMS: a replay of the accepted webhook id is 200 and reported as a duplicate', `status=${replay.status} body=${JSON.stringify(replayBody)}`);
    await Bun.sleep(3_000);
    expect(
      countDeliveries() === baseline.deliveries && countJobs() === baseline.jobs && countLedger() === baseline.ledger,
      'ARMS: the replay created NO second deliveries row, NO second job and NO second ledger row',
      `deliveries=${countDeliveries()} jobs=${countJobs()} ledger=${countLedger()} baseline=${JSON.stringify(baseline)}`,
    );
    expect(
      tagCount(readSafe(outputPathL)) === baseline.tagsL && stubRequests.length === baseline.stub && countDeferred() === baseline.deferred,
      'ARMS: the replay produced NO second notification (L\'s output, the stub and P\'s deferred rows are unchanged)',
      `tagsL=${tagCount(readSafe(outputPathL))} stub=${stubRequests.length} deferred=${countDeferred()}`,
    );
    void stdoutBuf;
    void stderrBuf;
  } finally {
    if (failures.length > 0 && printStubStateOnFailure) printStubStateOnFailure();
    if (failures.length > 0) {
      console.error(`==> server stdout tail:\n${stdoutBuf.slice(-1500)}\n==> server stderr tail:\n${stderrBuf.slice(-800)}`);
    }
    // Delete the sessions through the real route while the server is up so the PTY shell and the
    // embedded worker are torn down by the server itself (SIGHUP for the PTY), then stop the server,
    // then the stub, then remove the disposable home.
    if (proc) {
      for (const id of sessionsToDelete) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE', signal: controller.signal });
          clearTimeout(timer);
        } catch (err) {
          console.error(`==> WARNING: teardown DELETE of session ${id} failed: ${String(err)}`);
        }
      }
      proc.kill();
      await proc.exited;
    }
    if (stubServer) stubServer.stop(true);
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
      console.log(`\n==> cleaned up scratch root: ${scratchRoot}`);
    } catch (err) {
      console.error(`==> WARNING: failed to clean up ${scratchRoot}: ${String(err)}`);
    }
  }

  console.log(`\n==> wall-clock: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

// Guarded: importing this module must not fire a run as a side effect.
if (import.meta.main) {
  main().catch((err) => {
    if (err instanceof BailError) {
      console.error(`\nCOULD NOT RUN: ${err.message}`);
      process.exit(2);
    }
    console.error(`E2E FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  });
}
