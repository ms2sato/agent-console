/**
 * `reply_to_inbound_webhook` MCP tool tests.
 *
 * Drives the REAL `createMcpApp` handler chain via `callTool`, against a real `SessionManager` backed by
 * a real `SqliteSessionRepository` (the routing rows reference real session rows).
 *
 * Two groups:
 * - Handler tests: the tool's dependency is a recording stub, so what is asserted is the handler's own
 *   work (caller resolution, session ownership, outcome mapping) and that the service is reached, or not,
 *   with the right input.
 * - `proxy success path (injected fetch)`: the real database, endpoint repository, reply service and MCP
 *   handler, with ONLY `fetch` injected at the service's dependency seam. The injected fetch plays the
 *   sender and verifies the signature with its OWN HMAC code written from the Standard Webhooks
 *   specification. It is a recorded proxy for the real transport (`outboundFetch`): everything the
 *   transport is not stays production-real.
 *
 * What a missing `body` does: the schema accepts `body` as `unknown`, so a call without it reaches the
 * service, which refuses it with `body must be a JSON object` (asserted below).
 *
 * Mutation reach (measured at the final state; each production edit was reverted with `cmp`):
 * - drop the `checkCallerOwnsSession` call from the tool:
 *     fails "a session owned by someone else than the token's user is refused by the ownership rule and the service is not called".
 * - remove `'reply_to_inbound_webhook'` from SESSION_CLAIMING_TOOLS:
 *     fails "SESSION_CLAIMING_TOOLS registry > every registration that calls checkCallerOwnsSession is listed, and every listed tool calls it" in session-claiming-tools.test.ts.
 * - sign with a constant key (reply service):
 *     fails "proxy success path (injected fetch): the sender verifies the signature over the exact body bytes, a resend reuses the id with a fresh signature, and nothing secret is returned".
 * - return the signature in the tool result:
 *     fails the same proxy test (absence assertion).
 * - mint a new id on resend (reply service):
 *     fails the same proxy test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import * as os from 'os';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { INBOUND_WEBHOOK_SECRET_PREFIX } from '../../lib/inbound-webhook-secret.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteBookmarkRepository } from '../../repositories/sqlite-bookmark-repository.js';
import { SqliteInboundWebhookEndpointRepository } from '../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import { TimerManager } from '../../services/timer-manager.js';
import { ConditionalWakeupManager } from '../../services/conditional-wakeup-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { inboundWebhookDeliveryId } from '../../services/inbound-webhook/receive.js';
import {
  replyToInboundWebhook,
  REPLY_ERRORS,
  type ReplyFetch,
  type ReplyInput,
  type ReplyOutcome,
} from '../../services/inbound-webhook/reply.js';
import { createMcpApp } from '../mcp-server.js';
import { McpTokenRegistry } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';

const TEST_CONFIG_DIR = '/test/config-reply-tool';
const TEST_REPO_PATH = '/test/repo-reply-tool';
const TEST_REPO_ID = 'repo-reply-tool';
const ENDPOINT_ID = 'ep-reply-tool';
const WEBHOOK_ID = 'Ev-reply-tool';
const DELIVERY_ID = inboundWebhookDeliveryId(ENDPOINT_ID, WEBHOOK_ID);

const SECRET_MARKER = 'SECRETMARKER-reply-tool';
const REPLY_URL = 'https://sender.example/replies?token=URLMARKER-reply-tool';

/** Sender-side signature, written from the Standard Webhooks specification (not production code). */
function specSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe('reply_to_inbound_webhook', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let agentDirectory: AgentDirectory;
  let worktreeService: WorktreeService;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let registry: McpTokenRegistry;
  let nextId: number;
  let osUidCounter = 41000;

  let serviceCalls: ReplyInput[];
  let serviceOutcome: ReplyOutcome;
  let serviceThrows: Error | null;

  async function mountMcpApp(replyImpl: ((input: ReplyInput) => Promise<ReplyOutcome>) | undefined): Promise<void> {
    registry = new McpTokenRegistry();
    app = new Hono();
    app.route(
      '',
      createMcpApp({
        sessionManager,
        repositoryManager,
        agentManager,
        agentDirectory,
        timerManager: new TimerManager(() => {}),
        conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
        interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
        worktreeService,
        annotationService: new AnnotationService(),
        interSessionMessageService: new InterSessionMessageService(),
        suggestSessionMetadata: async () => ({ branch: 'unused', title: 'unused' }),
        createWorktreeWithSession,
        deleteWorktree,
        userRepository,
        artifactRepository,
        bookmarkRepository: new SqliteBookmarkRepository(getDatabase()),
        replyToInboundWebhook: replyImpl,
        broadcastToApp: () => {},
        findOpenPullRequest: async () => null,
        fetchPullRequestUrl: async () => null,
        mcpAuthMode: 'off',
        mcpTokenRegistry: registry,
      }),
    );
    mcpSessionId = await initializeMcp(app);
  }

  const recordingStub = async (input: ReplyInput): Promise<ReplyOutcome> => {
    serviceCalls.push(input);
    if (serviceThrows) throw serviceThrows;
    return serviceOutcome;
  };

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [TEST_CONFIG_DIR]: null,
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    await initializeDatabase(':memory:');
    testJobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(testJobQueue, new WorkerOutputFileManager());

    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const db = getDatabase();
    agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    const embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    userRepository = new SqliteUserRepository(db);
    artifactRepository = new SqliteArtifactRepository(db);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository: new SqliteSessionRepository(db),
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository,
      repositoryLookup: repositoryLookupFromSlug(async (id: string) => repositoryManager?.getRepositorySlug(id)),
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager?.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
    });

    const sqliteRepoRepo = new SqliteRepositoryRepository(db);
    await sqliteRepoRepo.save({
      id: TEST_REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });
    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    serviceCalls = [];
    serviceThrows = null;
    serviceOutcome = {
      ok: true,
      result: { replyId: 'reply_stub', attempt: 1, outcome: 'responded', status: 200, responseBody: 'ok', responseBodyTruncated: false },
    };
    nextId = 10;
    await mountMcpApp(recordingStub);
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function createOwnedSession(username: string): Promise<{ sessionId: string; workerId: string; userId: string }> {
    const owner = await userRepository.upsertByOsUid(osUidCounter++, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: os.tmpdir(), agentId: 'claude-code' },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, workerId: session.workers.find((w) => w.type === 'agent')!.id, userId: owner.id };
  }

  const bearer = (ids: { sessionId: string; workerId: string; userId: string }) => ({
    Authorization: `Bearer ${registry.mint(ids)}`,
  });

  const call = (args: Record<string, unknown>, headers?: Record<string, string>) =>
    callTool(app, mcpSessionId, 'reply_to_inbound_webhook', args, nextId++, headers);

  const errorText = (response: Awaited<ReturnType<typeof callTool>>): string => {
    expect(response.result?.isError).toBe(true);
    return (parseToolResult(response) as { error: string }).error;
  };

  // -------------------------------------------------------------------------
  // Handler tests (recording stub at the service seam)
  // -------------------------------------------------------------------------

  it('an embedded caller (bearer identity, no sessionId) reaches the service with its own session id', async () => {
    const ids = await createOwnedSession('embedded-owner');
    const response = await call({ deliveryId: DELIVERY_ID, body: { text: 'hi' } }, bearer(ids));

    expect(response.result?.isError).toBeUndefined();
    expect(serviceCalls).toEqual([{ sessionId: ids.sessionId, deliveryId: DELIVERY_ID, body: { text: 'hi' }, replyId: undefined }]);
  });

  it('a terminal caller (no token) passing sessionId reaches the service with that session id and the replyId', async () => {
    const ids = await createOwnedSession('terminal-owner');
    const response = await call({ deliveryId: DELIVERY_ID, body: { text: 'hi' }, replyId: 'reply_x', sessionId: ids.sessionId });

    expect(response.result?.isError).toBeUndefined();
    expect(serviceCalls).toEqual([{ sessionId: ids.sessionId, deliveryId: DELIVERY_ID, body: { text: 'hi' }, replyId: 'reply_x' }]);
  });

  it('a tokenless call without sessionId is refused by the identity rule and the service is not called', async () => {
    const response = await call({ deliveryId: DELIVERY_ID, body: {} });

    expect(errorText(response)).toContain('reply_to_inbound_webhook');
    expect(serviceCalls).toHaveLength(0);
  });

  it('a claimed session that differs from the bearer identity is refused and the service is not called', async () => {
    const mine = await createOwnedSession('claim-mine');
    const other = await createOwnedSession('claim-other');
    const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: other.sessionId }, bearer(mine));

    expect(errorText(response)).toContain('can only act as your own');
    expect(serviceCalls).toHaveLength(0);
  });

  it("a session owned by someone else than the token's user is refused by the ownership rule and the service is not called", async () => {
    const owner = await createOwnedSession('ownership-owner');
    // The token names the right session and worker but a user who does not own that session.
    const forged = { sessionId: owner.sessionId, workerId: owner.workerId, userId: 'someone-else' };
    const response = await call({ deliveryId: DELIVERY_ID, body: {} }, bearer(forged));

    expect(errorText(response)).toContain('MCP caller identity mismatch');
    expect(serviceCalls).toHaveLength(0);
  });

  it('an unknown session id is refused and the service is not called', async () => {
    const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: 'no-such-session' });

    expect(errorText(response)).toBe('Session not found: no-such-session');
    expect(serviceCalls).toHaveLength(0);
  });

  it('service error strings come back as tool errors unchanged', async () => {
    const ids = await createOwnedSession('errors-owner');
    for (const error of Object.values(REPLY_ERRORS)) {
      serviceOutcome = { ok: false, error };
      const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: ids.sessionId });
      expect(errorText(response)).toBe(error);
    }
  });

  it('a missing body, or a body that is not an object, reaches the service, which refuses it', async () => {
    const ids = await createOwnedSession('body-owner');
    // The recording stub does not validate: assert only that the value arrives untouched.
    await call({ deliveryId: DELIVERY_ID, sessionId: ids.sessionId });
    await call({ deliveryId: DELIVERY_ID, body: [1], sessionId: ids.sessionId });
    expect(serviceCalls.map((c) => c.body)).toEqual([undefined, [1]]);
  });

  it('a success result is JSON with replyId, attempt and outcome', async () => {
    const ids = await createOwnedSession('result-owner');
    const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: ids.sessionId });

    expect(parseToolResult(response)).toEqual({
      replyId: 'reply_stub',
      attempt: 1,
      outcome: 'responded',
      status: 200,
      responseBody: 'ok',
      responseBodyTruncated: false,
    });
  });

  it('a thrown service error becomes a generic tool error that does not carry the thrown text', async () => {
    const ids = await createOwnedSession('throw-owner');
    serviceThrows = new Error('connect failed to https://sender.example/replies?token=URLMARKER-reply-tool');
    const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: ids.sessionId });

    const text = errorText(response);
    expect(text).toBe('The reply could not be sent');
    expect(JSON.stringify(response)).not.toContain('URLMARKER');
  });

  it('without the dependency the tool returns an error result', async () => {
    await mountMcpApp(undefined);
    const ids = await createOwnedSession('nodep-owner');
    const response = await call({ deliveryId: DELIVERY_ID, body: {}, sessionId: ids.sessionId });

    expect(errorText(response)).toBe('Replying to inbound webhooks is not available on this server');
  });

  // -------------------------------------------------------------------------
  // In-process success-path proxy: real db, repository, service and handler; only fetch is injected
  // -------------------------------------------------------------------------

  it('proxy success path (injected fetch): the sender verifies the signature over the exact body bytes, a resend reuses the id with a fresh signature, and nothing secret is returned', async () => {
    const db = getDatabase();
    const ids = await createOwnedSession('proxy-owner');

    // The endpoint, its secret (captured from the repository's create) and a routed delivery.
    const endpoints = new SqliteInboundWebhookEndpointRepository(db);
    const created = await endpoints.create({
      id: ENDPOINT_ID,
      label: 'Sender',
      repositoryId: TEST_REPO_ID,
      instructionText: 'instruction',
      secret: `${INBOUND_WEBHOOK_SECRET_PREFIX}${Buffer.from(`${SECRET_MARKER}-key-bytes-0123456789`).toString('base64')}`,
      replyUrl: REPLY_URL,
      now: '2026-11-07T00:00:00.000Z',
    });
    const secret = created.secret;
    await db
      .insertInto('inbound_webhook_deliveries')
      .values({ endpoint_id: ENDPOINT_ID, webhook_id: WEBHOOK_ID, received_at: new Date().toISOString() })
      .execute();
    await db
      .insertInto('inbound_event_notifications')
      .values({
        id: crypto.randomUUID(),
        job_id: DELIVERY_ID,
        session_id: ids.sessionId,
        worker_id: ids.workerId,
        handler_id: 'h1',
        event_type: 'external:message',
        event_summary: 'summary',
        status: 'delivered',
        created_at: new Date().toISOString(),
        notified_at: null,
      })
      .execute();

    // The sender: verifies with its own HMAC code and answers 200 with a body.
    interface SeenRequest {
      url: string;
      headers: Record<string, string>;
      body: string;
      verified: boolean;
    }
    const seen: SeenRequest[] = [];
    const senderFetch: ReplyFetch = async (url, init) => {
      const verified =
        init.headers['webhook-signature'] ===
        specSignature(secret, init.headers['webhook-id']!, init.headers['webhook-timestamp']!, init.body);
      seen.push({ url, headers: init.headers, body: init.body, verified });
      return new Response('accepted by the sender', { status: 200 });
    };

    let clock = new Date('2026-11-21T10:00:00.000Z');
    await mountMcpApp((input) =>
      replyToInboundWebhook(input, { endpoints, db, fetch: senderFetch, now: () => clock, timeoutMs: 2000 }),
    );

    const body = { text: 'hello', nested: { b: 2, a: 1 } };
    const first = await call({ deliveryId: DELIVERY_ID, body, sessionId: ids.sessionId });
    const firstResult = parseToolResult(first) as Record<string, unknown>;

    expect(first.result?.isError).toBeUndefined();
    expect(firstResult).toMatchObject({
      attempt: 1,
      outcome: 'responded',
      status: 200,
      responseBody: 'accepted by the sender',
      responseBodyTruncated: false,
    });
    const replyId = firstResult.replyId as string;
    expect(replyId).toMatch(/^reply_[0-9a-f-]{36}$/);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(REPLY_URL);
    expect(seen[0]!.body).toBe(JSON.stringify(body));
    expect(seen[0]!.verified).toBe(true);
    expect(seen[0]!.headers['webhook-id']).toBe(replyId);

    // Resend: same id, same body, a later timestamp, a signature that verifies for it.
    clock = new Date('2026-11-21T10:00:05.000Z');
    const second = await call({ deliveryId: DELIVERY_ID, body, replyId, sessionId: ids.sessionId });
    const secondResult = parseToolResult(second) as Record<string, unknown>;

    expect(second.result?.isError).toBeUndefined();
    expect(secondResult).toMatchObject({ replyId, attempt: 2, outcome: 'responded', status: 200 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers['webhook-id']).toBe(replyId);
    expect(seen[1]!.headers['webhook-timestamp']).not.toBe(seen[0]!.headers['webhook-timestamp']);
    expect(seen[1]!.headers['webhook-signature']).not.toBe(seen[0]!.headers['webhook-signature']);
    expect(seen[1]!.verified).toBe(true);

    // Nothing secret comes back: neither the secret (or its marker) nor a signature nor the URL.
    for (const response of [first, second]) {
      const text = JSON.stringify(response);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain('v1,');
      expect(text).not.toContain('URLMARKER');
      expect(text).not.toContain('sender.example');
    }
    for (const request of seen) {
      expect(JSON.stringify(firstResult)).not.toContain(request.headers['webhook-signature']!);
    }
  });
});
