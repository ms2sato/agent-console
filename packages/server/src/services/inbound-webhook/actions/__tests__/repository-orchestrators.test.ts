/**
 * Attachments (the second describe below) use an injected `fetch` stub. The attachment host pin
 * forbids reaching the real Firebase host from a test, so the stub is a recorded PROXY for it:
 * everything downstream of the fetch (job handler, receive half, per-target writes, notification,
 * deferral) is the production path, in process.
 *
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
import type { AttachmentFetch, AttachmentFetchLimits } from '../../attachments.js';
import { rootLogger } from '../../../../lib/logger.js';

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
  function registerOnCapturingQueue(
    attachments?: { attachmentFetch?: AttachmentFetch; attachmentLimits?: AttachmentFetchLimits },
  ): JobHandler<InboundWebhookProcessPayload> {
    const jobQueue = new JobQueue(db(), { concurrency: 1 });
    const capture = (type: string, handler: JobHandler<never>) => {
      handlers.set(type, handler);
    };
    spyOn(jobQueue, 'registerHandler').mockImplementation(capture as typeof jobQueue.registerHandler);
    initializeInboundIntegration({
      db: db(),
      jobQueue,
      sessionManager,
      repositoryManager,
      broadcastToApp: () => {},
      inboundWebhookAttachments: attachments,
    });
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
  describe('attachments', () => {
    const ATT_TOKEN = 'tok-NEUTRAL-0003';
    const ATT_HOST = 'https://firebasestorage.googleapis.com/v0/b/bucket-NEUTRAL/o';
    const attUrl = (name: string) => `${ATT_HOST}/${name}?alt=media&token=${ATT_TOKEN}`;
    const BYTES_ONE = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
    const BYTES_TWO = Uint8Array.from([0x00, 0x00, 0x7f]);
    const FILES = [
      { name: 'one.bin', mimetype: 'application/octet-stream', size: 5, url: attUrl('doc-1') },
      { name: '../../escape.txt', mimetype: 'text/plain', size: 3, url: attUrl('doc-2') },
      { name: 'missing.png', mimetype: 'image/png', size: 9, url: attUrl('doc-3') },
    ];
    const BODY = { message: 'See attached', slack_files: FILES };

    let fetchCalls: string[];
    const stubFetch: AttachmentFetch = async (url) => {
      fetchCalls.push(url);
      if (url.includes('/doc-1?')) return new Response(BYTES_ONE, { status: 200 });
      if (url.includes('/doc-2?')) return new Response(BYTES_TWO, { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const limits: AttachmentFetchLimits = { timeoutMs: 2_000, maxBytes: 1_000, maxCount: 10 };

    beforeEach(() => {
      fetchCalls = [];
    });

    const attachmentFiles = (dir: string): Array<{ name: string; bytes: number[] }> =>
      fs.existsSync(dir)
        ? fs.readdirSync(dir).sort().map((name) => ({ name: String(name), bytes: Array.from(fs.readFileSync(`${dir}/${String(name)}`)) }))
        : [];

    it('a live target: good files land under attachments/ byte for byte, the bad one is only counted, the body and notification still deliver', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const { session, worker } = await designatedSession();
      const deliveries = watchDeliveries();
      const payload = payloadOf('wh-att-1', BODY);

      await handler(payload);

      const paths = pathsOf(session.id, worker.id, payload.jobId);
      expect(attachmentFiles(paths.attachmentsDir)).toEqual([
        { name: 'escape.txt', bytes: Array.from(BYTES_TWO) },
        { name: 'one.bin', bytes: Array.from(BYTES_ONE) },
      ]);
      expect(fs.existsSync(`${paths.dir}/../escape.txt`)).toBe(false);
      expect(fs.readFileSync(paths.bodyPath, 'utf-8')).toContain('- attachments/one.bin\n- attachments/escape.txt\n- Not fetched: 1\n');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ bodyExisted: true, instructionExisted: true });
      expect(deliveries[0]!.fields).toMatchObject({ attachments_fetched: '2', attachments_skipped: '1' });
      const written = ptyFactory.instances.flatMap((pty) => pty.writtenData).join('');
      expect(written).toContain(`body_path=${paths.bodyPath} attachments_fetched=2 attachments_skipped=1 intent=triage`);
    });

    it('the attachment URL token is in no written file (body, instruction, attachment names and bytes), no notification text and no deferred row, for a live and a paused target', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const live = await designatedSession();
      const paused = await designatedSession();
      await sessionManager.pauseSession(paused.session.id);
      const deliveries = watchDeliveries();
      const payload = payloadOf('wh-att-2', BODY);

      await handler(payload);

      expect(deliveries).toHaveLength(2);
      const rows = await deferredRows(paused.session.id);
      expect(rows).toHaveLength(1); // positive control for the deferred row
      const pausedParams = JSON.parse(rows[0]!.paramsJson) as { fields: Record<string, string> };
      const livePaths = pathsOf(live.session.id, live.worker.id, payload.jobId);
      const pausedBodyPath = pausedParams.fields.body_path!;
      const pausedDir = pausedBodyPath.slice(0, pausedBodyPath.lastIndexOf('/'));
      const targets = [
        { bodyPath: livePaths.bodyPath, instructionPath: livePaths.instructionPath, attachmentsDir: livePaths.attachmentsDir },
        { bodyPath: pausedBodyPath, instructionPath: `${pausedDir}/instruction.md`, attachmentsDir: `${pausedDir}/attachments` },
      ];
      const haystacks: string[] = [];
      for (const target of targets) {
        const files = attachmentFiles(target.attachmentsDir);
        expect(files.length).toBe(2); // positive control: the attachment directory was really scanned
        haystacks.push(fs.readFileSync(target.bodyPath, 'utf-8'), fs.readFileSync(target.instructionPath, 'utf-8'));
        for (const file of files) haystacks.push(file.name, Buffer.from(file.bytes).toString('latin1'));
      }
      haystacks.push(ptyFactory.instances.flatMap((pty) => pty.writtenData).join(''));
      haystacks.push(...deliveries.map((d) => JSON.stringify(d.fields)));
      haystacks.push(rows[0]!.paramsJson);

      for (const haystack of haystacks) {
        expect(haystack).not.toContain(ATT_TOKEN);
        expect(haystack).not.toContain('firebasestorage');
      }
      expect(pausedParams.fields).toMatchObject({ attachments_fetched: '2', attachments_skipped: '1' });
    });

    it('fan-out: each designated session gets its own identical copy and every file is fetched once, not once per target', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const first = await designatedSession();
      const second = await designatedSession();
      const payload = payloadOf('wh-att-3', BODY);

      await handler(payload);

      expect(fetchCalls).toHaveLength(3);
      const dirs = [first, second].map((t) => pathsOf(t.session.id, t.worker.id, payload.jobId).attachmentsDir);
      expect(dirs[0]).not.toBe(dirs[1]);
      const copies = dirs.map(attachmentFiles);
      expect(copies[0]!.length).toBe(2);
      expect(copies[1]).toEqual(copies[0]!);
    });

    it('a message without slack_files: no attachments directory and none of the count fields', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const { session, worker } = await designatedSession();
      const deliveries = watchDeliveries();
      const payload = payloadOf('wh-att-4', { message: 'plain' });

      await handler(payload);

      expect(fetchCalls).toEqual([]);
      expect(fs.existsSync(pathsOf(session.id, worker.id, payload.jobId).attachmentsDir)).toBe(false);
      expect(Object.keys(deliveries[0]!.fields)).not.toContain('attachments_fetched');
      expect(Object.keys(deliveries[0]!.fields)).not.toContain('attachments_skipped');
    });

    it('a message whose files are all refused still delivers, with 0 fetched and every file counted', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const { session, worker } = await designatedSession();
      const deliveries = watchDeliveries();
      const payload = payloadOf('wh-att-5', { message: 'm', slack_files: [{ name: 'x', url: 'https://files.slack.com/x?t=1' }] });

      await handler(payload);

      expect(fetchCalls).toEqual([]);
      expect(deliveries[0]!.fields).toMatchObject({ attachments_fetched: '0', attachments_skipped: '1' });
      expect(attachmentFiles(pathsOf(session.id, worker.id, payload.jobId).attachmentsDir)).toEqual([]);
    });

    it('a per-target attachment write failure skips the attachments for that target only: the target and its body still deliver, the other target is complete, and the event counts are unchanged', async () => {
      const handler = registerOnCapturingQueue({ attachmentFetch: stubFetch, attachmentLimits: limits });
      const broken = await designatedSession();
      const healthy = await designatedSession();
      const payload = payloadOf('wh-att-6', BODY);
      const brokenPaths = pathsOf(broken.session.id, broken.worker.id, payload.jobId);
      // A regular file where the attachments directory belongs: the walker refuses to create under it.
      fs.mkdirSync(brokenPaths.dir, { recursive: true });
      fs.writeFileSync(brokenPaths.attachmentsDir, 'not a directory');
      const deliveries = watchDeliveries();
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
      const spies = levels.map((level) => spyOn(rootLogger, level));
      try {
        await handler(payload);

        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        expect(logged).toContain('Failed to write an inbound webhook attachment for a target');
        for (const secret of [ATT_TOKEN, 'one.bin', 'escape.txt']) expect(logged).not.toContain(secret);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      expect(deliveries.map((d) => d.sessionId).sort()).toEqual([broken.session.id, healthy.session.id].sort());
      expect(fs.readFileSync(brokenPaths.bodyPath, 'utf-8')).toContain('- attachments/one.bin');
      expect(fs.statSync(brokenPaths.attachmentsDir).isFile()).toBe(true);
      const healthyPaths = pathsOf(healthy.session.id, healthy.worker.id, payload.jobId);
      expect(attachmentFiles(healthyPaths.attachmentsDir).length).toBe(2);
      for (const d of deliveries) expect(d.fields).toMatchObject({ attachments_fetched: '2', attachments_skipped: '1' });
    });
  });
});
