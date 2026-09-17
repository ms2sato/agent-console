/**
 * Client-Server Boundary Test: Repository.orchestratorSessionIds /
 * issueTriggerLabels, and the orchestrator-designation-changed broadcast
 * (Issue #1716 -- the Orchestrator designation is a SET of sessions per
 * repository, not a single nullable pointer).
 *
 * Regression guard for the same failure shape as Issue #914 + #927
 * (`created-by-username-boundary.test.ts`): a field can be populated
 * server-side yet be silently stripped by `AppServerMessageSchema.safeParse`
 * on the client because the field is missing from the valibot schema.
 * Neither the server unit tests (which never cross the schema boundary) nor
 * the client unit tests (which use pre-built mock objects that bypass
 * parsing entirely) can catch this class of gap.
 *
 * Two wire surfaces need this guard:
 *
 *   1. `Repository.orchestratorSessionIds` -- a REQUIRED array field on the
 *      existing `Repository` shape, riding along on every
 *      `repository-created` / `repository-updated` / `repositories-sync`
 *      broadcast.
 *   2. `orchestrator-designation-changed` -- fired specifically when
 *      `RepositoryManager.addOrchestratorSession` /
 *      `removeOrchestratorSession` changes the designation set, carrying
 *      the FULL re-read set (`orchestratorSessionIds`), the single session
 *      that changed (`changedSessionId`), and which direction
 *      (`action: 'added' | 'removed'`).
 *
 * Both exercise the real chain:
 *   server RepositoryManager (real registerRepository /
 *     addOrchestratorSession / removeOrchestratorSession)
 *     -> the real broadcast shape (mirrors packages/server/src/websocket/
 *        routes.ts's `broadcastToApp` calls)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser used by
 *        packages/client/src/lib/app-websocket.ts:parseMessage)
 *   assert both fields (and the new message) survive end-to-end.
 *
 * Stashing `orchestratorSessionIds` from `RepositorySchema`, or
 * `OrchestratorDesignationChangedSchema` from the `AppServerMessageSchema`
 * variant list (both in packages/shared/src/schemas/app-server-message.ts),
 * causes the corresponding assertions below to fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  getTestConfigDir,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema } from '@agent-console/shared';
import type { AppServerMessage, Repository } from '@agent-console/shared';

const TEST_REPO_PATH_A = '/test/repo-a';
const TEST_REPO_PATH_B = '/test/repo-b';

describe('Client-Server Boundary: Repository orchestrator designation (Issue #1716)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();

    // `setupTestEnvironment()` already seeded memfs with the config dir's
    // `.keep` placeholder, but `setupMemfs()` resets the whole in-memory
    // volume on every call -- re-seed both the config dir AND two fake git
    // repo directories here so `RepositoryManager.registerRepository`'s
    // path-existence / `.git`-existence checks succeed for both fixtures
    // this file needs.
    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH_A}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${TEST_REPO_PATH_B}/.git/HEAD`]: 'ref: refs/heads/main',
    });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  describe('Repository.orchestratorSessionIds', () => {
    it('round-trips as [] through the server -> JSON wire -> AppServerMessageSchema.safeParse chain when never designated', async () => {
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      // Sanity check: server-side state already carries the field before
      // any wire / schema round-trip. If this fails, the regression is in
      // the manager, not the schema.
      expect(registered.orchestratorSessionIds).toEqual([]);

      const wirePayload = JSON.parse(
        JSON.stringify({
          type: 'repository-created',
          repository: { ...registered, clonedSourceRepoPath: null },
        }),
      );

      const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(
          `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
        );
      }
      if (parsed.output.type !== 'repository-created') {
        throw new Error(`Expected repository-created, got: ${parsed.output.type}`);
      }

      // The crucial assertion: the field must survive the schema parser AS
      // A REQUIRED KEY carrying `[]`, not merely be absent. Without its
      // schema entry, valibot's `v.strictObject` rejects the WHOLE payload
      // (an unrecognized field), so `parsed.success` would be `false`
      // rather than the field merely being missing.
      expect('orchestratorSessionIds' in parsed.output.repository).toBe(true);
      expect(parsed.output.repository.orchestratorSessionIds).toEqual([]);
    });

    it('round-trips a one-session set', async () => {
      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      const afterDesignation = await ctx.repositoryManager.addOrchestratorSession(registered.id, session.id);
      expect(afterDesignation).not.toBeNull();
      const repository = afterDesignation as Repository;
      expect(repository.orchestratorSessionIds).toEqual([session.id]);

      const wirePayload = JSON.parse(
        JSON.stringify({
          type: 'repository-updated',
          repository: { ...repository, clonedSourceRepoPath: null },
        }),
      );
      const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(
          `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
        );
      }
      if (parsed.output.type !== 'repository-updated') {
        throw new Error(`Expected repository-updated, got: ${parsed.output.type}`);
      }
      expect(parsed.output.repository.orchestratorSessionIds).toEqual([session.id]);
    });

    it('round-trips a two-session set', async () => {
      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
      const sessionA = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path-a', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const sessionB = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path-b', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      await ctx.repositoryManager.addOrchestratorSession(registered.id, sessionA.id);
      const afterSecondDesignation = await ctx.repositoryManager.addOrchestratorSession(registered.id, sessionB.id);
      expect(afterSecondDesignation).not.toBeNull();
      const repository = afterSecondDesignation as Repository;
      expect(new Set(repository.orchestratorSessionIds)).toEqual(new Set([sessionA.id, sessionB.id]));

      const wirePayload = JSON.parse(
        JSON.stringify({
          type: 'repository-updated',
          repository: { ...repository, clonedSourceRepoPath: null },
        }),
      );
      const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(
          `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
        );
      }
      if (parsed.output.type !== 'repository-updated') {
        throw new Error(`Expected repository-updated, got: ${parsed.output.type}`);
      }
      expect(new Set(parsed.output.repository.orchestratorSessionIds)).toEqual(new Set([sessionA.id, sessionB.id]));
    });
  });

  describe('orchestrator-designation-changed broadcast', () => {
    it('survives the round-trip for both the added and removed actions, carrying orchestratorSessionIds and changedSessionId', async () => {
      const captured: unknown[] = [];
      const broadcastToApp = (msg: AppServerMessage): void => {
        captured.push(msg);
      };

      // Wire lifecycle callbacks the same way
      // packages/server/src/websocket/routes.ts does -- `createTestContext`
      // does not wire `RepositoryManager.setLifecycleCallbacks` by default,
      // so this test wires a minimal set (no-ops for the callbacks this
      // test doesn't exercise) plus the real capturing broadcast for the
      // callback under test.
      ctx.repositoryManager.setLifecycleCallbacks({
        onRepositoryCreated: () => {},
        onRepositoryUpdated: () => {},
        onRepositoryDeleted: () => {},
        onOrchestratorDesignationChanged: (repositoryId, orchestratorSessionIds, changedSessionId, action) => {
          broadcastToApp({
            type: 'orchestrator-designation-changed',
            repositoryId,
            orchestratorSessionIds,
            changedSessionId,
            action,
          });
        },
      });

      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      // --- added case ---
      await ctx.repositoryManager.addOrchestratorSession(registered.id, session.id);

      expect(captured).toHaveLength(1);
      const addWirePayload = JSON.parse(JSON.stringify(captured[0]));
      const addParsed = v.safeParse(AppServerMessageSchema, addWirePayload);

      expect(addParsed.success).toBe(true);
      if (!addParsed.success) {
        throw new Error(
          `safeParse failed unexpectedly (added case): ${JSON.stringify(addParsed.issues.map((i) => i.message))}`,
        );
      }
      if (addParsed.output.type !== 'orchestrator-designation-changed') {
        throw new Error(`Expected orchestrator-designation-changed, got: ${addParsed.output.type}`);
      }
      expect(addParsed.output.repositoryId).toBe(registered.id);
      expect(addParsed.output.orchestratorSessionIds).toEqual([session.id]);
      expect(addParsed.output.changedSessionId).toBe(session.id);
      expect(addParsed.output.action).toBe('added');

      // --- removed case ---
      const removeResult = await ctx.repositoryManager.removeOrchestratorSession(registered.id, session.id);
      expect(removeResult.removed).toBe(true);

      expect(captured).toHaveLength(2);
      const removeWirePayload = JSON.parse(JSON.stringify(captured[1]));
      const removeParsed = v.safeParse(AppServerMessageSchema, removeWirePayload);

      expect(removeParsed.success).toBe(true);
      if (!removeParsed.success) {
        throw new Error(
          `safeParse failed unexpectedly (removed case): ${JSON.stringify(removeParsed.issues.map((i) => i.message))}`,
        );
      }
      if (removeParsed.output.type !== 'orchestrator-designation-changed') {
        throw new Error(`Expected orchestrator-designation-changed, got: ${removeParsed.output.type}`);
      }
      // `orchestratorSessionIds` is required (not optional/nullable), and
      // the removed case must produce a real `[]`, not an absent key.
      expect('orchestratorSessionIds' in removeParsed.output).toBe(true);
      expect(removeParsed.output.orchestratorSessionIds).toEqual([]);
      expect(removeParsed.output.changedSessionId).toBe(session.id);
      expect(removeParsed.output.action).toBe('removed');
    });
  });
});

/**
 * REST-boundary tests for the add/remove routes themselves (Issue #1716).
 * The describe blocks above already guard the WIRE-SCHEMA round trip
 * (RepositoryManager -> JSON -> AppServerMessageSchema.safeParse) for the
 * fields these routes mutate; they never drive the REST routes
 * (`POST` / `DELETE /api/sessions/:id/orchestrator-designation`)
 * themselves. This block closes that gap by driving the real Hono app the
 * same way `restart-all-agents-boundary.test.ts` does: `createTestApp(ctx)`
 * + `app.request(...)`, asserting both the response body AND (via a real
 * `ctx.repositoryManager.getRepository(...)` re-read) the server-side state
 * change the response claims happened.
 *
 * There is no valibot schema on this route (same genre as
 * `restart-all-agents-boundary.test.ts` -- a REST JSON response, not a
 * WebSocket app-message), so the client's hand-written response interfaces
 * (`packages/client/src/lib/api.ts`) are mirrored here as local TS
 * interfaces, kept in sync by convention rather than import (packages/client
 * is a Vite app, not a library package importable from packages/integration).
 */
interface AddOrchestratorDesignationResult {
  repositoryId: string;
  orchestratorSessionIds: string[];
}

interface RemoveOrchestratorDesignationResult {
  repositoryId: string;
  removed: boolean;
  orchestratorSessionIds: string[];
}

describe('REST /api/sessions/:id/orchestrator-designation (Issue #1716)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();

    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH_A}/.git/HEAD`]: 'ref: refs/heads/main',
      [`${TEST_REPO_PATH_B}/.git/HEAD`]: 'ref: refs/heads/main',
    });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function createWorktreeSession(ownerId: string, repositoryId: string, worktreeId: string) {
    return ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId,
        worktreeId,
        agentId: 'claude-code-builtin',
      },
      { createdBy: ownerId },
    );
  }

  it('POST adds this session to the set: 200 + { repositoryId, orchestratorSessionIds }, and the repository actually changes server-side', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await createWorktreeSession(owner.id, repository.id, 'main');

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AddOrchestratorDesignationResult;
    expect(body).toEqual({ repositoryId: repository.id, orchestratorSessionIds: [session.id] });

    // Not just a plausible-looking response: re-read the repository through
    // the real manager to confirm the designation actually persisted.
    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionIds).toEqual([session.id]);
  });

  it('POST is idempotent: a second POST from the same session returns 200 with the same set unchanged', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await createWorktreeSession(owner.id, repository.id, 'main');

    const app = await createTestApp(ctx);
    await app.request(`/api/sessions/${session.id}/orchestrator-designation`, { method: 'POST' });

    const res = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AddOrchestratorDesignationResult;
    expect(body).toEqual({ repositoryId: repository.id, orchestratorSessionIds: [session.id] });

    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionIds).toEqual([session.id]);
  });

  it('a second session POSTing results in a set with both present', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const sessionA = await createWorktreeSession(owner.id, repository.id, 'main');
    const sessionB = await createWorktreeSession(owner.id, repository.id, 'feature');

    const app = await createTestApp(ctx);
    await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, { method: 'POST' });
    const res = await app.request(`/api/sessions/${sessionB.id}/orchestrator-designation`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AddOrchestratorDesignationResult;
    expect(body.repositoryId).toBe(repository.id);
    // Set membership only, not array order: two real consecutive requests
    // can legitimately land the same `created_at` tick, at which point the
    // ordering tiebreak is session_id (a random UUID).
    expect(new Set(body.orchestratorSessionIds)).toEqual(new Set([sessionA.id, sessionB.id]));

    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(new Set(reread?.orchestratorSessionIds)).toEqual(new Set([sessionA.id, sessionB.id]));
  });

  it('DELETE removes one session, leaving the other: 200 + { removed: true, orchestratorSessionIds: [other] }', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const sessionA = await createWorktreeSession(owner.id, repository.id, 'main');
    const sessionB = await createWorktreeSession(owner.id, repository.id, 'feature');

    const app = await createTestApp(ctx);
    await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, { method: 'POST' });
    await app.request(`/api/sessions/${sessionB.id}/orchestrator-designation`, { method: 'POST' });

    const res = await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemoveOrchestratorDesignationResult;
    expect(body).toEqual({ repositoryId: repository.id, removed: true, orchestratorSessionIds: [sessionB.id] });

    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionIds).toEqual([sessionB.id]);
  });

  it('DELETE again on the same session is idempotent: 200 + { removed: false }, remaining designation untouched', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const sessionA = await createWorktreeSession(owner.id, repository.id, 'main');
    const sessionB = await createWorktreeSession(owner.id, repository.id, 'feature');

    const app = await createTestApp(ctx);
    await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, { method: 'POST' });
    await app.request(`/api/sessions/${sessionB.id}/orchestrator-designation`, { method: 'POST' });
    await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, { method: 'DELETE' });

    const res = await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemoveOrchestratorDesignationResult;
    expect(body).toEqual({ repositoryId: repository.id, removed: false, orchestratorSessionIds: [sessionB.id] });

    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionIds).toEqual([sessionB.id]);
  });

  it('rejects a non-worktree (quick) session with 400', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id', async () => {
    const app = await createTestApp(ctx);
    const res = await app.request('/api/sessions/no-such-session-id/orchestrator-designation', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
  });

  it('both the POST and DELETE response shapes survive a raw JSON round-trip (no valibot schema guards this route)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await createWorktreeSession(owner.id, repository.id, 'main');

    const app = await createTestApp(ctx);

    const postRes = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });
    expect(postRes.status).toBe(200);
    const postRoundTripped = JSON.parse(JSON.stringify(await postRes.json())) as Record<string, unknown>;
    expect(typeof postRoundTripped.repositoryId).toBe('string');
    expect(postRoundTripped.repositoryId).toBe(repository.id);
    expect(Array.isArray(postRoundTripped.orchestratorSessionIds)).toBe(true);
    expect(postRoundTripped.orchestratorSessionIds).toEqual([session.id]);

    const deleteRes = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    const deleteRoundTripped = JSON.parse(JSON.stringify(await deleteRes.json())) as Record<string, unknown>;
    expect(typeof deleteRoundTripped.repositoryId).toBe('string');
    expect(deleteRoundTripped.repositoryId).toBe(repository.id);
    expect(deleteRoundTripped.removed).toBe(true);
    expect(Array.isArray(deleteRoundTripped.orchestratorSessionIds)).toBe(true);
    expect(deleteRoundTripped.orchestratorSessionIds).toEqual([]);
  });
});
