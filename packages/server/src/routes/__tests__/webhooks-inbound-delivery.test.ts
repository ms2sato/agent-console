/**
 * POST /webhooks/in/:endpointId through the real route, a real started JobQueue, the real
 * `initializeInboundIntegration` registration and a real SessionManager (fake PTY, memfs, real
 * SQLite): a signed request reaches the designated Orchestrator end to end.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Worker } from '@agent-console/shared';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/index.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteSessionRepository } from '../../repositories/sqlite-session-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteInboundWebhookEndpointRepository } from '../../repositories/sqlite-inbound-webhook-endpoint-repository.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { McpTokenRegistry } from '../../mcp/mcp-auth.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { initializeInboundIntegration } from '../../services/inbound/index.js';
import { repositoryLookupFromSlug } from '../../__tests__/utils/repository-lookup-mock.js';
import { inboundWebhookDeliveryId } from '../../services/inbound-webhook/receive.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import { webhooks } from '../webhooks.js';

const TEST_CONFIG_DIR = '/test/config-inbound-webhook-route';
const TEST_REPO_PATH = '/test/repo-inbound-webhook-route';
const REPO_ID = 'repo-iw';
const ENDPOINT_ID = 'ep-iw';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const NOW = new Date('2023-11-14T22:13:20.000Z');
const NOW_SECONDS = 1700000000;
const INSTRUCTION = 'Line one\r\nLine two  \n\nlast line with trailing newline\n';
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

function signature(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

async function until(condition: () => boolean | Promise<boolean>, attempts = 600): Promise<void> {
  for (let i = 0; i < attempts && !(await condition()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await condition()).toBe(true);
}

describe('POST /webhooks/in/:endpointId through the real queue', () => {
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let jobQueue: JobQueue;
  let app: Hono<AppBindings>;
  const db = () => getDatabase();

  beforeEach(async () => {
    await closeDatabase();
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
      embeddedAgentManager: { getEmbeddedAgent: () => undefined },
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
    });
    const endpoints = new SqliteInboundWebhookEndpointRepository(db());
    await endpoints.create({
      id: ENDPOINT_ID,
      label: 'Slack',
      repositoryId: REPO_ID,
      instructionText: INSTRUCTION,
      secret: SECRET,
      now: '2026-11-07T00:00:00.000Z',
    });

    jobQueue = new JobQueue(db(), { concurrency: 1 });
    initializeInboundIntegration({ db: db(), jobQueue, sessionManager, repositoryManager, broadcastToApp: () => {} });
    await jobQueue.start();

    const context: Partial<AppContext> = { db: db(), jobQueue, inboundWebhookEndpointRepository: endpoints, now: () => NOW };
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', context as AppContext);
      await next();
    });
    app.route('/webhooks', webhooks);
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
    delete process.env.AGENT_CONSOLE_HOME;
  });

  async function post(webhookId: string, body: string) {
    const ts = String(NOW_SECONDS);
    return app.request(`/webhooks/in/${ENDPOINT_ID}`, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': ts,
        'webhook-signature': signature(webhookId, ts, body),
      },
    });
  }

  it('a signed POST reaches the designated Orchestrator: files first, then the notification, job completed on the first attempt', async () => {
    const session = await sessionManager.createSession({
      type: 'worktree',
      locationPath: TEST_REPO_PATH,
      repositoryId: REPO_ID,
      worktreeId: 'orch',
    });
    await repositoryManager.addOrchestratorSession(REPO_ID, session.id);
    const worker = session.workers.find((w: Worker) => w.type === 'agent')!;
    const original = sessionManager.deliverWorkerNotification.bind(sessionManager);
    const seen: Array<{ bodyExisted: boolean; instructionExisted: boolean }> = [];
    spyOn(sessionManager, 'deliverWorkerNotification').mockImplementation(async (sessionId, workerId, params, opts) => {
      const fields: Record<string, string> = { ...params.fields };
      seen.push({ bodyExisted: fs.existsSync(fields.body_path ?? ''), instructionExisted: fs.existsSync(fields.instruction_path ?? '') });
      return original(sessionId, workerId, params, opts);
    });

    const res = await post('Ev-e2e', JSON.stringify(SENDER_BODY));

    expect(res.status).toBe(200);
    const jobId = inboundWebhookDeliveryId(ENDPOINT_ID, 'Ev-e2e');
    await until(async () => (await jobQueue.getJob(jobId))?.status === 'completed');
    expect((await jobQueue.getJob(jobId))?.attempts).toBe(0);
    expect(seen).toEqual([{ bodyExisted: true, instructionExisted: true }]);
    const paths = sessionManager.getPathResolverForSessionId(session.id)!.getInboundWebhookDeliveryPaths(session.id, worker.id, jobId);
    expect(fs.readFileSync(paths.instructionPath, 'utf-8')).toBe(INSTRUCTION);
  });

  it('a deleted endpoint ends its queued job as stalled on the first attempt, not retried', async () => {
    await jobQueue.stop();
    const res = await post('Ev-gone', JSON.stringify(SENDER_BODY));
    expect(res.status).toBe(200);
    await db().deleteFrom('inbound_webhook_endpoints').where('id', '=', ENDPOINT_ID).execute();
    await jobQueue.start();

    const jobId = inboundWebhookDeliveryId(ENDPOINT_ID, 'Ev-gone');
    await until(async () => (await jobQueue.getJob(jobId))?.status === 'stalled');
    expect((await jobQueue.getJob(jobId))?.attempts).toBe(1);
  });
});
