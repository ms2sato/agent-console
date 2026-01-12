/**
 * Tests for worker history file initialization on worker creation.
 *
 * Problem: When a new worker is created and a WebSocket immediately connects,
 * the history file does not exist yet, causing history retrieval to fail.
 *
 * Expected behavior after fix:
 * - Worker creation should create an empty history file immediately
 * - WebSocket connection should successfully retrieve history (even if empty)
 * - No error messages should be sent to the client
 *
 * These tests are written to FAIL with the current implementation,
 * following TDD methodology.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { CreateSessionRequest } from '@agent-console/shared';
import { createMockPtyFactory } from '../../__tests__/utils/mock-pty.js';
import { setupMemfs, cleanupMemfs } from '../../__tests__/utils/mock-fs-helper.js';
import { mockProcess, resetProcessMock } from '../../__tests__/utils/mock-process-helper.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { JobQueue } from '../../jobs/index.js';
import { AgentManager, resetAgentManager, setAgentManager } from '../agent-manager.js';
import { SqliteAgentRepository } from '../../repositories/sqlite-agent-repository.js';

// Test config directory
const TEST_CONFIG_DIR = '/test/config';

// Test JobQueue instance (created fresh for each test)
let testJobQueue: JobQueue | null = null;

// Create mock PTY factory (will be reset in beforeEach)
const ptyFactory = createMockPtyFactory(10000);

let importCounter = 0;
let db: Kysely<Database>;

describe('Worker History File Initialization', () => {
  beforeEach(async () => {
    // Setup memfs with config directory structure
    setupMemfs({
      [`${TEST_CONFIG_DIR}/.keep`]: '',
    });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;

    db = await createDatabaseForTest();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    setAgentManager(agentManager);

    // Create a test JobQueue with the shared database connection
    testJobQueue = new JobQueue(db);

    // Reset process mock and mark current process as alive
    // This ensures sessions created with serverPid=process.pid are not cleaned up
    resetProcessMock();
    mockProcess.markAlive(process.pid);

    // Reset PTY factory
    ptyFactory.reset();
  });

  afterEach(async () => {
    // Clean up test JobQueue
    if (testJobQueue) {
      await testJobQueue.stop();
      testJobQueue = null;
    }
    resetAgentManager();
    await db.destroy();
    cleanupMemfs();
  });

  // Mock pathExists that always returns true (test paths don't exist on real filesystem)
  const mockPathExists = async (_path: string): Promise<boolean> => true;

  // Helper to get fresh module instance with DI using the factory pattern
  async function getSessionManager() {
    const module = await import(`../session-manager.js?v=${++importCounter}`);
    // Use the factory pattern for async initialization with jobQueue
    return module.SessionManager.create({
      ptyProvider: ptyFactory.provider,
      pathExists: mockPathExists,
      jobQueue: testJobQueue,
    });
  }

  describe('history file creation on worker creation', () => {
    it('should create empty history file immediately when creating an agent worker', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // Immediately after creation, history should be available
      // (not null, and not an error)
      const history = await manager.getWorkerOutputHistory(
        session.id,
        agentWorker!.id,
        0,
        5000 // maxLines - simulating initial WebSocket connection
      );

      // The history should be a valid result, not null
      expect(history).not.toBeNull();

      // The data should be empty (no output yet)
      expect(history!.data).toBe('');

      // The offset should be 0 (file is empty)
      expect(history!.offset).toBe(0);
    });

    it('should create empty history file immediately when creating a terminal worker', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);

      // Create a terminal worker
      const terminalWorker = await manager.createWorker(session.id, {
        type: 'terminal',
        name: 'Shell',
      });
      expect(terminalWorker).not.toBeNull();

      // Immediately after creation, history should be available
      const history = await manager.getWorkerOutputHistory(
        session.id,
        terminalWorker!.id,
        0,
        5000
      );

      // The history should be a valid result, not null
      expect(history).not.toBeNull();

      // The data should be empty
      expect(history!.data).toBe('');

      // The offset should be 0
      expect(history!.offset).toBe(0);
    });

    it('should have history file exist on disk immediately after worker creation', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // The history file should exist on disk immediately
      // Check both compressed and uncompressed paths
      const outputsDir = `${TEST_CONFIG_DIR}/outputs/${session.id}`;
      const uncompressedPath = `${outputsDir}/${agentWorker!.id}.log`;
      const compressedPath = `${outputsDir}/${agentWorker!.id}.log.gz`;

      // At least one of these files should exist
      const fileExists =
        fs.existsSync(uncompressedPath) || fs.existsSync(compressedPath);

      expect(fileExists).toBe(true);
    });
  });

  describe('WebSocket connection immediately after worker creation', () => {
    it('should not return null from getWorkerOutputHistory for newly created worker', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // Simulate what WebSocket routes.ts does on connection:
      // It calls getWorkerOutputHistory with maxLines parameter

      // This simulates the first WebSocket connection immediately after session creation
      const historyResult = await manager.getWorkerOutputHistory(
        session.id,
        agentWorker!.id,
        0, // fromOffset
        5000 // maxLines (WORKER_OUTPUT_INITIAL_HISTORY_LINES)
      );

      // This MUST NOT be null - null triggers fallback to in-memory buffer
      // and potentially error messages to the client
      expect(historyResult).not.toBeNull();
    });

    it('should return empty history with offset 0 for newly created worker without output', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // Before any PTY output, history should be empty but valid
      const historyResult = await manager.getWorkerOutputHistory(
        session.id,
        agentWorker!.id,
        0,
        5000
      );

      expect(historyResult).not.toBeNull();
      expect(historyResult!.data).toBe('');
      expect(historyResult!.offset).toBe(0);
    });

    it('should allow subsequent output to append to the initialized history file', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // First, verify empty history is available
      const initialHistory = await manager.getWorkerOutputHistory(
        session.id,
        agentWorker!.id,
        0,
        5000
      );
      expect(initialHistory).not.toBeNull();
      expect(initialHistory!.data).toBe('');

      // Now simulate PTY output
      const pty = ptyFactory.instances[0];
      pty.simulateData('Hello, World!\n');

      // Wait for buffer flush (the worker-output-file uses 100ms flush interval in tests)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Get history again
      const afterOutput = await manager.getWorkerOutputHistory(
        session.id,
        agentWorker!.id,
        0,
        5000
      );

      expect(afterOutput).not.toBeNull();
      expect(afterOutput!.data).toContain('Hello, World!');
      expect(afterOutput!.offset).toBeGreaterThan(0);
    });
  });

  describe('getCurrentOutputOffset on newly created worker', () => {
    it('should return 0 for newly created worker without any output', async () => {
      const manager = await getSessionManager();

      const request: CreateSessionRequest = {
        type: 'quick',
        locationPath: '/test/path',
        agentId: 'claude-code',
      };

      const session = await manager.createSession(request);
      const agentWorker = session.workers.find((w: { type: string }) => w.type === 'agent');
      expect(agentWorker).toBeDefined();

      // The offset should be 0 (file exists but is empty)
      const offset = await manager.getCurrentOutputOffset(session.id, agentWorker!.id);
      expect(offset).toBe(0);
    });
  });
});
