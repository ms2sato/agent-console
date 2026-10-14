/**
 * Client-Server Boundary Test: the sixteen read fetchers that parse their
 * response through a strict wire schema (#1367 pass 1 and pass 2).
 *
 * Pass 1: `fetchRepository`, `fetchWorkers`, `fetchWorktrees`, `fetchBranches`,
 * `fetchAgent`, `fetchMessageTemplates`, `fetchSkills`, `fetchCurrentUser`.
 * Pass 2: `getSession` (live AND paused), `fetchRepositories`,
 * `fetchSessionBranches`, `fetchBranchCommits`, `fetchGitHubIssue`,
 * `fetchAgents`, `fetchSessionPrLink`, `getRemoteBranchStatus`.
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
 * Reach, measured (see the PR body): reverting one fetcher to the old cast
 * keeps (1) green for that function but the unit tests for its malformed-body
 * case fail; adding a field to the route's body fails (1) AND (2)'s plain-body
 * half for that function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import {
  getSession,
  fetchRepositories,
  fetchSessionBranches,
  fetchBranchCommits,
  fetchGitHubIssue,
  fetchAgents,
  fetchSessionPrLink,
  getRemoteBranchStatus,
  fetchRepository,
  fetchWorkers,
  fetchWorktrees,
  fetchBranches,
  fetchAgent,
  fetchMessageTemplates,
  fetchSkills,
  fetchCurrentUser,
} from '@agent-console/client/src/lib/api';
import {
  SessionResponseSchema,
  RepositoriesResponseSchema,
  BranchCommitsResponseSchema,
  GitHubIssueResponseSchema,
  AgentsResponseSchema,
  SessionPrLinkResponseSchema,
  RemoteBranchStatusSchema,
  RepositoryResponseSchema,
  WorkersResponseSchema,
  WorktreesResponseSchema,
  BranchesResponseSchema,
  AgentResponseSchema,
  MessageTemplatesResponseSchema,
  SkillsResponseSchema,
  CurrentUserResponseSchema,
} from '@agent-console/shared';
import { createFetchBridge } from './test-utils';

const TEST_REPO_PATH = '/test/repo-response-schemas';

describe('Client-Server Boundary: strict response schemas on the pass-1 and pass-2 read fetchers', () => {
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
});
