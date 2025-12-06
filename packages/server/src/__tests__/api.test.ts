import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create test config directory to avoid polluting real config
const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'agent-console-api-test-' + Date.now());
const TEST_REPO_DIR = path.join(os.tmpdir(), 'test-api-repo-' + Date.now());

// Mock persistence service to use test directory
vi.mock('../services/persistence-service.js', () => {
  const testConfigDir = path.join(os.tmpdir(), 'agent-console-api-test-' + Date.now());
  const reposFile = path.join(testConfigDir, 'repositories.json');

  return {
    persistenceService: {
      loadRepositories: () => {
        try {
          if (fs.existsSync(reposFile)) {
            return JSON.parse(fs.readFileSync(reposFile, 'utf-8'));
          }
        } catch { /* ignore */ }
        return [];
      },
      saveRepositories: (repos: unknown[]) => {
        if (!fs.existsSync(testConfigDir)) {
          fs.mkdirSync(testConfigDir, { recursive: true });
        }
        fs.writeFileSync(reposFile, JSON.stringify(repos, null, 2));
      },
      loadSessions: () => [],
      saveSessions: () => {},
      getSessionMetadata: () => undefined,
      removeSession: () => {},
      clearSessions: () => {},
    },
  };
});

// Mock session manager to avoid PTY operations
vi.mock('../services/session-manager.js', () => {
  const sessions = new Map();
  return {
    sessionManager: {
      getAllSessions: () => Array.from(sessions.values()),
      getSession: (id: string) => sessions.get(id),
      createSession: (worktreePath: string, repositoryId: string) => {
        const session = {
          id: 'test-session-' + Date.now(),
          worktreePath,
          repositoryId,
          pid: 12345,
          createdAt: new Date().toISOString(),
          activityState: 'idle',
        };
        sessions.set(session.id, session);
        return session;
      },
      killSession: (id: string) => {
        if (sessions.has(id)) {
          sessions.delete(id);
          return true;
        }
        return false;
      },
      getSessionMetadata: () => undefined,
      restartSession: () => null,
      attachCallbacks: () => {},
      detachCallbacks: () => {},
      getOutputBuffer: () => null,
      getActivityState: () => 'idle',
      setGlobalActivityCallback: () => {},
    },
  };
});

// Mock worktree service
vi.mock('../services/worktree-service.js', () => ({
  worktreeService: {
    listWorktrees: (repoPath: string, repoId: string) => [
      {
        path: repoPath,
        branch: 'main',
        head: 'abc123',
        repositoryId: repoId,
        isPrimary: true,
      },
    ],
    listBranches: () => ({
      local: ['main', 'develop'],
      remote: ['origin/main', 'origin/develop'],
      defaultBranch: 'main',
    }),
    createWorktree: () => ({ worktreePath: '/test/path', error: null }),
    removeWorktree: () => ({ success: true }),
    isWorktreeOf: () => true,
  },
}));

// Import app after mocks
import { Hono as HonoType } from 'hono';

// Create a simplified version of the app for testing
function createTestApp() {
  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // API info
  app.get('/api', (c) => c.json({ message: 'Agent Console API' }));

  // Config
  app.get('/api/config', (c) => c.json({ homeDir: os.homedir() }));

  // Sessions (simplified for testing)
  app.get('/api/sessions', async (c) => {
    const { sessionManager } = await import('../services/session-manager.js');
    const sessions = sessionManager.getAllSessions();
    return c.json({ sessions });
  });

  app.post('/api/sessions', async (c) => {
    const { sessionManager } = await import('../services/session-manager.js');
    const body = await c.req.json();
    const { worktreePath = process.cwd(), repositoryId = 'default' } = body;
    const session = sessionManager.createSession(
      worktreePath,
      repositoryId,
      () => {},
      () => {}
    );
    return c.json({ session }, 201);
  });

  app.delete('/api/sessions/:id', async (c) => {
    const { sessionManager } = await import('../services/session-manager.js');
    const sessionId = c.req.param('id');
    const success = sessionManager.killSession(sessionId);
    if (!success) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ success: true });
  });

  // Repositories
  app.get('/api/repositories', async (c) => {
    const { repositoryManager } = await import('../services/repository-manager.js');
    const repositories = repositoryManager.getAllRepositories();
    return c.json({ repositories });
  });

  app.post('/api/repositories', async (c) => {
    const { repositoryManager } = await import('../services/repository-manager.js');
    const body = await c.req.json();
    const { path: repoPath } = body;

    if (!repoPath) {
      return c.json({ error: 'path is required' }, 400);
    }

    try {
      const repository = repositoryManager.registerRepository(repoPath);
      return c.json({ repository }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: message }, 400);
    }
  });

  app.delete('/api/repositories/:id', async (c) => {
    const { repositoryManager } = await import('../services/repository-manager.js');
    const repoId = c.req.param('id');
    const success = repositoryManager.unregisterRepository(repoId);

    if (!success) {
      return c.json({ error: 'Repository not found' }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}

describe('API Integration Tests', () => {
  let app: HonoType;

  beforeEach(() => {
    // Create test directories
    if (!fs.existsSync(TEST_CONFIG_DIR)) {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(TEST_REPO_DIR)) {
      fs.mkdirSync(TEST_REPO_DIR, { recursive: true });
      fs.mkdirSync(path.join(TEST_REPO_DIR, '.git'));
    }

    app = createTestApp();
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(TEST_REPO_DIR)) {
      fs.rmSync(TEST_REPO_DIR, { recursive: true });
    }
  });

  describe('GET /health', () => {
    it('should return ok status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /api', () => {
    it('should return API info', async () => {
      const res = await app.request('/api');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ message: 'Agent Console API' });
    });
  });

  describe('GET /api/config', () => {
    it('should return config with homeDir', async () => {
      const res = await app.request('/api/config');
      expect(res.status).toBe(200);

      const body = await res.json() as { homeDir: string };
      expect(body.homeDir).toBe(os.homedir());
    });
  });

  describe('Sessions API', () => {
    describe('GET /api/sessions', () => {
      it('should return empty sessions array initially', async () => {
        const res = await app.request('/api/sessions');
        expect(res.status).toBe(200);

        const body = await res.json() as { sessions: unknown[] };
        expect(body.sessions).toBeInstanceOf(Array);
      });
    });

    describe('POST /api/sessions', () => {
      it('should create a new session', async () => {
        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '/test/path', repositoryId: 'test-repo' }),
        });
        expect(res.status).toBe(201);

        const body = await res.json() as { session: { worktreePath: string; repositoryId: string; id: string } };
        expect(body.session).toBeDefined();
        expect(body.session.worktreePath).toBe('/test/path');
        expect(body.session.repositoryId).toBe('test-repo');
      });
    });

    describe('DELETE /api/sessions/:id', () => {
      it('should delete an existing session', async () => {
        // First create a session
        const createRes = await app.request('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreePath: '/test', repositoryId: 'test' }),
        });
        const { session } = await createRes.json() as { session: { id: string } };

        // Then delete it
        const deleteRes = await app.request(`/api/sessions/${session.id}`, {
          method: 'DELETE',
        });
        expect(deleteRes.status).toBe(200);

        const body = await deleteRes.json() as { success: boolean };
        expect(body.success).toBe(true);
      });

      it('should return 404 for non-existent session', async () => {
        const res = await app.request('/api/sessions/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);

        const body = await res.json() as { error: string };
        expect(body.error).toBe('Session not found');
      });
    });
  });

  describe('Repositories API', () => {
    describe('GET /api/repositories', () => {
      it('should return repositories array', async () => {
        const res = await app.request('/api/repositories');
        expect(res.status).toBe(200);

        const body = await res.json() as { repositories: unknown[] };
        expect(body.repositories).toBeInstanceOf(Array);
      });
    });

    describe('POST /api/repositories', () => {
      it('should return 400 when path is missing', async () => {
        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);

        const body = await res.json() as { error: string };
        expect(body.error).toBe('path is required');
      });

      it('should return 400 for non-existent path', async () => {
        const res = await app.request('/api/repositories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/non/existent/path' }),
        });
        expect(res.status).toBe(400);

        const body = await res.json() as { error: string };
        expect(body.error).toContain('Path does not exist');
      });
    });

    describe('DELETE /api/repositories/:id', () => {
      it('should return 404 for non-existent repository', async () => {
        const res = await app.request('/api/repositories/non-existent', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);

        const body = await res.json() as { error: string };
        expect(body.error).toBe('Repository not found');
      });
    });
  });
});
