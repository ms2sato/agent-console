/**
 * Client-Server Boundary Test: the client functions that parse their response
 * through a strict wire schema (#1367 pass 1 to pass 6; a few functions are pinned
 * in sibling files, see below).
 *
 * Pass 1: `fetchRepository`, `fetchWorkers`, `fetchWorktrees`, `fetchBranches`,
 * `fetchAgent`, `fetchMessageTemplates`, `fetchSkills`, `fetchCurrentUser`.
 * Pass 2: `getSession` (live AND paused), `fetchRepositories`,
 * `fetchSessionBranches`, `fetchBranchCommits`, `fetchGitHubIssue`,
 * `fetchAgents`, `fetchSessionPrLink`, `getRemoteBranchStatus`.
 * Pass 3: `fetchCloneJobStatus`, `validateSessions`, `fetchSessionMemo` and
 * `updateSessionMemo` (the same `{ content }` envelope), `fetchRepositorySlackIntegration`,
 * `fetchNotificationStatus`, `fetchReviewQueue` (a bare array of groups).
 * Pass 4 (the ten MUTATION responses): `createSession`, `createWorker`,
 * `restartAgentWorker`, `updateEmbeddedAgentWorker`, `restartAllAgentWorkers`,
 * `raiseOrchestratorDesignation`, `clearOrchestratorDesignation`,
 * `updateSessionMetadata`. `restartWorkerAsEmbeddedAgent` and `setMcpServerPermissions`
 * need a live embedded subprocess; their real-POST strict controls live in
 * `cross-type-restart-boundary.test.ts` and `embedded-agent-mcp-permission-boundary.test.ts`.
 * Pass 6 (the last seventeen casts): `cloneRepository`, `createWorktree` and
 * `createWorktreeAsync` (one route), `pullWorktreeAsync`, `deleteWorktreeAsync`,
 * `generateRepositoryDescription`, `updateRepositorySlackIntegration`,
 * `sendWorkerMessage`, `login`, `updateAuthPreferences`, `addReviewComment`,
 * `updateReviewStatus`, `createMessageTemplate` and `updateMessageTemplate` (one
 * schema), `deleteMessageTemplate` and `reorderMessageTemplates` (one schema).
 * `registerSharedAccount` needs a real OS account in multi-user mode; its strict
 * control lives in `shared-accounts-api-boundary.test.ts`.
 *
 * Each fetcher used to cast the JSON and trust it. They now `v.parse`
 * a `v.strictObject` schema, so a server body that gains or renames a field
 * turns a working call into a runtime throw in the browser -- and nothing on
 * either side alone would notice: the route tests assert the fields they know,
 * the client unit tests inject hand-written bodies.
 *
 * This file runs the REAL client function against the REAL route (the fetch
 * bridge hands the client's request to the real Hono app, real services over
 * the in-memory fs and SQLite; only git and the PTY are the recorded proxies)
 * and, per function, pins two things:
 *   1. the client function resolves with exactly what the route sent (the real
 *      body passes the strict schema), and
 *   2. a control: the same raw route body with ONE extra field is rejected by
 *      the schema, so (1) is attributable to the schema's strictness and not
 *      to a schema that accepts anything.
 *
 * For the pass-4 mutations the (2) half is a second, raw call of the same mutation
 * (`rawCall`), because the client function consumes its body.
 *
 * Reach: see the PR body for the measured results.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdir, rmdir } from 'node:fs/promises';
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { mockGit } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import { createMockPtyProvider } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { onApiError } from '@agent-console/server/src/lib/error-handler';
import { api } from '@agent-console/server/src/routes/api';
import { _getPullsInProgress } from '@agent-console/server/src/routes/worktrees';
import {
  getSession,
  fetchRepositories,
  fetchSessionBranches,
  fetchBranchCommits,
  fetchGitHubIssue,
  fetchAgents,
  fetchSessionPrLink,
  getRemoteBranchStatus,
  fetchCloneJobStatus,
  validateSessions,
  fetchSessionMemo,
  updateSessionMemo,
  fetchRepositorySlackIntegration,
  fetchNotificationStatus,
  fetchReviewQueue,
  fetchRepository,
  fetchWorkers,
  fetchWorktrees,
  fetchBranches,
  fetchAgent,
  fetchMessageTemplates,
  fetchSkills,
  fetchCurrentUser,
  createSession,
  createWorker,
  restartAgentWorker,
  updateEmbeddedAgentWorker,
  restartAllAgentWorkers,
  raiseOrchestratorDesignation,
  clearOrchestratorDesignation,
  updateSessionMetadata,
  cloneRepository,
  createWorktree,
  createWorktreeAsync,
  pullWorktreeAsync,
  deleteWorktreeAsync,
  generateRepositoryDescription,
  updateRepositorySlackIntegration,
  sendWorkerMessage,
  login,
  updateAuthPreferences,
  addReviewComment,
  updateReviewStatus,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
  reorderMessageTemplates,
} from '@agent-console/client/src/lib/api';
import {
  SessionResponseSchema,
  RepositoriesResponseSchema,
  BranchCommitsResponseSchema,
  GitHubIssueResponseSchema,
  AgentsResponseSchema,
  SessionPrLinkResponseSchema,
  RemoteBranchStatusSchema,
  CloneJobStatusResponseSchema,
  SessionsValidationResponseSchema,
  SessionMemoResponseSchema,
  RepositorySlackIntegrationSchema,
  NotificationStatusResponseSchema,
  ReviewQueueResponseSchema,
  CLONE_JOB_STATUS,
  CLONE_ERROR_CODES,
  RepositoryResponseSchema,
  WorkersResponseSchema,
  WorktreesResponseSchema,
  BranchesResponseSchema,
  AgentResponseSchema,
  MessageTemplatesResponseSchema,
  SkillsResponseSchema,
  CurrentUserResponseSchema,
  WorkerResponseSchema,
  RestartAllAgentsResponseSchema,
  OrchestratorDesignationResponseSchema,
  ClearOrchestratorDesignationResponseSchema,
  UpdateSessionResponseSchema,
  CloneRepositoryResponseSchema,
  WorktreeAcceptedResponseSchema,
  WorktreeDeletionAcceptedResponseSchema,
  GenerateRepositoryDescriptionResponseSchema,
  SendWorkerMessageResponseSchema,
  LoginResponseSchema,
  UpdateUserPreferencesResponseSchema,
  ReviewCommentSchema,
  ReviewStatusResponseSchema,
  MessageTemplateResponseSchema,
  SuccessResponseSchema,
} from '@agent-console/shared';
import { serverConfig } from '@agent-console/server/src/lib/server-config';
import { createFetchBridge } from './test-utils';

const TEST_REPO_PATH = '/test/repo-response-schemas';

describe('Client-Server Boundary: strict response schemas on the pass-1 to pass-6 client functions', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let repoId: string;
  let sessionId: string;
  let worktreeSessionId: string;
  let authUserId: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    setupMemfs({ [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main' });
    ctx = await createTestContext({ ptyProvider: createMockPtyProvider() });
    repoId = (await ctx.repositoryManager.registerRepository(TEST_REPO_PATH)).id;
    // The context's own single-user identity (and its `users` row).
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser) throw new Error('single-user mode must resolve a user');
    authUserId = authUser.id;
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH, agentId: 'claude-code-builtin' },
      { createdBy: authUserId },
    );
    sessionId = session.id;
    const worktreeSession = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH,
        repositoryId: repoId,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: authUserId },
    );
    worktreeSessionId = worktreeSession.id;

    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('appContext', ctx);
      await next();
    });
    app.onError(onApiError);
    app.route('/api', api);
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge?.restore();
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function rawBody(path: string): Promise<unknown> {
    const res = await app.request(path, { method: 'GET' });
    expect(res.status).toBe(200);
    return res.json();
  }

  /** Performs a mutation on the real route and returns the parsed JSON body (status 200, 201 or 202). */
  async function rawCall(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const res = await app.request(path, {
      method: init.method,
      ...(init.body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init.body),
      }),
    });
    expect([200, 201, 202]).toContain(res.status);
    return res.json();
  }

  /** The strict schema accepts the route's real body and rejects it plus one extra field. */
  function expectStrictControl(schema: v.GenericSchema, body: unknown): void {
    expect(v.safeParse(schema, body).success).toBe(true);
    expect(v.safeParse(schema, { ...(body as object), extra: true }).success).toBe(false);
  }

  it('fetchRepository: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchRepository(repoId);
    const body = await rawBody(`/api/repositories/${repoId}`);

    expect(result).toEqual(body as typeof result);
    expect(result.repository.id).toBe(repoId);
    expectStrictControl(RepositoryResponseSchema, body);
  });

  it('fetchWorkers: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchWorkers(sessionId);
    const body = await rawBody(`/api/sessions/${sessionId}/workers`);

    expect(result).toEqual(body as typeof result);
    expect(result.workers.length).toBeGreaterThan(0);
    expectStrictControl(WorkersResponseSchema, body);
  });

  it('fetchWorktrees: the real body parses, and an extra field is rejected', async () => {
    mockGit.listWorktrees.mockImplementation(() =>
      Promise.resolve(`worktree ${TEST_REPO_PATH}\nHEAD abc\nbranch refs/heads/main\n`));

    const result = await fetchWorktrees(repoId);
    const body = await rawBody(`/api/repositories/${repoId}/worktrees`);

    expect(result).toEqual(body as typeof result);
    expect(result.pathStatus).toBe('ok');
    expectStrictControl(WorktreesResponseSchema, body);
  });

  it('fetchBranches: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchBranches(repoId);
    const body = await rawBody(`/api/repositories/${repoId}/branches`);

    expect(result).toEqual(body as typeof result);
    expectStrictControl(BranchesResponseSchema, body);
  });

  it('fetchAgent: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchAgent('claude-code-builtin');
    const body = await rawBody('/api/agents/claude-code-builtin');

    expect(result).toEqual(body as typeof result);
    expect(result.agent.id).toBe('claude-code-builtin');
    expectStrictControl(AgentResponseSchema, body);
  });

  it('fetchMessageTemplates: the real body parses (with a stored template), and an extra field is rejected', async () => {
    await ctx.messageTemplateRepository.create('template-1', 'Greeting', 'hello', 0);

    const result = await fetchMessageTemplates();
    const body = await rawBody('/api/message-templates');

    expect(result).toEqual(body as typeof result);
    expect(result.templates.map((t) => t.title)).toEqual(['Greeting']);
    expectStrictControl(MessageTemplatesResponseSchema, body);
  });

  it('fetchSkills: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchSkills();
    const body = await rawBody('/api/skills');

    expect(result).toEqual(body as typeof result);
    expectStrictControl(SkillsResponseSchema, body);
  });

  it('fetchCurrentUser: the real body parses (user + preferences), and an extra field is rejected', async () => {
    const result = await fetchCurrentUser();
    const body = await rawBody('/api/auth/me');

    expect(result).toEqual(body as typeof result);
    expect(result.user?.id).toBe(authUserId);
    expectStrictControl(CurrentUserResponseSchema, body);
  });

  // ---- pass 2 ----

  it('getSession: a live session parses, and an extra field is rejected', async () => {
    const result = await getSession(sessionId);
    const body = await rawBody(`/api/sessions/${sessionId}`);

    expect(result).toEqual((body as { session: typeof result }).session);
    expect(result?.id).toBe(sessionId);
    expectStrictControl(SessionResponseSchema, body);
  });

  it('getSession: the PAUSED (persisted) session parses too, and an extra field is rejected', async () => {
    const pauseRes = await app.request(`/api/sessions/${worktreeSessionId}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);
    // The pause moved the session out of memory: the route now serves the persisted row.
    expect(ctx.sessionManager.getSession(worktreeSessionId)).toBeUndefined();

    const result = await getSession(worktreeSessionId);
    const body = await rawBody(`/api/sessions/${worktreeSessionId}`);

    expect(result).toEqual((body as { session: typeof result }).session);
    expect(result?.activationState).toBe('hibernated');
    expectStrictControl(SessionResponseSchema, body);
  });

  it('fetchRepositories: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchRepositories();
    const body = await rawBody('/api/repositories');

    expect(result).toEqual(body as typeof result);
    expect(result.repositories.map((r) => r.id)).toEqual([repoId]);
    expectStrictControl(RepositoriesResponseSchema, body);
  });

  it('fetchSessionBranches: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchSessionBranches(sessionId);
    const body = await rawBody(`/api/sessions/${sessionId}/branches`);

    expect(result).toEqual(body as typeof result);
    expectStrictControl(BranchesResponseSchema, body);
  });

  it('fetchBranchCommits: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchBranchCommits(sessionId, 'main');
    const body = await rawBody(`/api/sessions/${sessionId}/commits?base=main`);

    expect(result).toEqual(body as typeof result);
    expectStrictControl(BranchCommitsResponseSchema, body);
  });

  it('fetchGitHubIssue: the real body parses, and an extra field is rejected', async () => {
    // Recorded proxy: the `gh` CLI call is substituted by assigning `fetchGitHubIssue` on the
    // context object (it is not a createTestContext option; the route reads it from there).
    // Still real: the route, its JSON serialization, the fetch bridge and the client schema parse.
    ctx.fetchGitHubIssue = () =>
      Promise.resolve({
        org: 'owner',
        repo: 'repo',
        number: 7,
        title: 'An issue',
        body: 'Body',
        url: 'https://github.com/owner/repo/issues/7',
        suggestedBranch: 'an-issue',
      });

    const result = await fetchGitHubIssue(repoId, '#7');
    const res = await app.request(`/api/repositories/${repoId}/github-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: '#7' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(result).toEqual(body as typeof result);
    expect(result.issue.number).toBe(7);
    expectStrictControl(GitHubIssueResponseSchema, body);
  });

  it('fetchAgents: the real body parses, and an extra field is rejected', async () => {
    const result = await fetchAgents();
    const body = await rawBody('/api/agents');

    expect(result).toEqual(body as typeof result);
    expect(result.agents.length).toBeGreaterThan(0);
    expectStrictControl(AgentsResponseSchema, body);
  });

  it('fetchSessionPrLink: the real body parses, and an extra field is rejected', async () => {
    // Recorded proxy: the `gh pr view` lookup is substituted on the context object (no
    // createTestContext option exists). Still real: the route, `getOrgRepoFromPath` via the
    // git mock, JSON serialization, the fetch bridge and the client schema parse.
    ctx.fetchPullRequestUrl = () => Promise.resolve('https://github.com/owner/repo/pull/9');

    const result = await fetchSessionPrLink(worktreeSessionId);
    const body = await rawBody(`/api/sessions/${worktreeSessionId}/pr-link`);

    expect(result).toEqual(body as typeof result);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/9');
    expect(result.orgRepo).toBe('owner/repo');
    expectStrictControl(SessionPrLinkResponseSchema, body);
  });

  it('getRemoteBranchStatus: the real body parses, and an extra field is rejected', async () => {
    mockGit.getCommitsBehind.mockImplementation(() => Promise.resolve(3));
    mockGit.getCommitsAhead.mockImplementation(() => Promise.resolve(2));

    const result = await getRemoteBranchStatus(repoId, 'main');
    const body = await rawBody(`/api/repositories/${repoId}/branches/main/remote-status`);

    expect(result).toEqual(body as typeof result);
    expect(result).toEqual({ behind: 3, ahead: 2 });
    expectStrictControl(RemoteBranchStatusSchema, body);
  });

  // ---- pass 3 ----

  it('fetchCloneJobStatus: every job status shape parses, and an extra field is rejected', async () => {
    // Recorded proxy: the clone job table is substituted (`getJob`), because a real job needs a
    // `git clone` run as the requesting user. Still real: the GET route that builds the body
    // (optional keys omitted when absent), its JSON serialization, the fetch bridge and the
    // client schema parse.
    const now = Date.now();
    const states = {
      'job-pending': { id: 'job-pending', status: CLONE_JOB_STATUS.PENDING, createdAt: now, updatedAt: now },
      'job-done': {
        id: 'job-done',
        status: CLONE_JOB_STATUS.SUCCEEDED,
        repositoryId: 'repo-cloned',
        createdAt: now,
        updatedAt: now,
      },
      'job-failed': {
        id: 'job-failed',
        status: CLONE_JOB_STATUS.FAILED,
        error: { code: CLONE_ERROR_CODES.AUTH_FAILED, message: 'Permission denied (publickey).' },
        createdAt: now,
        updatedAt: now,
      },
    };
    const getJob = spyOn(ctx.repositoryCloneService, 'getJob').mockImplementation(
      (jobId: string) => states[jobId as keyof typeof states],
    );
    try {
      for (const jobId of Object.keys(states)) {
        const result = await fetchCloneJobStatus(jobId);
        const body = await rawBody(`/api/repositories/clone/${jobId}`);

        expect(result).toEqual(body as typeof result);
        expect(result.jobId).toBe(jobId);
        expectStrictControl(CloneJobStatusResponseSchema, body);
      }
    } finally {
      getJob.mockRestore();
    }
  });

  it('validateSessions: the real body parses (valid and invalid sessions), and an extra field is rejected', async () => {
    // A persisted session whose directory is gone yields a real `directory_not_found` issue.
    const vanishing = '/test/session-dir-removed-later';
    await mkdir(vanishing, { recursive: true });
    const missing = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: vanishing, agentId: 'claude-code-builtin' },
      { createdBy: authUserId },
    );
    await rmdir(vanishing);

    const result = await validateSessions();
    const body = await rawBody('/api/sessions/validate');

    expect(result).toEqual(body as typeof result);
    expect(result.results.length).toBeGreaterThanOrEqual(3);
    const invalid = result.results.find((r) => r.sessionId === missing.id);
    expect(invalid?.valid).toBe(false);
    expect(invalid?.issues.map((i) => i.type)).toEqual(['directory_not_found']);
    expect(result.hasIssues).toBe(true);
    expectStrictControl(SessionsValidationResponseSchema, body);
  });

  it('fetchSessionMemo: the real body parses (no memo, then a stored memo), and an extra field is rejected', async () => {
    const emptyBody = await rawBody(`/api/sessions/${sessionId}/memo`);
    expect(await fetchSessionMemo(sessionId)).toBeNull();
    expect(emptyBody).toEqual({ content: null });
    expectStrictControl(SessionMemoResponseSchema, emptyBody);

    await updateSessionMemo(sessionId, 'remember this');
    const storedBody = await rawBody(`/api/sessions/${sessionId}/memo`);

    expect(await fetchSessionMemo(sessionId)).toBe('remember this');
    expect(storedBody).toEqual({ content: 'remember this' });
    expectStrictControl(SessionMemoResponseSchema, storedBody);
  });

  it('updateSessionMemo: the real body parses (write, then delete on empty content), and an extra field is rejected', async () => {
    const put = (content: string) =>
      app.request(`/api/sessions/${sessionId}/memo`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

    const written = await updateSessionMemo(sessionId, 'first');
    const writtenBody = await (await put('first')).json();
    expect(written).toEqual(writtenBody as typeof written);
    expect(written.content).toBe('first');
    expectStrictControl(SessionMemoResponseSchema, writtenBody);

    // An empty save deletes the memo; the server answers `{ content: null }`, not the argument.
    const deleted = await updateSessionMemo(sessionId, '   ');
    const deletedBody = await (await put('   ')).json();
    expect(deleted).toEqual(deletedBody as typeof deleted);
    expect(deleted.content).toBeNull();
    expectStrictControl(SessionMemoResponseSchema, deletedBody);
  });

  it('fetchRepositorySlackIntegration: 404 resolves null; the real body parses, and an extra field is rejected', async () => {
    expect(await fetchRepositorySlackIntegration(repoId)).toBeNull();

    const putRes = await app.request(`/api/repositories/${repoId}/integrations/slack`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX', enabled: false }),
    });
    expect(putRes.status).toBe(200);

    const result = await fetchRepositorySlackIntegration(repoId);
    const body = await rawBody(`/api/repositories/${repoId}/integrations/slack`);

    expect(result).toEqual(body as NonNullable<typeof result>);
    expect(result?.repositoryId).toBe(repoId);
    expect(result?.enabled).toBe(false);
    expectStrictControl(RepositorySlackIntegrationSchema, body);
  });

  it('fetchNotificationStatus: the real body parses (configured and unconfigured), and an extra field is rejected', async () => {
    // `serverConfig` is a readonly constant; the route reads `APP_URL` on every request.
    const config = serverConfig as { APP_URL: string };
    const original = config.APP_URL;
    try {
      for (const appUrl of ['https://console.example.com', '']) {
        config.APP_URL = appUrl;

        const result = await fetchNotificationStatus();
        const body = await rawBody('/api/settings/notifications/status');

        expect(result).toEqual(body as typeof result);
        expect(result.baseUrl).toBe(appUrl);
        expect(result.isBaseUrlConfigured).toBe(appUrl !== '');
        expectStrictControl(NotificationStatusResponseSchema, body);
      }
    } finally {
      config.APP_URL = original;
    }
  });

  it('fetchReviewQueue: the real body parses (with and without a parent session), and an extra field is rejected', async () => {
    const child = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: TEST_REPO_PATH, agentId: 'claude-code-builtin', parentSessionId: sessionId },
      { createdBy: authUserId },
    );
    const summary = { totalFiles: 3, reviewFiles: 1, mechanicalFiles: 2, confidence: 'high' as const };
    // Two review queue items for the same source session: one on a session with a parent
    // (parent fields present), one on a parentless session (parent fields omitted).
    ctx.annotationService.setAnnotations('worker-with-parent', { annotations: [], summary }, {
      sessionId: child.id,
      sourceSessionId: worktreeSessionId,
    });
    ctx.annotationService.setAnnotations('worker-no-parent', { annotations: [], summary }, {
      sessionId,
      sourceSessionId: worktreeSessionId,
    });

    const result = await fetchReviewQueue();
    const body = await rawBody('/api/review-queue');

    expect(result).toEqual(body as typeof result);
    expect(result).toHaveLength(1);
    const items = result[0]?.items ?? [];
    expect(items.find((i) => i.workerId === 'worker-with-parent')?.parentSessionId).toBe(sessionId);
    expect(items.find((i) => i.workerId === 'worker-no-parent')?.parentSessionId).toBeUndefined();

    // A bare array, not an envelope: the control adds the extra field to the first group.
    const groups = body as Array<Record<string, unknown>>;
    expect(v.safeParse(ReviewQueueResponseSchema, groups).success).toBe(true);
    expect(v.safeParse(ReviewQueueResponseSchema, [{ ...groups[0], extra: true }]).success).toBe(false);
  });

  // ---- pass 4: mutation responses ----

  it('createSession: the real 201 body parses, and an extra field is rejected', async () => {
    const request = { type: 'quick' as const, locationPath: TEST_REPO_PATH, agentId: 'claude-code-builtin' };
    const result = await createSession(request);
    expect(result.session.type).toBe('quick');
    expect(ctx.sessionManager.getSession(result.session.id)).toBeDefined();

    const body = await rawCall('/api/sessions', { method: 'POST', body: request });
    expectStrictControl(SessionResponseSchema, body);
  });

  it('createWorker: a terminal worker is created, and the real 201 body parses with an extra field rejected', async () => {
    const result = await createWorker(sessionId, { type: 'terminal', name: 'Shell A' });
    expect(result.worker.type).toBe('terminal');
    expect(ctx.sessionManager.getSession(sessionId)?.workers.some((w) => w.id === result.worker.id)).toBe(true);

    const body = await rawCall(`/api/sessions/${sessionId}/workers`, {
      method: 'POST',
      body: { type: 'terminal', name: 'Shell B' },
    });
    expectStrictControl(WorkerResponseSchema, body);
  });

  it('restartAgentWorker: the agent worker is restarted, and the real body parses with an extra field rejected', async () => {
    const agentWorker = ctx.sessionManager.getSession(sessionId)?.workers.find((w) => w.type === 'agent');
    if (!agentWorker) throw new Error('fixture session must have an agent worker');

    const result = await restartAgentWorker(sessionId, agentWorker.id);
    expect(result.worker.type).toBe('agent');
    expect(result.worker.id).toBe(agentWorker.id);

    const body = await rawCall(`/api/sessions/${sessionId}/workers/${agentWorker.id}/restart`, {
      method: 'POST',
      body: { continueConversation: false },
    });
    expectStrictControl(WorkerResponseSchema, body);
  });

  it('updateEmbeddedAgentWorker: a dormant embedded worker is updated, and the real body parses with an extra field rejected', async () => {
    // The worker is created but never activated: no subprocess is involved, the PATCH only
    // writes and persists `autoCompaction`.
    const created = await ctx.sessionManager.createWorker(sessionId, {
      type: 'embedded-agent',
      embeddedAgentId: 'claude-sdk-builtin',
    });
    if (!created) throw new Error('embedded worker creation must succeed');

    const result = await updateEmbeddedAgentWorker(sessionId, created.id, { autoCompaction: false });
    expect(result.worker.type).toBe('embedded-agent');
    expect(result.worker.type === 'embedded-agent' && result.worker.autoCompaction).toBe(false);

    const body = await rawCall(`/api/sessions/${sessionId}/workers/${created.id}`, {
      method: 'PATCH',
      body: { autoCompaction: true },
    });
    expectStrictControl(WorkerResponseSchema, body);
  });

  it('restartAllAgentWorkers: the real body parses (per-worker results), and an extra field is rejected', async () => {
    const result = await restartAllAgentWorkers();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.restarted + result.failed + result.skipped).toBe(result.results.length);

    const body = await rawCall('/api/sessions/restart-all-agents', { method: 'POST' });
    expectStrictControl(RestartAllAgentsResponseSchema, body);
  });

  it('raise/clearOrchestratorDesignation: the real bodies parse, including clearing a non-designated session (removed: false)', async () => {
    const path = `/api/sessions/${worktreeSessionId}/orchestrator-designation`;

    const raised = await raiseOrchestratorDesignation(worktreeSessionId);
    expect(raised.orchestratorSessionIds).toContain(worktreeSessionId);
    expectStrictControl(
      OrchestratorDesignationResponseSchema,
      await rawCall(path, { method: 'POST' }),
    );

    const cleared = await clearOrchestratorDesignation(worktreeSessionId);
    expect(cleared.removed).toBe(true);
    expect(cleared.orchestratorSessionIds).not.toContain(worktreeSessionId);

    // Clearing a session that is no longer designated answers `removed: false`; that body
    // must parse too (the client function would throw on a schema mismatch).
    const again = await rawCall(path, { method: 'DELETE' });
    expect((again as { removed: boolean }).removed).toBe(false);
    expectStrictControl(ClearOrchestratorDesignationResponseSchema, again);
  });

  it('updateSessionMetadata: a title update echoes the title, an empty update answers success alone, and an extra field is rejected', async () => {
    const result = await updateSessionMetadata(sessionId, { title: 'x' });
    expect(result.title).toBe('x');
    expectStrictControl(
      UpdateSessionResponseSchema,
      await rawCall(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { title: 'y' } }),
    );

    const empty = await rawCall(`/api/sessions/${sessionId}`, { method: 'PATCH', body: {} });
    expect(empty).toEqual({ success: true });
    expectStrictControl(UpdateSessionResponseSchema, empty);
  });

  // ---- pass 6: the last seventeen casts ----
  // Proxies recorded here (the file's existing git / PTY stubs plus these, all upstream of
  // the response body under test): `enqueueClone` (no real `git clone`), the description
  // generator (no headless agent CLI), `verifyRepoAccessible` (the background worktree
  // pipeline ends at once instead of running git), `userMode.login` (single-user mode has
  // no credential check). Every route, handler and response body is the real one.

  it('cloneRepository: the real 202 body parses, and an extra field is rejected', async () => {
    const enqueueClone = spyOn(ctx.repositoryCloneService, 'enqueueClone').mockResolvedValue('job-1');
    try {
      const request = { url: 'https://github.com/org/repo.git' };
      const result = await cloneRepository(request);
      expect(result).toEqual({ jobId: 'job-1', repositoryId: null });

      const body = await rawCall('/api/repositories/clone', { method: 'POST', body: request });
      expectStrictControl(CloneRepositoryResponseSchema, body);
    } finally {
      enqueueClone.mockRestore();
    }
  });

  it('createWorktree / createWorktreeAsync: the real 202 body of the shared route parses, and an extra field is rejected', async () => {
    const verify = spyOn(ctx.worktreeService, 'verifyRepoAccessible').mockRejectedValue(new Error('stubbed'));
    try {
      const request = (taskId: string) => ({ taskId, mode: 'custom' as const, branch: 'feature-x' });
      expect(await createWorktree(repoId, request('task-a'))).toEqual({ accepted: true });
      expect(await createWorktreeAsync(repoId, request('task-b'))).toEqual({ accepted: true });

      const body = await rawCall(`/api/repositories/${repoId}/worktrees`, { method: 'POST', body: request('task-c') });
      expect(body).toEqual({ accepted: true });
      expectStrictControl(WorktreeAcceptedResponseSchema, body);
    } finally {
      verify.mockRestore();
    }
  });

  it('pullWorktreeAsync: the real 202 body parses, and an extra field is rejected', async () => {
    // The route keeps a path in its in-progress set while the background pull runs and answers
    // 409 for a second pull of the same path. Poll that set (bounded; it FAILS if the entry
    // never clears) instead of sleeping for a guessed duration.
    const waitForPullToClear = async (): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (_getPullsInProgress().has(TEST_REPO_PATH)) {
        if (Date.now() > deadline) throw new Error('the background pull did not clear within 5000 ms');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    // The repository's primary worktree: no managed-directory or ownership check applies.
    const result = await pullWorktreeAsync(repoId, TEST_REPO_PATH, 'pull-a');
    expect(result).toEqual({ accepted: true });
    // The background pull of the first call must finish before the same path is pulled again.
    await waitForPullToClear();

    const body = await rawCall(`/api/repositories/${repoId}/worktrees/pull`, {
      method: 'POST',
      body: { worktreePath: TEST_REPO_PATH, taskId: 'pull-b' },
    });
    expect(body).toEqual({ accepted: true });
    expectStrictControl(WorktreeAcceptedResponseSchema, body);
    await waitForPullToClear();
  });

  it('deleteWorktreeAsync: the real async 202 body parses (with a job id), and an extra field is rejected', async () => {
    const worktreePath = `${TEST_REPO_PATH}-wt`;
    const result = await deleteWorktreeAsync(repoId, worktreePath);
    expect(result.accepted).toBe(true);
    expect(typeof result.jobId).toBe('string');

    const body = await rawCall(
      `/api/repositories/${repoId}/worktrees/${encodeURIComponent(`${worktreePath}-2`)}?async=true`,
      { method: 'DELETE' },
    );
    expectStrictControl(WorktreeDeletionAcceptedResponseSchema, body);
  });

  it('generateRepositoryDescription: the real body parses, and an extra field is rejected', async () => {
    const generate = spyOn(ctx, 'generateRepositoryDescription').mockResolvedValue({ description: 'A test repository' });
    try {
      const result = await generateRepositoryDescription(repoId);
      expect(result).toEqual({ description: 'A test repository' });

      const body = await rawCall(`/api/repositories/${repoId}/generate-description`, { method: 'POST' });
      expectStrictControl(GenerateRepositoryDescriptionResponseSchema, body);
    } finally {
      generate.mockRestore();
    }
  });

  it('updateRepositorySlackIntegration: the real bare-entity body parses, and an extra field is rejected', async () => {
    const data = { webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX', enabled: true };
    const result = await updateRepositorySlackIntegration(repoId, data);
    expect(result.repositoryId).toBe(repoId);
    expect(result.enabled).toBe(true);

    const body = await rawCall(`/api/repositories/${repoId}/integrations/slack`, { method: 'PUT', body: data });
    expectStrictControl(RepositorySlackIntegrationSchema, body);
  });

  it('sendWorkerMessage: the real 201 body parses, and an extra field is rejected', async () => {
    const created = await ctx.sessionManager.createWorker(sessionId, { type: 'terminal', name: 'Receiver' });
    if (!created) throw new Error('terminal worker creation must succeed');

    const result = await sendWorkerMessage(sessionId, created.id, 'hello from the client');
    expect(result.message.toWorkerId).toBe(created.id);
    expect(result.message.content).toBe('hello from the client');

    // The route reads multipart form data, so the control sends the same form.
    const form = new FormData();
    form.append('toWorkerId', created.id);
    form.append('content', 'hello again');
    const res = await app.request(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    expectStrictControl(SendWorkerMessageResponseSchema, await res.json());
  });

  it('login: the real body parses, and an extra field is rejected', async () => {
    const user = { id: authUserId, username: 'login-user', homeDir: '/home/login-user' };
    const loginStub = spyOn(ctx.userMode, 'login').mockResolvedValue({ user, token: 'stub-token' });
    try {
      const credentials = { username: 'login-user', password: 'pw' };
      const result = await login(credentials);
      expect(result).toEqual({ user });

      const body = await rawCall('/api/auth/login', { method: 'POST', body: credentials });
      expectStrictControl(LoginResponseSchema, body);
    } finally {
      loginStub.mockRestore();
    }
  });

  it('updateAuthPreferences: the real body parses (user + preferences), and an extra field is rejected', async () => {
    const result = await updateAuthPreferences({ disableClaudeAiConnectors: true });
    expect(result.preferences.disableClaudeAiConnectors).toBe(true);
    expect(result.user.id).toBe(authUserId);

    const body = await rawCall('/api/auth/me/preferences', {
      method: 'PATCH',
      body: { disableClaudeAiConnectors: false },
    });
    expectStrictControl(UpdateUserPreferencesResponseSchema, body);
  });

  it('addReviewComment: the real bare-entity 201 body parses, and an extra field is rejected', async () => {
    const summary = { totalFiles: 1, reviewFiles: 1, mechanicalFiles: 0, confidence: 'high' as const };
    ctx.annotationService.setAnnotations('worker-comment', { annotations: [], summary }, {
      sessionId,
      sourceSessionId: worktreeSessionId,
    });

    const result = await addReviewComment('worker-comment', { file: 'a.ts', line: 3, body: 'nit' });
    expect(result.file).toBe('a.ts');
    expect(result.line).toBe(3);

    const body = await rawCall('/api/review-queue/worker-comment/comments', {
      method: 'POST',
      body: { file: 'b.ts', line: 7, body: 'another' },
    });
    expectStrictControl(ReviewCommentSchema, body);
  });

  it('updateReviewStatus: the real body parses, and an extra field is rejected', async () => {
    const summary = { totalFiles: 1, reviewFiles: 1, mechanicalFiles: 0, confidence: 'high' as const };
    ctx.annotationService.setAnnotations('worker-status', { annotations: [], summary }, {
      sessionId,
      sourceSessionId: worktreeSessionId,
    });

    const result = await updateReviewStatus('worker-status', 'completed');
    expect(result).toEqual({ workerId: 'worker-status', status: 'completed' });

    const body = await rawCall('/api/review-queue/worker-status/status', {
      method: 'PATCH',
      body: { status: 'completed' },
    });
    expectStrictControl(ReviewStatusResponseSchema, body);
  });

  it('createMessageTemplate / updateMessageTemplate: the real { template } bodies parse, and an extra field is rejected', async () => {
    const created = await createMessageTemplate('Greeting', 'Hello');
    expect(created.template.title).toBe('Greeting');

    const updated = await updateMessageTemplate(created.template.id, { title: 'Greeting 2' });
    expect(updated.template.title).toBe('Greeting 2');

    expectStrictControl(
      MessageTemplateResponseSchema,
      await rawCall('/api/message-templates', { method: 'POST', body: { title: 'Second', content: 'Body' } }),
    );
    expectStrictControl(
      MessageTemplateResponseSchema,
      await rawCall(`/api/message-templates/${created.template.id}`, { method: 'PUT', body: { content: 'Changed' } }),
    );
  });

  it('deleteMessageTemplate / reorderMessageTemplates: the real { success: true } bodies parse, and an extra field is rejected', async () => {
    const first = await createMessageTemplate('One', 'a');
    const second = await createMessageTemplate('Two', 'b');
    const third = await createMessageTemplate('Three', 'c');

    expect(await reorderMessageTemplates([second.template.id, first.template.id, third.template.id])).toEqual({
      success: true,
    });
    expectStrictControl(
      SuccessResponseSchema,
      await rawCall('/api/message-templates/reorder', {
        method: 'PUT',
        body: { orderedIds: [third.template.id, second.template.id, first.template.id] },
      }),
    );

    expect(await deleteMessageTemplate(first.template.id)).toEqual({ success: true });
    expectStrictControl(
      SuccessResponseSchema,
      await rawCall(`/api/message-templates/${second.template.id}`, { method: 'DELETE' }),
    );
  });
});
