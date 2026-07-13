/**
 * Client-Server Boundary Test: Session.initialPromptDelivered (Issue #1068,
 * CLAUDE.md pre-pr-completeness.md Q10)
 *
 * `Session.initialPromptDelivered` is a session-level flag set server-side
 * (by `EmbeddedAgentWorkerService.maybeDeliverInitialPrompt`) once the
 * session's `initialPrompt` has been delivered as the initial embedded-agent
 * worker's first user message. `SessionBaseSchema` in
 * `packages/shared/src/schemas/app-server-message.ts` is a `v.strictObject`,
 * so a TS-only field addition (without the matching valibot schema entry)
 * would make `AppServerMessageSchema.safeParse` REJECT the entire
 * `sessions-sync` payload outright (strict objects fail loud on unknown
 * keys) rather than silently stripping the field -- but it is still a wire
 * boundary this test guards mechanically rather than relying on manual QA.
 *
 * This boundary test exercises the real chain:
 *   server SessionManager.createSession (with initialPrompt)
 *     -> SessionConverterService.toPublicSession populates initialPromptDelivered
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser used by
 *        packages/client/src/lib/app-websocket.ts:parseMessage)
 *   assert initialPromptDelivered survives end-to-end, both when true and
 *   when undefined (never delivered).
 *
 * Removing the `initialPromptDelivered: v.optional(v.boolean())` entry from
 * `SessionBaseSchema` causes this test to fail (safeParse rejects the whole
 * payload since the session object then carries an unrecognized key).
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

describe('Client-Server Boundary: Session.initialPromptDelivered', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('survives the server -> JSON wire -> AppServerMessageSchema.safeParse round-trip when true', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin', initialPrompt: 'Do the thing' },
      { createdBy: owner.id },
    );

    // Re-read through the real production path (SessionManager.getSession ->
    // toPublicSession), then flip the flag as production does only after the
    // full subprocess ready-event round trip (EmbeddedAgentWorkerService.
    // maybeDeliverInitialPrompt, exercised end-to-end -- with polarity checks
    // -- by embedded-agent-worker-service.test.ts, which cannot spawn a real
    // subprocess through this integration harness). This boundary test's job
    // is the wire/schema layer specifically: does the field the server's real
    // toPublicSession shape carries survive AppServerMessageSchema.safeParse.
    const session = ctx.sessionManager.getSession(created.id);
    if (!session) {
      throw new Error('session not found after creation');
    }
    session.initialPromptDelivered = true;

    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'sessions-sync',
        sessions: [session],
        activityStates: [],
      }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'sessions-sync') {
      throw new Error(`Expected sessions-sync, got: ${parsed.output.type}`);
    }
    const parsedSession = parsed.output.sessions.find((s) => s.id === created.id);
    if (!parsedSession) {
      throw new Error('session missing from parsed sessions-sync payload');
    }
    expect('initialPromptDelivered' in parsedSession).toBe(true);
    expect(parsedSession.initialPromptDelivered).toBe(true);
  });

  it('survives the round-trip as undefined for a session that has not delivered its prompt', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path2', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );

    const session = ctx.sessionManager.getSession(created.id);
    if (!session) {
      throw new Error('session not found after creation');
    }
    expect(session.initialPromptDelivered).toBeUndefined();

    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'sessions-sync',
        sessions: [session],
        activityStates: [],
      }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'sessions-sync') {
      throw new Error(`Expected sessions-sync, got: ${parsed.output.type}`);
    }
    const parsedSession = parsed.output.sessions.find((s) => s.id === created.id);
    if (!parsedSession) {
      throw new Error('session missing from parsed sessions-sync payload');
    }
    expect(parsedSession.initialPromptDelivered).toBeUndefined();
  });
});
