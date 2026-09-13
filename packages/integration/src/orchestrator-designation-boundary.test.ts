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
