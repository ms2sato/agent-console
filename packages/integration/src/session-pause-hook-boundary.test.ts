/**
 * Client-Server Boundary Test: a repository's pause / resume command runs on
 * the real pause / resume routes and its result travels on the wire.
 *
 * Exercises the REAL chain:
 *
 *   real POST /api/sessions/:id/pause and /resume routes
 *     -> real SessionManager (pause / resume + the hook seam)
 *     -> real repository lookup (pauseCommand / resumeCommand read from the
 *        persisted repository row)
 *     -> real WorktreeService.executeHookCommand spawning a real `sh -c`
 *
 * Recorded proxies (pre-pr-completeness.md Q13): the PTY provider is the mock
 * one (an agent worker must not spawn a real agent), and the session's
 * worktree path is the machine's temp directory registered in the in-memory
 * filesystem as well, so the command has a real working directory while the
 * session's path checks pass. Single-user mode: no privilege elevation is
 * involved, which is this suite's declared scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as os from 'node:os';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import { CLAUDE_CODE_AGENT_ID } from '@agent-console/server/src/services/agent-manager';
import { PauseSessionResponseSchema, SessionResponseSchema } from '@agent-console/shared';

const TEST_REPO_PATH = '/test/repo-pause-hook';
// A directory that exists on the real disk (the command is really spawned in
// it) and is mirrored into the in-memory filesystem for the session's path checks.
const REAL_WORKTREE_DIR = os.tmpdir();

describe('Client-Server Boundary: pause / resume command on the session routes', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let repoId: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${REAL_WORKTREE_DIR}/.keep`]: '',
    });

    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    const repo = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    repoId = repo.id;

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function createSessionWithCommands(commands: {
    pauseCommand?: string;
    resumeCommand?: string;
  }): Promise<string> {
    await ctx.repositoryManager.updateRepository(repoId, commands);
    const session = await ctx.sessionManager.createSession({
      type: 'worktree',
      locationPath: REAL_WORKTREE_DIR,
      repositoryId: repoId,
      worktreeId: 'main',
      agentId: CLAUDE_CODE_AGENT_ID,
    });
    return session.id;
  }

  async function readPersisted(sessionId: string) {
    return ctx.sessionManager.getSessionRepository().findById(sessionId);
  }

  it('a succeeding pause command is spawned for real and its output is on the wire', async () => {
    const sessionId = await createSessionWithCommands({ pauseCommand: 'echo paused; exit 0' });

    const res = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = v.parse(PauseSessionResponseSchema, await res.json());
    expect(body.pauseCommandResult?.success).toBe(true);
    expect(body.pauseCommandResult?.output).toContain('paused');
    expect(ctx.sessionManager.getSession(sessionId)).toBeUndefined();
    expect((await readPersisted(sessionId))?.pausedAt).toBeDefined();
  });

  it('a failing pause command is reported in the body and the session is still paused', async () => {
    const sessionId = await createSessionWithCommands({ pauseCommand: 'exit 3' });

    const res = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = v.parse(PauseSessionResponseSchema, await res.json());
    expect(body.pauseCommandResult?.success).toBe(false);
    expect(body.pauseCommandResult?.error).toContain('code 3');
    expect(ctx.sessionManager.getSession(sessionId)).toBeUndefined();
    expect((await readPersisted(sessionId))?.pausedAt).toBeDefined();
  });

  it('the pause command sees the hook variables of the session', async () => {
    const sessionId = await createSessionWithCommands({
      pauseCommand: 'echo "$REPO|$WORKTREE_PATH"',
    });

    const res = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });

    const body = v.parse(PauseSessionResponseSchema, await res.json());
    expect(body.pauseCommandResult?.output).toContain(`repo-pause-hook|${REAL_WORKTREE_DIR}`);
  });

  it('a repository without a pause command pauses with no result key', async () => {
    const sessionId = await createSessionWithCommands({});

    const res = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('a succeeding resume command runs before the session is back and its output is on the wire', async () => {
    const sessionId = await createSessionWithCommands({ resumeCommand: 'echo back' });
    const pauseRes = await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);

    const res = await app.request(`/api/sessions/${sessionId}/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = v.parse(SessionResponseSchema, await res.json());
    expect(body.session.id).toBe(sessionId);
    expect(body.resumeCommandResult?.success).toBe(true);
    expect(body.resumeCommandResult?.output).toContain('back');
    expect(ctx.sessionManager.getSession(sessionId)).toBeDefined();
  });

  it('a failing resume command still resumes the session', async () => {
    const sessionId = await createSessionWithCommands({ resumeCommand: 'exit 4' });
    await app.request(`/api/sessions/${sessionId}/pause`, { method: 'POST' });

    const res = await app.request(`/api/sessions/${sessionId}/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = v.parse(SessionResponseSchema, await res.json());
    expect(body.resumeCommandResult?.success).toBe(false);
    expect(body.resumeCommandResult?.error).toContain('code 4');
    expect(ctx.sessionManager.getSession(sessionId)).toBeDefined();
  });
});
