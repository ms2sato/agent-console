/**
 * Client-Server Boundary Test: Repository.sharedAccountUsername
 * (shared-accounts design, Release 1).
 *
 * Regression guard for the same failure shape as Issue #914 + #927
 * (`created-by-username-boundary.test.ts`): a derived field can be
 * populated server-side yet be silently stripped by
 * `AppServerMessageSchema.safeParse` on the client because the field is
 * missing from the valibot schema. Neither the server unit tests (which
 * never cross the schema boundary) nor the client unit tests (which use
 * pre-built mock objects that bypass parsing entirely) can catch this class
 * of gap.
 *
 * This exercises the real chain:
 *   server SqliteSharedAccountRepository.register (real row)
 *     -> RepositoryManager.updateRepository({ sharedAccountUserId })
 *        (real resolution of the bound account's username, via
 *        SqliteRepositoryRepository's join)
 *     -> (a) the plain-object REST shape, round-tripped through
 *        JSON.parse(JSON.stringify(...)) (simulating the REST
 *        serialize/deserialize boundary)
 *     -> (b) the real `repository-updated` broadcast shape
 *        (mirrors packages/server/src/websocket/routes.ts's
 *        broadcastToApp calls) -> JSON serialize (wire transmission
 *        simulation) -> AppServerMessageSchema.safeParse (the same parser
 *        used by packages/client/src/lib/app-websocket.ts:parseMessage)
 *   assert `sharedAccountUsername` survives both.
 *
 * Stashing the `sharedAccountUsername: v.optional(v.nullable(v.string()))`
 * entry from `packages/shared/src/schemas/app-server-message.ts`
 * RepositorySchema causes assertion (b) below to fail.
 *
 * The route-level test (PATCH /api/repositories/:id resolving
 * `sharedAccountUsername` -> `sharedAccountUserId`) is item 5's job
 * (packages/server/src/routes/__tests__/repositories.test.ts); this test
 * goes through `RepositoryManager.updateRepository` directly with the
 * already-resolved `sharedAccountUserId`, the same shape the route produces
 * after its own resolution step.
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

const TEST_REPO_PATH = '/test/repo-shared-account';

describe('Client-Server Boundary: Repository.sharedAccountUsername (shared-accounts Release 1)', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();

    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the REST serialize/deserialize boundary and the WS repository-updated broadcast schema', async () => {
    // 1. Register a shared account and bind a repository to it, through the
    //    real repositories (not through the HTTP routes -- the route's own
    //    username->id resolution is covered separately, see this file's
    //    header comment).
    const sharedUser = await ctx.userRepository.upsertByOsUid(99001, 'shared-bot', '/home/shared-bot');
    await ctx.sharedAccountRepository.register(sharedUser.id, null);

    const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    expect(registered.sharedAccountUsername ?? null).toBeNull();

    const updated = await ctx.repositoryManager.updateRepository(registered.id, {
      sharedAccountUserId: sharedUser.id,
    });
    expect(updated).not.toBeNull();
    expect(updated!.sharedAccountUsername).toBe('shared-bot');

    // 2. REST shape: a plain JSON.parse(JSON.stringify(...)) round-trip,
    //    simulating the REST serialize/deserialize boundary.
    const restRoundTrip = JSON.parse(JSON.stringify(updated));
    expect(restRoundTrip.sharedAccountUsername).toBe('shared-bot');

    // 3. WS broadcast shape: the real repository-updated message shape ->
    //    JSON wire -> AppServerMessageSchema.safeParse (the client parser).
    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'repository-updated',
        repository: { ...updated, clonedSourceRepoPath: null },
      }),
    );
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`);
    }
    if (parsed.output.type !== 'repository-updated') {
      throw new Error(`Expected repository-updated, got: ${parsed.output.type}`);
    }

    // The crucial assertion: the field must survive the schema parser.
    // Without the schema entry, valibot's v.strictObject rejects the WHOLE
    // payload (an unrecognized field), so parsed.success would be false
    // rather than the field merely being missing.
    expect('sharedAccountUsername' in parsed.output.repository).toBe(true);
    expect(parsed.output.repository.sharedAccountUsername).toBe('shared-bot');
  });

  it('round-trips as null when unbound', async () => {
    const registered = await ctx.repositoryManager.registerRepository(TEST_REPO_PATH);
    expect(registered.sharedAccountUsername ?? null).toBeNull();

    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'repository-created',
        repository: { ...registered, clonedSourceRepoPath: null },
      }),
    );
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`);
    }
    if (parsed.output.type !== 'repository-created') {
      throw new Error(`Expected repository-created, got: ${parsed.output.type}`);
    }
    expect(parsed.output.repository.sharedAccountUsername ?? null).toBeNull();
  });
});
