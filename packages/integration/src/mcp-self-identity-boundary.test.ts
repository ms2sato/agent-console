/**
 * Cross-Package Boundary Test: `send_session_message`'s `fromSessionId`
 * self-identity resolution (`resolveSelfIdentity`, Issue #1696), driven by
 * a real activation-minted MCP token.
 *
 * Modeled on `embedded-agent-notification-boundary.test.ts`'s second
 * `describe` block ("create_timer targeting an embedded-agent worker, via a
 * real /mcp call authenticated with the worker's own MCP token"): a real
 * `createMcpApp` under `mcpAuthMode: 'enforce'`, a real embedded-agent
 * worker activated through `SessionManager.activateEmbeddedAgentWorker`
 * with a fake loop subprocess, and the bearer token extracted from the
 * REAL `init` command the server wrote to that subprocess's stdin --
 * exactly the token the real embedded-agent subprocess would authenticate
 * its own outbound MCP calls with, not a fresh token minted for the test's
 * own convenience.
 *
 * The unit-level table (`mcp-server/__tests__/mcp-self-identity-tools.test.ts`)
 * already exercises the real `createMcpAuthMiddleware` with a minted token,
 * which is the correct layer for exhaustively covering all eleven
 * arguments' case-(a)/(b)/(c) shapes. What THIS file adds, and the unit
 * layer cannot substitute for, are two things at once: (1) the bearer
 * token is the one a real worker activation mints and hands to its own
 * subprocess via the `init` command's `mcp.token` field -- proving the
 * self-identity resolution is wired to the SAME token an embedded agent
 * actually authenticates with, not merely to "some token shaped like
 * `McpCallerIdentity`"; (2) the on-disk effect (or its absence) is read
 * from the real `InterSessionMessageService`-written message file via the
 * production `SessionDataPathResolver`, not from the tool's JSON response
 * alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';
import { SqliteBookmarkRepository } from '@agent-console/server/src/repositories/sqlite-bookmark-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { AgentDirectory } from '@agent-console/server/src/services/agent-directory';
import { TimerManager } from '@agent-console/server/src/services/timer-manager';
import { ConditionalWakeupManager } from '@agent-console/server/src/services/conditional-wakeup-manager';
import { InteractiveProcessManager } from '@agent-console/server/src/services/interactive-process-manager';
import { InterSessionMessageService } from '@agent-console/server/src/services/inter-session-message-service';
import { WorktreeService } from '@agent-console/server/src/services/worktree-service';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { createMcpApp } from '@agent-console/server/src/mcp/mcp-server';
import { createWorktreeWithSession } from '@agent-console/server/src/services/worktree-creation-service';
import { deleteWorktree } from '@agent-console/server/src/services/worktree-deletion-service';
import type { SuggestSessionMetadataFn } from '@agent-console/server/src/services/session-metadata-suggester';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';
import { createEmptyEmbeddedAgentSurface } from './test-utils';

const TEST_CONFIG_DIR = '/test/config-1696-boundary';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** The subset of `Subprocess` the service reads while a worker stays activated. */
interface FakeSubprocess {
  pid: number;
  exited: Promise<number>;
  stdin: FakeFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves -- this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess: FakeSubprocess = { pid: 9999, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    // One direct cast at the fake boundary (no `unknown` intermediate): the
    // typed fake models exactly the subset the service consumes -- the same
    // idiom as embedded-agent-identity-env-boundary.test.ts.
    const result: Pick<SpawnAsUserResult, 'elevated'> & { subprocess: FakeSubprocess; stdin: FakeFileSink } = {
      subprocess,
      stdin,
      elevated: false,
    };
    return result as SpawnAsUserResult;
  };
  return { fn, captured, stdinWrites };
}

// ---------- MCP HTTP helpers (mirrors embedded-agent-notification-boundary.test.ts) ----------

async function initializeMcp(app: Hono, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(
  app: Hono,
  mcpSessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
  extraHeaders?: Record<string, string>,
): Promise<{ result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
  };
}

function parseToolResult(response: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = response.result?.content?.[0]?.text;
  if (!text) return undefined;
  return JSON.parse(text);
}

describe(
  "Client-Server Boundary: send_session_message's fromSessionId self-identity resolution, via a real /mcp " +
    "call authenticated with an activated embedded-agent worker's own MCP token (Issue #1696)",
  () => {
    let sessionManager: SessionManager;
    let embeddedAgentManager: EmbeddedAgentManager;
    let userRepository: SqliteUserRepository;
    let jobQueue: JobQueue;
    let fake: ReturnType<typeof makeFakeSpawn>;
    let app: Hono;
    let mcpSessionId: string;
    let nextId: number;

    beforeEach(async () => {
      await closeDatabase();
      setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
      process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
      await initializeDatabase(':memory:');

      jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
      registerJobHandlers(jobQueue, new WorkerOutputFileManager());

      ptyFactory.reset();
      resetGitMocks();
      fake = makeFakeSpawn();

      const db = getDatabase();
      const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
      embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
      userRepository = new SqliteUserRepository(db);
      const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);
      const mcpTokenRegistry = new McpTokenRegistry();

      sessionManager = await SessionManager.create({
        userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
        pathExists: async () => true,
        sessionRepository,
        jobQueue,
        agentManager,
        embeddedAgentManager,
        annotationService: new AnnotationService(),
        mcpTokenRegistry,
        repositoryLookup: defaultRepositoryLookup,
        repositoryEnvLookup: defaultRepositoryEnvLookup,
        // Test seam: fake the loop subprocess (same rationale as
        // embedded-agent-notification-boundary.test.ts) so activation
        // doesn't spawn a real `bun` process.
        spawnAsUserFn: fake.fn,
      });

      const mcpApp = createMcpApp({
        sessionManager,
        repositoryManager: await RepositoryManager.create({ jobQueue }),
        agentManager,
        agentDirectory: new AgentDirectory({ terminal: agentManager, embedded: createEmptyEmbeddedAgentSurface() }),
        timerManager: new TimerManager(() => {}),
        conditionalWakeupManager: new ConditionalWakeupManager(() => {}),
        interactiveProcessManager: new InteractiveProcessManager(() => {}, () => {}),
        worktreeService: new WorktreeService({ db }),
        annotationService: new AnnotationService(),
        interSessionMessageService: new InterSessionMessageService(),
        suggestSessionMetadata: (async () =>
          ({ branch: 'feat/test', title: 'Test' })) as SuggestSessionMetadataFn,
        createWorktreeWithSession,
        deleteWorktree,
        userRepository,
        artifactRepository: new SqliteArtifactRepository(db),
        bookmarkRepository: new SqliteBookmarkRepository(db),
        broadcastToApp: () => {},
        findOpenPullRequest: async () => null,
        fetchPullRequestUrl: async () => null,
        // enforce mode makes the worker's-own-token assertions below
        // load-bearing (under 'warn'/'off' the call would succeed
        // regardless of the supplied fromSessionId).
        mcpAuthMode: 'enforce',
        mcpTokenRegistry,
      });

      app = new Hono();
      app.route('', mcpApp);

      const handshakeToken = mcpTokenRegistry.mint({
        sessionId: 'test-harness-handshake-session',
        workerId: 'test-harness-handshake-worker',
        userId: 'test-harness-handshake-user',
      });
      mcpSessionId = await initializeMcp(app, { Authorization: `Bearer ${handshakeToken}` });
      nextId = 100;
    });

    afterEach(async () => {
      await jobQueue.stop();
      await closeDatabase();
      cleanupMemfs();
    });

    /** A quick session with an agent worker, owned by `ownerId`. */
    async function createOwnedQuickSession(ownerId: string): Promise<{ sessionId: string; workerId: string }> {
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path' },
        { createdBy: ownerId },
      );
      const agentWorker = session.workers.find((w) => w.type === 'agent')!;
      return { sessionId: session.id, workerId: agentWorker.id };
    }

    function messagesDirFor(sessionId: string, workerId: string): string {
      return path.join(sessionManager.getPathResolverForSessionId(sessionId)!.getMessagesDir(), sessionId, workerId);
    }

    async function listMessageFiles(sessionId: string, workerId: string): Promise<string[]> {
      try {
        return await fsp.readdir(messagesDirFor(sessionId, workerId));
      } catch {
        return [];
      }
    }

    /** Activates a real embedded-agent worker and returns its own activation-minted MCP token. */
    async function activateEmbeddedWorker(ownerId: string): Promise<{ sessionId: string; ownToken: string }> {
      const definition = await embeddedAgentManager.createEmbeddedAgent(
        { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
        ownerId,
      );
      const session = await sessionManager.createSession(
        { type: 'quick', locationPath: '/test/embedded-path' },
        { createdBy: ownerId },
      );
      const worker = await sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: definition.id,
      });
      expect(worker).not.toBeNull();

      await sessionManager.activateEmbeddedAgentWorker(session.id, worker!.id);
      expect(fake.captured.length).toBe(1);

      // The worker's own minted MCP token is delivered via the init
      // command's `mcp.token` field -- the same field the real subprocess
      // reads from its stdin to authenticate its OWN outbound MCP calls.
      const initCommand = JSON.parse(fake.stdinWrites[0]) as { mcp: { token: string } };
      expect(initCommand.mcp.token).toBeTruthy();

      return { sessionId: session.id, ownToken: initCommand.mcp.token };
    }

    it(
      "(1) send_session_message with content and NO fromSessionId, bearer = the worker's own token -> " +
        'succeeds, and the on-disk message file is named `<ts>-<embeddedWorkerSessionId>-<hex>.json` with the ' +
        'sent text as its content',
      async () => {
        const owner = await userRepository.upsertByOsUid(11001, 'boundary-owner', '/home/boundary-owner');
        const { sessionId: embeddedSessionId, ownToken } = await activateEmbeddedWorker(owner.id);
        const target = await createOwnedQuickSession(owner.id);

        const response = await callTool(
          app,
          mcpSessionId,
          'send_session_message',
          { toSessionId: target.sessionId, content: 'boundary-test message body' },
          nextId++,
          { Authorization: `Bearer ${ownToken}` },
        );

        expect(response.result?.isError).toBeUndefined();
        const data = parseToolResult(response) as { path: string };
        expect(data.path).toContain(embeddedSessionId);

        const files = await listMessageFiles(target.sessionId, target.workerId);
        const written = files.find((f) => f.includes(`-${embeddedSessionId}-`));
        expect(written).toBeDefined();

        const content = await fsp.readFile(path.join(messagesDirFor(target.sessionId, target.workerId), written!), 'utf-8');
        expect(content).toBe('boundary-test message body');
      },
    );

    it(
      '(2) the same call with fromSessionId = a THIRD session owned by the SAME user -> refused with ' +
        "resolveSelfIdentity's self-identity mismatch, and NO new file lands in the target's messages dir",
      async () => {
        const owner = await userRepository.upsertByOsUid(11002, 'boundary-owner-mismatch', '/home/boundary-owner-mismatch');
        const { sessionId: embeddedSessionId, ownToken } = await activateEmbeddedWorker(owner.id);
        const target = await createOwnedQuickSession(owner.id);
        // A THIRD session, owned by the same user as the embedded worker,
        // but NOT the token's own session -- the case that distinguishes
        // resolveSelfIdentity's own-session check from ownership-alone
        // reasoning (checkCallerOwnsSession would happily accept it, since
        // the owner is the same).
        const thirdParty = await createOwnedQuickSession(owner.id);

        const response = await callTool(
          app,
          mcpSessionId,
          'send_session_message',
          { toSessionId: target.sessionId, content: 'should never be written', fromSessionId: thirdParty.sessionId },
          nextId++,
          { Authorization: `Bearer ${ownToken}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('can only act as your own session');
        expect(data.error).toContain(embeddedSessionId);
        expect(data.error).toContain(thirdParty.sessionId);

        expect(await listMessageFiles(target.sessionId, target.workerId)).toEqual([]);
      },
    );

    it(
      '(3) negative control: the identical call with no Authorization header is rejected at the transport gate ' +
        '(401), before send_session_message -- or resolveSelfIdentity -- is ever reached',
      async () => {
        const owner = await userRepository.upsertByOsUid(11003, 'boundary-owner-noauth', '/home/boundary-owner-noauth');
        const target = await createOwnedQuickSession(owner.id);

        // A raw `app.request` call (not the `callTool` helper, which
        // asserts HTTP 200 -- a transport-level rejection is not that).
        const res = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Session-Id': mcpSessionId,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'send_session_message',
              arguments: { toSessionId: target.sessionId, content: 'no auth header' },
            },
            id: nextId++,
          }),
        });

        expect(res.status).toBe(401);
        expect(await listMessageFiles(target.sessionId, target.workerId)).toEqual([]);
      },
    );
  },
);
