/**
 * Client-Server Boundary Test: EmbeddedAgentWorker.contextWindowTokens (Issue #1556)
 *
 * Regression guard for the wire boundary of the server-resolved
 * `contextWindowTokens` field on `EmbeddedAgentWorker`. Before this Issue,
 * the value was read client-side directly from the embedded-agent
 * DEFINITION registry; this test proves the SERVER now composes it onto the
 * wire object, and that it survives the same
 * server -> JSON wire -> AppServerMessageSchema.safeParse round-trip that
 * `embedded-agent-worker-boundary.test.ts` exercises for the worker type
 * itself.
 *
 * This is the wire-crossing case pre-pr-completeness.md Q10 requires:
 * `EmbeddedAgentWorkerSchema` is a `v.strictObject`, so a schema-only miss
 * (type updated, schema field forgotten) would silently strip the field
 * with no error on either side -- exactly the gap an in-process unit test
 * of `resolveEffectiveContextWindow` or `toPublicWorker` cannot see, because
 * neither of those crosses `JSON.stringify` + `v.safeParse`.
 *
 * Exercises the real chain:
 *   ctx.embeddedAgentManager.createEmbeddedAgent({ contextWindowTokens })
 *     -> ctx.sessionManager.createSession
 *     -> ctx.sessionManager.createWorker({ type: 'embedded-agent', ... })
 *     -> re-read the public session (toPublicWorker resolves the window via
 *        the real getEmbeddedAgent wiring threaded in session-manager.ts)
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses)
 *   assert contextWindowTokens equals the definition's declared value.
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

describe('Client-Server Boundary: EmbeddedAgentWorker.contextWindowTokens', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('carries the definition-declared window through server composition and the wire parse', async () => {
    // 1. Seed a user so createSession satisfies the created_by FK.
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');

    // 2. Create an embedded-agent definition through the real manager, with
    //    a declared context window.
    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        contextWindowTokens: 40_000,
      },
      owner.id,
    );
    expect(def.contextWindowTokens).toBe(40_000);

    // 3. Create a session and attach a (deactivated) embedded-agent worker.
    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );

    const worker = await ctx.sessionManager.createWorker(created.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });
    expect(worker).not.toBeNull();

    // 4. Re-read the public session so it carries the worker as
    //    toPublicWorker serializes it (contextWindowTokens resolved via the
    //    real getEmbeddedAgentFn wiring, not a test stub).
    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after worker creation');
    }
    const embeddedWorkerBefore = session.workers.find((w) => w.type === 'embedded-agent');
    expect(embeddedWorkerBefore).toBeDefined();
    expect(
      embeddedWorkerBefore?.type === 'embedded-agent' && embeddedWorkerBefore.contextWindowTokens,
    ).toBe(40_000);

    // 5. Build the sessions-sync payload and simulate wire transmission.
    const wirePayload = JSON.parse(
      JSON.stringify({
        type: 'sessions-sync',
        sessions: [session],
        activityStates: [],
      }),
    );

    // 6. Apply the SAME parser the client uses in app-websocket.ts.
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

    // 7. The crucial assertion: contextWindowTokens survived JSON wire +
    //    strict-schema parse, equal to the definition's declared value.
    const parsedWorker = parsedSession.workers.find((w) => w.type === 'embedded-agent');
    expect(parsedWorker).toBeDefined();
    if (!parsedWorker || parsedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker stripped by the schema parser');
    }
    expect(parsedWorker.contextWindowTokens).toBe(40_000);
  });

  it('yields contextWindowTokens: undefined when the definition declares no window', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54323, 'owner3', '/home/owner3');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3 (no window)',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      },
      owner.id,
    );
    expect(def.contextWindowTokens).toBeUndefined();

    const created = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path2', agentId: 'claude-code-builtin' },
      { createdBy: owner.id },
    );
    await ctx.sessionManager.createWorker(created.id, {
      type: 'embedded-agent',
      embeddedAgentId: def.id,
    });

    const session = ctx.sessionManager.getAllSessions().find((s) => s.id === created.id);
    if (!session) {
      throw new Error('session not found after worker creation');
    }

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'sessions-sync', sessions: [session], activityStates: [] }),
    );
    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'sessions-sync') {
      throw new Error('unexpected parse failure');
    }

    const parsedSession = parsed.output.sessions.find((s) => s.id === created.id);
    const parsedWorker = parsedSession?.workers.find((w) => w.type === 'embedded-agent');
    if (!parsedWorker || parsedWorker.type !== 'embedded-agent') {
      throw new Error('embedded-agent worker missing from parsed payload');
    }
    expect(parsedWorker.contextWindowTokens).toBeUndefined();
  });
});
