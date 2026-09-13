/**
 * Client-Server Boundary Test: Repository.orchestratorSessionId /
 * issueTriggerLabels, and the orchestrator-designation-changed broadcast
 * (Issue #1643)
 *
 * Regression guard for the same failure shape as Issue #914 + #927
 * (`created-by-username-boundary.test.ts`): a field can be populated
 * server-side yet be silently stripped by `AppServerMessageSchema.safeParse`
 * on the client because the field is missing from the valibot schema.
 * Neither the server unit tests (which never cross the schema boundary) nor
 * the client unit tests (which use pre-built mock objects that bypass
 * parsing entirely) can catch this class of gap.
 *
 * This PR introduced TWO new wire surfaces that need the same guard:
 *
 *   1. `Repository.orchestratorSessionId` / `Repository.issueTriggerLabels`
 *      -- new optional fields on the existing `Repository` shape, riding
 *      along on every `repository-created` / `repository-updated` /
 *      `repositories-sync` broadcast.
 *   2. `orchestrator-designation-changed` -- a brand-new message variant
 *      fired specifically when `RepositoryManager.setOrchestratorSession` /
 *      `clearOrchestratorSession` changes the designation.
 *
 * Both exercise the real chain:
 *   server RepositoryManager (real registerRepository / updateRepository /
 *     setOrchestratorSession / clearOrchestratorSession)
 *     -> the real broadcast shape (mirrors packages/server/src/websocket/
 *        routes.ts's `broadcastToApp` calls)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser used by
 *        packages/client/src/lib/app-websocket.ts:parseMessage)
 *   assert both fields (and the new message) survive end-to-end.
 *
 * Stashing `orchestratorSessionId` / `issueTriggerLabels` from
 * `RepositorySchema`, or `OrchestratorDesignationChangedSchema` from the
 * `AppServerMessageSchema` variant list (both in
 * packages/shared/src/schemas/app-server-message.ts), causes the
 * corresponding assertions below to fail.
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

describe('Client-Server Boundary: Repository orchestrator designation (Issue #1643)', () => {
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

  describe('Repository.orchestratorSessionId / issueTriggerLabels', () => {
    it('survive the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip when set', async () => {
      // 1. Seed a user + session, so setOrchestratorSession has a real
      //    session id to point at (the field's own semantics; unrelated to
      //    which repository it designates).
      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );

      // 2. Register a real repository through the real manager (the same
      //    path production uses -- this also populates the in-memory
      //    `this.repositories` map that later calls read from).
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      // 3. Set issueTriggerLabels via the generic update path, and
      //    orchestratorSessionId via the dedicated designation path -- both
      //    are real production entry points.
      const afterUpdate = await ctx.repositoryManager.updateRepository(registered.id, {
        issueTriggerLabels: 'bug, needs-triage',
      });
      expect(afterUpdate).not.toBeNull();

      const afterDesignation = await ctx.repositoryManager.setOrchestratorSession(
        registered.id,
        session.id,
      );
      expect(afterDesignation).not.toBeNull();

      // Sanity check: server-side state already carries both fields before
      // any wire / schema round-trip. If this fails, the regression is in
      // the manager, not the schema.
      const repository = afterDesignation as Repository;
      expect(repository.issueTriggerLabels).toBe('bug, needs-triage');
      expect(repository.orchestratorSessionId).toBe(session.id);

      // 4. Construct the actual wire payload shape a real broadcast would
      //    send (mirrors the server's
      //    `broadcastToApp({ type: 'repository-updated', repository: enriched })`
      //    in packages/server/src/websocket/routes.ts, whose `enriched`
      //    value is `withRepositoryRemote(repository)` -- reproduced here
      //    inline via the one required-but-derived field
      //    (`clonedSourceRepoPath`) rather than invoking `withRepositoryRemote`
      //    itself, since that helper shells out to real `git` and this test
      //    is only exercising the schema boundary).
      const wirePayload = JSON.parse(
        JSON.stringify({
          type: 'repository-updated',
          repository: { ...repository, clonedSourceRepoPath: null },
        }),
      );

      // 5. Apply the SAME parser the client uses in app-websocket.ts.
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

      const parsedRepository = parsed.output.repository;
      // The crucial assertions: both fields must survive the schema parser.
      // Without their schema entries, valibot's `v.strictObject` rejects the
      // WHOLE payload (an unrecognized field), so `parsed.success` would be
      // `false` rather than the fields merely being absent.
      expect('orchestratorSessionId' in parsedRepository).toBe(true);
      expect('issueTriggerLabels' in parsedRepository).toBe(true);
      expect(parsedRepository.orchestratorSessionId).toBe(session.id);
      expect(parsedRepository.issueTriggerLabels).toBe('bug, needs-triage');
    });

    it('survive the round-trip as null when never set (boundary case)', async () => {
      // A fresh repository that never had either field set. The mapper
      // (`toRepository` in packages/server/src/database/mappers.ts) reads
      // an unset column as `row.orchestrator_session_id ?? null`, i.e. the
      // in-memory / wire value is `null`, not `undefined`.
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_B);
      expect(registered.orchestratorSessionId).toBeUndefined();
      expect(registered.issueTriggerLabels).toBeUndefined();

      // Re-read through the real repository layer (mirrors what a fresh
      // process restart / SQLite read would produce) to get the mapper's
      // actual null-coalesced shape rather than the freshly-constructed
      // in-memory object's shape.
      const freshRead = await ctx.repositoryManager.updateRepository(registered.id, {
        description: 'no orchestrator designation set',
      });
      expect(freshRead).not.toBeNull();
      const repository = freshRead as Repository;
      expect(repository.orchestratorSessionId).toBeNull();
      expect(repository.issueTriggerLabels).toBeNull();

      const wirePayload = JSON.parse(
        JSON.stringify({
          type: 'repository-created',
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
      if (parsed.output.type !== 'repository-created') {
        throw new Error(`Expected repository-created, got: ${parsed.output.type}`);
      }

      const parsedRepository = parsed.output.repository;
      expect(parsedRepository.orchestratorSessionId ?? null).toBeNull();
      expect(parsedRepository.issueTriggerLabels ?? null).toBeNull();
    });
  });

  describe('orchestrator-designation-changed broadcast', () => {
    it('survives the round-trip for both the set (non-null) and clear (null) cases', async () => {
      const captured: unknown[] = [];
      const broadcastToApp = (msg: AppServerMessage): void => {
        captured.push(msg);
      };

      // Wire lifecycle callbacks the same way
      // packages/server/src/websocket/routes.ts does -- `createTestContext`
      // does not wire `RepositoryManager.setLifecycleCallbacks` by default,
      // so this test wires a minimal set (no-ops for the callbacks this
      // test doesn't exercise) plus the real capturing broadcast for the
      // two callbacks under test.
      ctx.repositoryManager.setLifecycleCallbacks({
        onRepositoryCreated: () => {},
        onRepositoryUpdated: () => {},
        onRepositoryDeleted: () => {},
        onOrchestratorDesignationChanged: (repositoryId, sessionId) => {
          broadcastToApp({ type: 'orchestrator-designation-changed', repositoryId, sessionId });
        },
      });

      const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
      const session = await ctx.sessionManager.createSession(
        { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);

      // --- Set (non-null) case ---
      await ctx.repositoryManager.setOrchestratorSession(registered.id, session.id);

      expect(captured).toHaveLength(1);
      const setWirePayload = JSON.parse(JSON.stringify(captured[0]));
      const setParsed = v.safeParse(AppServerMessageSchema, setWirePayload);

      expect(setParsed.success).toBe(true);
      if (!setParsed.success) {
        throw new Error(
          `safeParse failed unexpectedly (set case): ${JSON.stringify(setParsed.issues.map((i) => i.message))}`,
        );
      }
      if (setParsed.output.type !== 'orchestrator-designation-changed') {
        throw new Error(`Expected orchestrator-designation-changed, got: ${setParsed.output.type}`);
      }
      expect(setParsed.output.repositoryId).toBe(registered.id);
      expect(setParsed.output.sessionId).toBe(session.id);

      // --- Clear (null) case ---
      const clearResult = await ctx.repositoryManager.clearOrchestratorSession(
        registered.id,
        session.id,
      );
      expect(clearResult.cleared).toBe(true);

      expect(captured).toHaveLength(2);
      const clearWirePayload = JSON.parse(JSON.stringify(captured[1]));
      const clearParsed = v.safeParse(AppServerMessageSchema, clearWirePayload);

      expect(clearParsed.success).toBe(true);
      if (!clearParsed.success) {
        throw new Error(
          `safeParse failed unexpectedly (clear case): ${JSON.stringify(clearParsed.issues.map((i) => i.message))}`,
        );
      }
      if (clearParsed.output.type !== 'orchestrator-designation-changed') {
        throw new Error(`Expected orchestrator-designation-changed, got: ${clearParsed.output.type}`);
      }
      // `sessionId` on this schema is `v.nullable(v.string())`, NOT
      // `v.optional` -- the clear case must produce a real `null`, not an
      // absent key. `'sessionId' in parsedOutput` distinguishes the two.
      expect('sessionId' in clearParsed.output).toBe(true);
      expect(clearParsed.output.sessionId).toBeNull();
    });
  });
});

/**
 * REST-boundary tests for the raise/clear routes themselves (Issue #1643
 * Part 2). The describe block above already guards the WIRE-SCHEMA round
 * trip (RepositoryManager -> JSON -> AppServerMessageSchema.safeParse) for
 * the fields these routes mutate; it never drives the REST routes
 * (`POST` / `DELETE /api/sessions/:id/orchestrator-designation`) themselves.
 * This block closes that gap by driving the real Hono app the same way
 * `restart-all-agents-boundary.test.ts` does: `createTestApp(ctx)` +
 * `app.request(...)`, asserting both the response body AND (via a real
 * `ctx.repositoryManager.getRepository(...)` re-read) the server-side state
 * change the response claims happened.
 *
 * There is no valibot schema on this route (same genre as
 * `restart-all-agents-boundary.test.ts` -- a REST JSON response, not a
 * WebSocket app-message), so the client's hand-written
 * `raiseOrchestratorDesignation` response interface
 * (`packages/client/src/lib/api.ts`) is mirrored here as a local TS
 * interface, kept in sync by convention rather than import (packages/client
 * is a Vite app, not a library package importable from packages/integration).
 */
interface RaiseOrchestratorDesignationResult {
  repositoryId: string;
  orchestratorSessionId: string;
}

describe('REST /api/sessions/:id/orchestrator-designation', () => {
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

  it('raises the flag: 200 + { repositoryId, orchestratorSessionId }, and the repository actually changes server-side', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RaiseOrchestratorDesignationResult;
    expect(body).toEqual({ repositoryId: repository.id, orchestratorSessionId: session.id });

    // Not just a plausible-looking response: re-read the repository through
    // the real manager to confirm the designation actually moved.
    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionId).toBe(session.id);
  });

  it('clears the flag when the caller is the current holder: 200 + { repositoryId, cleared: true }, repository reverts to null', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);
    const raiseRes = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });
    expect(raiseRes.status).toBe(200);

    const clearRes = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'DELETE',
    });
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { repositoryId: string; cleared: boolean };
    expect(body).toEqual({ repositoryId: repository.id, cleared: true });

    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionId).toBeNull();
  });

  it('stale clear from a non-holder session is a no-op: 200 + { cleared: false }, the flag is unmoved', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const sessionA = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );
    const sessionB = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId: repository.id,
        worktreeId: 'feature',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);

    // Session A raises the flag; it never passes through session B.
    const raiseRes = await app.request(`/api/sessions/${sessionA.id}/orchestrator-designation`, {
      method: 'POST',
    });
    expect(raiseRes.status).toBe(200);

    // Session B (never held the flag) attempts to clear it.
    const clearRes = await app.request(`/api/sessions/${sessionB.id}/orchestrator-designation`, {
      method: 'DELETE',
    });
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { repositoryId: string; cleared: boolean };
    expect(body).toEqual({ repositoryId: repository.id, cleared: false });

    // The flag must not have moved or cleared -- still session A's.
    const reread = ctx.repositoryManager.getRepository(repository.id);
    expect(reread?.orchestratorSessionId).toBe(sessionA.id);
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

  it('response shape survives a raw JSON round-trip (no valibot schema guards this route)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');
    const repository = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH_A);
    const session = await ctx.sessionManager.createSession(
      {
        type: 'worktree',
        locationPath: TEST_REPO_PATH_A,
        repositoryId: repository.id,
        worktreeId: 'main',
        agentId: 'claude-code-builtin',
      },
      { createdBy: owner.id },
    );

    const app = await createTestApp(ctx);
    const res = await app.request(`/api/sessions/${session.id}/orchestrator-designation`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    // Round-trip through raw JSON (mirrors the actual HTTP wire step) rather
    // than trusting the already-parsed `res.json()` shape.
    const roundTripped = JSON.parse(JSON.stringify(await res.json())) as Record<string, unknown>;

    expect(typeof roundTripped.repositoryId).toBe('string');
    expect(roundTripped.repositoryId).toBe(repository.id);
    expect(typeof roundTripped.orchestratorSessionId).toBe('string');
    expect(roundTripped.orchestratorSessionId).toBe(session.id);
  });
});
