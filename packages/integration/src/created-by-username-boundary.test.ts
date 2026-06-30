/**
 * Client-Server Boundary Test: Session.createdByUsername (Issue #914 + #927)
 *
 * Regression guard for the bug where `Session.createdByUsername` was emitted
 * by the server (via `SessionConverterService.toPublicSession`) but silently
 * stripped on the client by `AppServerMessageSchema.safeParse` because the
 * field was missing from the valibot schema. Neither the server unit tests
 * (which never crossed the schema boundary) nor the client unit tests
 * (which used pre-built mock sessions) caught the gap.
 *
 * This boundary test exercises the real chain:
 *   server SessionManager.createSession
 *     -> primes UsernameLookupService via UserRepository
 *     -> toPublicSession populates createdByUsername
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser used by
 *        packages/client/src/lib/app-websocket.ts:parseMessage)
 *   assert createdByUsername survives end-to-end.
 *
 * Stashing the `createdByUsername: v.optional(v.nullable(v.string()))` entry
 * from `packages/shared/src/schemas/app-server-message.ts` SessionBaseSchema
 * causes this test to fail (the field is stripped by safeParse).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema } from '@agent-console/shared';

describe('Client-Server Boundary: Session.createdByUsername', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip', async () => {
    // 1. Seed a user in the real UserRepository so UsernameLookupService.prime
    //    resolves the UUID to a username. upsertByOsUid returns the AuthUser
    //    with the generated UUID.
    const alice = await ctx.userRepository.upsertByOsUid(54321, 'alice', '/home/alice');
    expect(alice.username).toBe('alice');

    // 2. Create a session whose createdBy is alice's UUID. This routes through
    //    SessionManager.createSession -> primeUsernameCache -> toPublicSession,
    //    the same path production uses.
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: alice.id },
    );

    // Sanity check: server-side derivation already populated the field before
    // any wire / schema round-trip. If this fails, the regression is in the
    // server-side derivation, not the schema.
    expect(session.createdByUsername).toBe('alice');

    // 3. Construct the actual sessions-sync WebSocket payload shape (mirrors
    //    the server's broadcastToApp({ type: 'sessions-sync', ... })) and
    //    simulate wire transmission via JSON serialize / parse.
    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'sessions-sync',
        sessions: [session],
        activityStates: [],
      }),
    );

    // 4. Apply the SAME parser the client uses in app-websocket.ts. If the
    //    valibot SessionBaseSchema omits createdByUsername, safeParse will
    //    succeed but the field is stripped from the output.
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    // 5. Assertions: success + field survives all the way to the client.
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'sessions-sync') {
      throw new Error(`Expected sessions-sync, got: ${parsed.output.type}`);
    }
    expect(parsed.output.sessions).toHaveLength(1);
    const parsedSession = parsed.output.sessions[0];
    // The crucial assertion: the field must survive the schema parser.
    // Without the schema entry, parsedSession would not have the property
    // and this would fail with `undefined`.
    expect('createdByUsername' in parsedSession).toBe(true);
    expect(parsedSession.createdByUsername).toBe('alice');
  });

});
