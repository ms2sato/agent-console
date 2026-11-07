/**
 * The action half end to end: real SessionManager (fake PTY), real SQLite, memfs, the real
 * `initializeInboundIntegration` registration and the real inbound pipeline. Fakes sit only at the
 * PTY seam. Direct tests drive the registered `inbound-webhook:process` handler; the route test
 * drives a signed POST through the real route and a real, started JobQueue.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import type { InboundWebhookProcessPayload, Worker } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../../../database/connection.js';
import { JobQueue, JOB_TYPES, type JobHandler } from '../../../../jobs/index.js';
import { SessionManager } from '../../../session-manager.js';
import { RepositoryManager } from '../../../repository-manager.js';
import { AgentManager } from '../../../agent-manager.js';
import { SqliteAgentRepository } from '../../../../repositories/sqlite-agent-repository.js';
import { SqliteRepositoryRepository } from '../../../../repositories/sqlite-repository-repository.js';
import { SqliteSessionRepository } from '../../../../repositories/sqlite-session-repository.js';
import { SqliteUserRepository } from '../../../../repositories/sqlite-user-repository.js';
import { SqliteDeferredWorkerNotificationRepository } from '../../../../repositories/sqlite-deferred-worker-notification-repository.js';
import { SqliteInboundWebhookEndpointRepository } from '../../../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { SingleUserMode } from '../../../user-mode.js';
import { McpTokenRegistry } from '../../../../mcp/mcp-auth.js';
import { AnnotationService } from '../../../annotation-service.js';
import { initializeInboundIntegration } from '../../../inbound/index.js';
import { repositoryLookupFromSlug } from '../../../../__tests__/utils/repository-lookup-mock.js';
import { inboundWebhookDeliveryId } from '../../receive.js';

const TEST_CONFIG_DIR = '/test/config-inbound-webhook-action';
const TEST_REPO_PATH = '/test/repo-inbound-webhook-action';
const REPO_ID = 'repo-iw';
const ENDPOINT_ID = 'ep-iw';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const RECEIVED_AT = '2026-11-08T00:00:00.000Z';
const INSTRUCTION = 'Line one\r\nLine two  \n\nlast line with trailing newline\n';
const EMBEDDED_DEF = {
  id: 'stub-embedded-agent',
  name: 'Stub Model',
  engine: 'openai-api' as const,
  isBuiltIn: false,
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  createdBy: 'test-user-id',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};
const TOKEN_LOOKING = 'tok-TOKENLIKE-SUBSTRING';
const SENDER_BODY = {
  schema_version: 1,
  message: 'Deploy finished\nsecond line',
  slack_channel: 'C123',
  slack_ts: '1700000000.000100',
  slack_permalink: 'https://example.slack.com/archives/C123/p1700000000000100',
  slack_files: [{ name: 'a.png', url: `https://files.slack.com/files-pri/T1-F1/a.png?t=${TOKEN_LOOKING}` }],
  slack_message: { text: 'RAW-SLACK-EVENT-TEXT', user: 'U1' },
};

const ptyFactory = createMockPtyFactory();

async function until(condition: () => boolean | Promise<boolean>, attempts = 600): Promise<void> {
  for (let i = 0; i < attempts && !(await condition()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await condition()).toBe(true);
}

describe('inbound webhook action: repository orchestrators', () => {
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let endpoints: SqliteInboundWebhookEndpointRepository;
  const handlers = new Map<string, JobHandler<never>>();

  const db = () => getDatabase();

  beforeEach(async () => {
    await closeDatabase();
    handlers.clear();
    setupMemfs({ [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main', [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');
    resetProcessMock();
    mockProcess.markAlive(process.pid);
    ptyFactory.reset();
    resetGitMocks();

    const agentManager = await AgentManager.create(new SqliteAgentRepository(db()));
    const repositoryRepo = new SqliteRepositoryRepository(db());
    await repositoryRepo.save({
      id: REPO_ID,
      name: 'test-repo',
      path: TEST_REPO_PATH,
      createdAt: new Date().toISOString(),
      orchestratorSessionIds: [],
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: repositoryRepo });
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository: new SqliteSessionRepository(db()),
      db: db(),
      agentManager,
      embeddedAgentManager: { getEmbeddedAgent: (id: string) => (id === EMBEDDED_DEF.id ? EMBEDDED_DEF : undefined) },
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository: new SqliteUserRepository(db()),
      repositoryLookup: repositoryLookupFromSlug(async (id: string) => repositoryManager.getRepositorySlug(id)),
      repositoryEnvLookup: {
        getRepositoryInfo: (id: string) => {
          const r = repositoryManager.getRepository(id);
          return r ? { name: r.name, path: r.path, envVars: r.envVars } : undefined;
        },
        getWorktreeIndexNumber: async () => 0,
      },
      // The resume digest waits for the agent PTY to be ready; the mock PTY never prints, so the cap ends the wait.
      readiness: { minOutputBytes: 100, settleMs: 5, capMs: 200 },
    });

    endpoints = new SqliteInboundWebhookEndpointRepository(db());
    await endpoints.create({
      id: ENDPOINT_ID,
      label: 'Slack',
      repositoryId: REPO_ID,
      instructionText: INSTRUCTION,
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  /** Registers the real handlers on a capture-only queue and returns the process handler. */
  function registerOnCapturingQueue(): JobHandler<InboundWebhookProcessPayload> {
    const jobQueue = new JobQueue(db(), { concurrency: 1 });
    const capture = (type: string, handler: JobHandler<never>) => {
      handlers.set(type, handler);
    };
    spyOn(jobQueue, 'registerHandler').mockImplementation(capture as typeof jobQueue.registerHandler);
    initializeInboundIntegration({ db: db(), jobQueue, sessionManager, repositoryManager, broadcastToApp: () => {} });
    const handler = handlers.get(JOB_TYPES.INBOUND_WEBHOOK_PROCESS);
    if (!handler) throw new Error('inbound-webhook:process handler was not registered');
    return handler as JobHandler<InboundWebhookProcessPayload>;
  }

  async function designatedSession(kind: 'agent' | 'embedded' = 'agent') {
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: TEST_REPO_PATH,
      repositoryId: REPO_ID,
      worktreeId: `wt-${Math.random().toString(36).slice(2, 8)}`,
      ...(kind === 'embedded' ? { embeddedAgentId: EMBEDDED_DEF.id } : {}),
    });
    await repositoryManager.addOrchestratorSession(REPO_ID, session.id);
    const worker = session.workers.find((w: Worker) => (kind === 'embedded' ? w.type === 'embedded-agent' : w.type === 'agent'));
    if (!worker) throw new Error('session has no deliverable worker');
    return { session, worker };
  }

  function payloadOf(webhookId = 'wh-1', body: unknown = SENDER_BODY): InboundWebhookProcessPayload {
    return {
      jobId: inboundWebhookDeliveryId(ENDPOINT_ID, webhookId),
      endpointId: ENDPOINT_ID,
      rawPayload: JSON.stringify(body),
      receivedAt: RECEIVED_AT,
    };
  }

  function pathsOf(sessionId: string, workerId: string, deliveryId: string) {
    const resolver = sessionManager.getPathResolverForSessionId(sessionId);
    if (!resolver) throw new Error('no resolver');
    return resolver.getInboundWebhookDeliveryPaths(sessionId, workerId, deliveryId);
  }

  /** Wraps the seam: records, for each delivery, whether both files existed at that moment. */
  function watchDeliveries() {
    const original = sessionManager.deliverWorkerNotification.bind(sessionManager);
    const deliveries: Array<{ sessionId: string; workerId: string; bodyExisted: boolean; instructionExisted: boolean; fields: Record<string, string> }> = [];
    spyOn(sessionManager, 'deliverWorkerNotification').mockImplementation(async (sessionId, workerId, params, opts) => {
      const fields: Record<string, string> = { ...params.fields };
      deliveries.push({
        sessionId,
        workerId,
        bodyExisted: fs.existsSync(fields.body_path ?? ''),
        instructionExisted: fs.existsSync(fields.instruction_path ?? ''),
        fields,
      });
      return original(sessionId, workerId, params, opts);
    });
    return deliveries;
  }

  const deferredRows = (sessionId: string) => new SqliteDeferredWorkerNotificationRepository(db()).listBySession(sessionId);

  it('a live PTY target: both files exist when the notification is delivered, instruction.md is the stored text byte for byte, body.md never carries the raw event or file URLs', async () => {
    const handler = registerOnCapturingQueue();
    const { session, worker } = await designatedSession();
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ sessionId: session.id, workerId: worker.id, bodyExisted: true, instructionExisted: true });
    const paths = pathsOf(session.id, worker.id, payload.jobId);
    expect(deliveries[0]!.fields).toMatchObject({ body_path: paths.bodyPath, instruction_path: paths.instructionPath, repo: 'owner/repo' });

    expect(fs.readFileSync(paths.instructionPath, 'utf-8')).toBe(INSTRUCTION);
    const body = fs.readFileSync(paths.bodyPath, 'utf-8');
    expect(body).toContain('Deploy finished');
    for (const forbidden of ['slack_message', 'RAW-SLACK-EVENT-TEXT', 'slack_files', 'files.slack.com', TOKEN_LOOKING]) {
      expect(body).not.toContain(forbidden);
    }
    const written = ptyFactory.instances.flatMap((pty) => pty.writtenData).join('');
    expect(written).toContain('[inbound:external:message]');
    expect(written).toContain(`body_path=${paths.bodyPath}`);
  });

  it('a paused target: exactly one inbound-event row whose params carry both paths, files present before and after the resume', async () => {
    const handler = registerOnCapturingQueue();
    const { session } = await designatedSession();
    await sessionManager.pauseSession(session.id);
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);

    const rows = await deferredRows(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('inbound-event');
    const params = JSON.parse(rows[0]!.paramsJson) as { fields: Record<string, string> };
    expect(params.fields.body_path).toBeString();
    expect(params.fields.instruction_path).toBeString();
    expect(fs.readFileSync(params.fields.instruction_path!, 'utf-8')).toBe(INSTRUCTION);
    expect(fs.existsSync(params.fields.body_path!)).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ bodyExisted: true, instructionExisted: true });

    await sessionManager.resumeSession(session.id);
    await until(async () => (await deferredRows(session.id)).length === 0);
    expect(fs.existsSync(params.fields.body_path!)).toBe(true);
    expect(fs.readFileSync(params.fields.instruction_path!, 'utf-8')).toBe(INSTRUCTION);
  });

  it('an embedded target: the same files and fields, addressed to its embedded-agent worker', async () => {
    const handler = registerOnCapturingQueue();
    const { session, worker } = await designatedSession('embedded');
    await sessionManager.pauseSession(session.id);
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ sessionId: session.id, workerId: worker.id, bodyExisted: true, instructionExisted: true });
    const rows = await deferredRows(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workerId).toBe(worker.id);
    expect(fs.readFileSync(deliveries[0]!.fields.instruction_path!, 'utf-8')).toBe(INSTRUCTION);
  });

  it('zero designated sessions: the job completes and nothing is written or delivered', async () => {
    const handler = registerOnCapturingQueue();
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: TEST_REPO_PATH,
      repositoryId: REPO_ID,
      worktreeId: 'not-designated',
    });
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);

    expect(deliveries).toEqual([]);
    const worker = session.workers.find((w: Worker) => w.type === 'agent')!;
    const { dir } = pathsOf(session.id, worker.id, payload.jobId);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('two designated sessions: each target gets its own directory and both deliver', async () => {
    const handler = registerOnCapturingQueue();
    const first = await designatedSession();
    const second = await designatedSession();
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);

    expect(deliveries.map((d) => d.sessionId).sort()).toEqual([first.session.id, second.session.id].sort());
    expect(deliveries.every((d) => d.bodyExisted && d.instructionExisted)).toBe(true);
    const dirs = new Set(deliveries.map((d) => d.fields.body_path));
    expect(dirs.size).toBe(2);
  });

  it('a write failure for one target drops only that target', async () => {
    const handler = registerOnCapturingQueue();
    const broken = await designatedSession();
    const healthy = await designatedSession();
    const payload = payloadOf();
    // A regular file where the delivery directory chain needs a directory: the walker refuses it.
    const brokenPaths = pathsOf(broken.session.id, broken.worker.id, payload.jobId);
    const blocker = brokenPaths.dir.slice(0, brokenPaths.dir.lastIndexOf('/'));
    fs.mkdirSync(blocker.slice(0, blocker.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(blocker, 'not a directory');
    const deliveries = watchDeliveries();

    await handler(payload);

    expect(deliveries.map((d) => d.sessionId)).toEqual([healthy.session.id]);
    expect(fs.existsSync(brokenPaths.bodyPath)).toBe(false);
  });

  it('a retried job (same delivery id) does not notify an already-notified target again', async () => {
    const handler = registerOnCapturingQueue();
    await designatedSession();
    const deliveries = watchDeliveries();
    const payload = payloadOf();

    await handler(payload);
    expect(deliveries).toHaveLength(1);
    await handler(payload);

    expect(deliveries).toHaveLength(1);
    const ledger = await db().selectFrom('inbound_event_notifications').selectAll().execute();
    expect(ledger.map((r) => [r.job_id, r.status])).toEqual([[payload.jobId, 'delivered']]);
  });

  it('an instruction_text edited between receipt and processing is what lands in instruction.md', async () => {
    const handler = registerOnCapturingQueue();
    const { session, worker } = await designatedSession();
    const payload = payloadOf();
    const edited = 'Edited after receipt\r\nsecond line\n';
    await db().updateTable('inbound_webhook_endpoints').set({ instruction_text: edited }).where('id', '=', ENDPOINT_ID).execute();

    await handler(payload);

    expect(fs.readFileSync(pathsOf(session.id, worker.id, payload.jobId).instructionPath, 'utf-8')).toBe(edited);
  });

  it('a deleted endpoint ends the job without delivery and without files', async () => {
    const handler = registerOnCapturingQueue();
    const { session, worker } = await designatedSession();
    const deliveries = watchDeliveries();
    const payload = payloadOf();
    await db().deleteFrom('inbound_webhook_endpoints').where('id', '=', ENDPOINT_ID).execute();

    await expect(handler(payload)).resolves.toBeUndefined();

    expect(deliveries).toEqual([]);
    expect(fs.existsSync(pathsOf(session.id, worker.id, payload.jobId).dir)).toBe(false);
  });

  it('a cascade-deleted endpoint (its repository deleted) ends the job the same way', async () => {
    const handler = registerOnCapturingQueue();
    await db().insertInto('repositories').values({ id: 'repo-gone', name: 'gone', path: '/tmp/gone' }).execute();
    await endpoints.create({
      id: 'ep-gone',
      label: 'Gone',
      repositoryId: 'repo-gone',
      instructionText: 'x',
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });
    await db().deleteFrom('repositories').where('id', '=', 'repo-gone').execute();
    const deliveries = watchDeliveries();

    await expect(
      handler({ jobId: inboundWebhookDeliveryId('ep-gone', 'wh-1'), endpointId: 'ep-gone', rawPayload: JSON.stringify(SENDER_BODY), receivedAt: RECEIVED_AT }),
    ).resolves.toBeUndefined();
    expect(deliveries).toEqual([]);
  });
});
