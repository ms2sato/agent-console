/**
 * `create_html_artifact` MCP tool tests (Issue #1312, HTML Artifacts phase 1).
 *
 * Drives the REAL `createMcpApp` `create_html_artifact` handler chain via
 * `callTool` (real MCP JSON-RPC transport, mirrors
 * `delegate-embedded-agent-activation.test.ts`'s pattern), backed by a real
 * `SqliteArtifactRepository` against an in-memory DB.
 *
 * Deliberately sets `AGENT_CONSOLE_HOME` to a REAL directory under
 * `os.tmpdir()`, not a memfs-only path: `SqliteArtifactRepository` writes
 * artifact bytes via `lib/artifact-storage.ts`'s `Bun.write` / `Bun.file`,
 * which bypass the process-global `mock.module('fs/promises')`
 * interception other test files install (`.claude/rules/testing.md`
 * Anti-Pattern #2; see the parallel note in
 * `lib/__tests__/artifact-storage.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import { resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import { initializeDatabase, closeDatabase, getDatabase } from '../../database/connection.js';
import { JobQueue } from '../../jobs/job-queue.js';
import { registerJobHandlers } from '../../jobs/handlers.js';
import { WorkerOutputFileManager } from '../../lib/worker-output-file.js';
import { SessionManager } from '../../services/session-manager.js';
import { RepositoryManager } from '../../services/repository-manager.js';
import { AgentManager } from '../../services/agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';
import { JsonSessionRepository } from '../../repositories/index.js';
import { SqliteRepositoryRepository } from '../../repositories/sqlite-repository-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { WorktreeService } from '../../services/worktree-service.js';
import { TimerManager } from '../../services/timer-manager.js';
import { ConditionalWakeupManager } from '../../services/conditional-wakeup-manager.js';
import { InteractiveProcessManager } from '../../services/interactive-process-manager.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { InterSessionMessageService } from '../../services/inter-session-message-service.js';
import { SingleUserMode } from '../../services/user-mode.js';
import { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import { SqliteEmbeddedAgentRepository } from '../../repositories/sqlite-embedded-agent-repository.js';
import { createMcpApp, resolveArtifactTitle, buildArtifactToolResult } from '../mcp-server.js';
import { McpTokenRegistry, type McpAuthMode } from '../mcp-auth.js';
import { AgentDirectory } from '../../services/agent-directory.js';
import { createWorktreeWithSession } from '../../services/worktree-creation-service.js';
import { deleteWorktree } from '../../services/worktree-deletion-service.js';
import { initializeMcp, callTool, parseToolResult } from './mcp-protocol-test-helpers.js';

const TEST_CONFIG_DIR_PREFIX = 'agent-console-create-html-artifact-test-';
const TEST_REPO_PATH = '/test/repo-1312';
const TEST_REPO_ID = 'repo-1312';

describe('create_html_artifact', () => {
  const ptyFactory = createMockPtyFactory();
  let app: Hono;
  let sessionManager: SessionManager;
  let repositoryManager: RepositoryManager;
  let agentManager: AgentManager;
  let userRepository: SqliteUserRepository;
  let artifactRepository: SqliteArtifactRepository;
  let testJobQueue: JobQueue;
  let mcpSessionId: string;
  let nextId: number;
  let worktreeService: WorktreeService;
  let agentDirectory: AgentDirectory;

  /**
   * (Re)create the MCP app and initialize a new MCP session, optionally
   * with a specific auth mode + token registry. Mirrors
   * `mcp-server.test.ts`'s `remountMcpApp` pattern: under `enforce`, the
   * handshake itself needs a bearer token to pass the transport-level gate,
   * unrelated to the per-test tool-call token scenario below.
   */
  async function mountMcpApp(authOpts?: { mcpAuthMode?: McpAuthMode; mcpTokenRegistry?: McpTokenRegistry }): Promise<void> {
    const mcpApp = createMcpApp({
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
      broadcastToApp: () => {},
      findOpenPullRequest: async () => null,
      fetchPullRequestUrl: async () => null,
      mcpAuthMode: authOpts?.mcpAuthMode,
      mcpTokenRegistry: authOpts?.mcpTokenRegistry,
    });
    app = new Hono();
    app.route('', mcpApp);

    let initializeHeaders: Record<string, string> | undefined;
    if (authOpts?.mcpAuthMode === 'enforce' && authOpts.mcpTokenRegistry) {
      const handshakeToken = authOpts.mcpTokenRegistry.mint({
        sessionId: 'test-harness-handshake-session',
        workerId: 'test-harness-handshake-worker',
        userId: 'test-harness-handshake-user',
      });
      initializeHeaders = { Authorization: `Bearer ${handshakeToken}` };
    }

    mcpSessionId = await initializeMcp(app, initializeHeaders);
  }

  beforeEach(async () => {
    await closeDatabase();
    // Real disk for AGENT_CONSOLE_HOME (see file header): SqliteArtifactRepository's
    // writes bypass the memfs mock the session/repository JSON stores below rely on.
    const testConfigDir = path.join(os.tmpdir(), `${TEST_CONFIG_DIR_PREFIX}${randomUUID()}`);
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
    process.env.AGENT_CONSOLE_HOME = testConfigDir;

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

    const sessionRepository = new JsonSessionRepository(`${process.env.AGENT_CONSOLE_HOME}/sessions.json`);
    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue: testJobQueue,
      agentManager,
      embeddedAgentManager,
      mcpTokenRegistry: new McpTokenRegistry(),
      annotationService: new AnnotationService(),
      userRepository,
      repositoryLookup: { getRepositorySlug: (id: string) => repositoryManager?.getRepositorySlug(id) },
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
      clonedSourceRepoPath: null,
    });
    repositoryManager = await RepositoryManager.create({ repository: sqliteRepoRepo, jobQueue: testJobQueue });

    worktreeService = new WorktreeService({ db });
    agentDirectory = new AgentDirectory({ terminal: agentManager, embedded: embeddedAgentManager });

    await mountMcpApp();
    nextId = 10;
  });

  afterEach(async () => {
    await testJobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  async function createOwnedSession(
    osUid: number = 6001,
    username: string = 'artifact-owner',
  ): Promise<{ sessionId: string; userId: string; workerId: string }> {
    const owner = await userRepository.upsertByOsUid(osUid, username, `/home/${username}`);
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH },
      { createdBy: owner.id },
    );
    return { sessionId: session.id, userId: owner.id, workerId: session.workers[0].id };
  }

  // ---------- Boundary: 5 MiB cap (measured on raw byte length) ----------

  describe('size cap (5 MiB, measured on raw content byte length)', () => {
    it('accepts content exactly at the 5 MiB cap', async () => {
      const { sessionId } = await createOwnedSession();
      const fiveMib = 5 * 1024 * 1024;
      const content = 'a'.repeat(fiveMib);
      expect(Buffer.byteLength(content, 'utf-8')).toBe(fiveMib);

      const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content, sessionId }, nextId++);

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { artifactId: string };
      expect(data.artifactId).toBeDefined();
    });

    it('rejects content one byte over the 5 MiB cap, with the size in the error message', async () => {
      const { sessionId } = await createOwnedSession();
      const fiveMibPlusOne = 5 * 1024 * 1024 + 1;
      const content = 'a'.repeat(fiveMibPlusOne);

      const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content, sessionId }, nextId++);

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain(String(fiveMibPlusOne));
      expect(data.error).toContain('5 MiB');
    });

    it('rejects empty content', async () => {
      const { sessionId } = await createOwnedSession();

      const response = await callTool(app, mcpSessionId, 'create_html_artifact', { content: '', sessionId }, nextId++);

      if (response.error) {
        expect(response.error).toBeDefined();
      } else {
        expect(response.result?.isError).toBe(true);
      }
    });
  });

  // ---------- Attribution: session.createdBy, never getMcpCallerIdentity() ----------

  describe('attribution', () => {
    it('attributes the artifact to the calling session\'s createdBy', async () => {
      const { sessionId, userId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html><body>hi</body></html>', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { artifactId: string };

      const owned = await artifactRepository.findByUserId(userId);
      expect(owned.map((a) => a.id)).toContain(data.artifactId);
    });

    it('rejects with a loud, #1293-consistent error when the session has no createdBy (ownerless/legacy session)', async () => {
      const session = await sessionManager.createSession({ type: 'quick', locationPath: TEST_REPO_PATH });

      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html></html>', sessionId: session.id },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('has no createdBy');
      expect(data.error).toContain('ownerless');
    });

    it('rejects with a not-found error for an unknown sessionId', async () => {
      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html></html>', sessionId: 'does-not-exist' },
        nextId++,
      );

      expect(response.result?.isError).toBe(true);
      const data = parseToolResult(response) as { error: string };
      expect(data.error).toContain('does-not-exist');
    });
  });

  // ---------- Authorization: checkCallerOwnsSession (session-claiming, sixth tool) ----------
  //
  // Session resolution / ownerless-session checks are covered above under
  // "attribution" (they run before the authz check in the tool's
  // resolution order and are unaffected by it). This block covers the
  // authz gate itself: it must run, and it must run AFTER session lookup /
  // ownerless check but BEFORE artifact creation.

  describe('authorization (checkCallerOwnsSession)', () => {
    it(
      'enforce mode: a caller whose verified identity belongs to a DIFFERENT session is rejected when claiming ' +
        'another user\'s sessionId (impersonation), and no artifact is created',
      async () => {
        const registry = new McpTokenRegistry();
        await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

        // Session A: the caller's OWN session/identity, minted into the bearer token.
        const { sessionId: sessionAId, userId: userAId, workerId: workerAId } = await createOwnedSession(6001, 'artifact-owner-a');
        // Session B: a DIFFERENT user's session -- the impersonation target.
        const { sessionId: sessionBId, userId: userBId } = await createOwnedSession(6002, 'artifact-owner-b');
        expect(userAId).not.toBe(userBId);

        const token = registry.mint({ sessionId: sessionAId, workerId: workerAId, userId: userAId });

        const response = await callTool(
          app,
          mcpSessionId,
          'create_html_artifact',
          { content: '<html><body>impersonation attempt</body></html>', sessionId: sessionBId },
          nextId++,
          { Authorization: `Bearer ${token}` },
        );

        expect(response.result?.isError).toBe(true);
        const data = parseToolResult(response) as { error: string };
        expect(data.error).toContain('identity mismatch');
        expect(data.error).toContain(sessionBId);

        // No artifact was created for either user -- the authz gate ran
        // BEFORE artifactRepository.create, not merely returned an error
        // result while the write already happened.
        expect(await artifactRepository.findByUserId(userAId)).toHaveLength(0);
        expect(await artifactRepository.findByUserId(userBId)).toHaveLength(0);
      },
    );

    it('enforce mode: a caller claiming their OWN session succeeds', async () => {
      const registry = new McpTokenRegistry();
      await mountMcpApp({ mcpAuthMode: 'enforce', mcpTokenRegistry: registry });

      const { sessionId, userId, workerId } = await createOwnedSession();
      const token = registry.mint({ sessionId, workerId, userId });

      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html><body>self-claim</body></html>', sessionId },
        nextId++,
        { Authorization: `Bearer ${token}` },
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { artifactId: string };
      const owned = await artifactRepository.findByUserId(userId);
      expect(owned.map((a) => a.id)).toContain(data.artifactId);
    });

    it('warn/off mode (default test harness, no caller identity presented): self-claim still succeeds unaffected', async () => {
      const { sessionId, userId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html><body>no-token</body></html>', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { artifactId: string };
      const owned = await artifactRepository.findByUserId(userId);
      expect(owned.map((a) => a.id)).toContain(data.artifactId);
    });
  });

  // ---------- URL / note (PUBLIC_ORIGIN unconfigured, the default test env) ----------

  describe('result shape when AGENT_CONSOLE_PUBLIC_ORIGIN is unconfigured (default test environment)', () => {
    it('returns a relative path and a note, with no url field', async () => {
      const { sessionId } = await createOwnedSession();

      const response = await callTool(
        app,
        mcpSessionId,
        'create_html_artifact',
        { content: '<html></html>', sessionId },
        nextId++,
      );

      expect(response.result?.isError).toBeUndefined();
      const data = parseToolResult(response) as { artifactId: string; path: string; url?: string; note?: string };
      expect(data.path).toBe(`/artifacts/${data.artifactId}`);
      expect(data.url).toBeUndefined();
      expect(data.note).toBeDefined();
      expect(data.note).toContain('AGENT_CONSOLE_PUBLIC_ORIGIN');
    });
  });
});

// ---------- Pure-function unit tests (not module-singleton-coupled) ----------

describe('resolveArtifactTitle (title resolution chain)', () => {
  it('uses the explicit title param when given, even if the document has a <title>', () => {
    const content = '<html><head><title>Doc Title</title></head></html>';
    expect(resolveArtifactTitle(content, 'Explicit Title')).toBe('Explicit Title');
  });

  it('falls back to the document <title> when no param is given', () => {
    const content = '<html><head><title>  Doc   Title  </title></head></html>';
    expect(resolveArtifactTitle(content, undefined)).toBe('Doc Title');
  });

  it('falls back to the first heading when there is no <title>', () => {
    const content = '<html><body><h1>First Heading</h1><h2>Second</h2></body></html>';
    expect(resolveArtifactTitle(content, undefined)).toBe('First Heading');
  });

  it('falls back to the literal "Untitled" when there is neither a <title> nor a heading', () => {
    const content = '<html><body><p>Just a paragraph</p></body></html>';
    expect(resolveArtifactTitle(content, undefined)).toBe('Untitled');
  });

  it('treats a whitespace-only title param as absent (falls through the chain)', () => {
    const content = '<html><head><title>Doc Title</title></head></html>';
    expect(resolveArtifactTitle(content, '   ')).toBe('Doc Title');
  });

  it('treats an empty <title> tag as absent (falls through to heading)', () => {
    const content = '<html><head><title></title></head><body><h2>Heading</h2></body></html>';
    expect(resolveArtifactTitle(content, undefined)).toBe('Heading');
  });

  // Regression coverage for CodeQL js/incomplete-multi-character-sanitization
  // (single-pass tag stripping). NOTE: for the generic `/<[^>]*>/g` pattern
  // used here, a single pass and the fixed-point loop are provably
  // equivalent -- each `<` is matched all the way to the *next* `>` in the
  // string regardless of what lies between them, so no leftover fragment can
  // recombine into a new tag after one pass. This case therefore does not
  // polarity-flip against the pre-fix single-pass implementation; it pins
  // the fixed-point loop's output for an adversarial nested-tag input as
  // defense-in-depth documentation, not as a bypass proof.
  it('fully strips a nested/overlapping tag construction from an extracted <title> fragment', () => {
    const content = '<html><head><title><scr<script>ipt>evil</title></head></html>';
    const resolved = resolveArtifactTitle(content, undefined);
    expect(resolved).not.toContain('<');
  });

  // CodeQL js/incomplete-multi-character-sanitization vector: asserts the
  // safety PROPERTY (no `<` survives in the final resolved title) holds for
  // the classic nested-construction payload, covering both the <title>
  // extraction rung and the explicit `title` param rung (the gap this round
  // closes -- previously the param path bypassed stripping entirely).
  it('resolves a <title> containing the CodeQL nested-tag vector with no "<" in the output', () => {
    const content = '<html><head><title><<script>script>evil</title></head></html>';
    const resolved = resolveArtifactTitle(content, undefined);
    expect(resolved).not.toContain('<');
  });

  it('strips markup from an explicit title param instead of passing it through raw', () => {
    const content = '<html><head><title>Doc Title</title></head></html>';
    const resolved = resolveArtifactTitle(content, '<<script>script>evil');
    expect(resolved).not.toContain('<');
  });

  it('stability: a clean plain-text title passes through unchanged (modulo whitespace collapse)', () => {
    const content = '<html><head><title>Already Plain Text</title></head></html>';
    expect(resolveArtifactTitle(content, undefined)).toBe('Already Plain Text');
    expect(resolveArtifactTitle(content, 'Explicit Plain Text')).toBe('Explicit Plain Text');
  });

  describe('length cap (MAX_TITLE_LENGTH = 200 characters)', () => {
    it('leaves a title exactly at the 200-character cap unchanged', () => {
      const exactlyAtCap = 'a'.repeat(200);
      const content = `<html><head><title>${exactlyAtCap}</title></head></html>`;
      const resolved = resolveArtifactTitle(content, undefined);
      expect(resolved).toBe(exactlyAtCap);
      expect(resolved.length).toBe(200);
    });

    it('truncates a title one character over the 200-character cap', () => {
      const oneOverCap = 'a'.repeat(201);
      const content = `<html><head><title>${oneOverCap}</title></head></html>`;
      const resolved = resolveArtifactTitle(content, undefined);
      expect(resolved).toBe('a'.repeat(200));
      expect(resolved.length).toBe(200);
    });

    it('truncates an explicit title param one character over the cap', () => {
      const oneOverCap = 'b'.repeat(201);
      const resolved = resolveArtifactTitle('<html></html>', oneOverCap);
      expect(resolved).toBe('b'.repeat(200));
      expect(resolved.length).toBe(200);
    });
  });
});

describe('buildArtifactToolResult (§4.1 url/note shape)', () => {
  it('unconfigured origin: relative path plus a note, no url', () => {
    const result = buildArtifactToolResult('artifact-1', undefined);
    expect(result).toEqual({
      artifactId: 'artifact-1',
      path: '/artifacts/artifact-1',
      note: expect.stringContaining('AGENT_CONSOLE_PUBLIC_ORIGIN') as unknown as string,
    });
    expect(result.url).toBeUndefined();
  });

  it('configured origin: both relative path and absolute url, no note', () => {
    const result = buildArtifactToolResult('artifact-1', 'http://192.168.1.12:6340');
    expect(result).toEqual({
      artifactId: 'artifact-1',
      path: '/artifacts/artifact-1',
      url: 'http://192.168.1.12:6340/artifacts/artifact-1',
    });
    expect(result.note).toBeUndefined();
  });
});
