/**
 * Client-Server Boundary Test: EmbeddedAgentDefinition.windowObservations
 * (window-declaration drift register; pre-pr-completeness Q10).
 *
 * `windowObservations` is a DERIVED field: the server composes it onto the
 * served definition from an in-memory register, so a unit test that injects
 * a pre-built definition (or asserts the raw object handed to a mock
 * broadcast) never crosses the strict wire schema. This exercises the real
 * chain:
 *
 *   ctx.embeddedAgentManager.recordWindowObservation(...)        (the feed seam)
 *     -> the real onEmbeddedAgentUpdated lifecycle callback, wired to
 *        broadcastToApp exactly as websocket/routes.ts wires it
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the parser the client uses)
 *   and, over real HTTP, GET /api/embedded-agents and PATCH
 *   /api/embedded-agents/:id (the clear), asserting the field survives the
 *   strict parse when present and parses as ABSENT when not.
 *
 * Removing the `windowObservations` entry from the definition schema in
 * packages/shared/src/schemas/embedded-agent.ts makes the present-case parse
 * fail (the strict object rejects the unknown key).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';

import { AppServerMessageSchema, type AppServerMessage } from '@agent-console/shared';

describe('Client-Server Boundary: EmbeddedAgentDefinition.windowObservations', () => {
  let ctx: AppContext;
  let broadcasts: AppServerMessage[];
  let ownerId: string;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
    broadcasts = [];
    // Mirrors websocket/routes.ts's production wiring, which createTestContext()
    // alone does not register.
    ctx.embeddedAgentManager.setLifecycleCallbacks({
      onEmbeddedAgentCreated: (embeddedAgent) => {
        broadcasts.push({ type: 'embedded-agent-created', embeddedAgent });
      },
      onEmbeddedAgentUpdated: (embeddedAgent) => {
        broadcasts.push({ type: 'embedded-agent-updated', embeddedAgent });
      },
      onEmbeddedAgentDeleted: (embeddedAgentId) => {
        broadcasts.push({ type: 'embedded-agent-deleted', embeddedAgentId });
      },
    });
    // The PATCH route is creator-gated: the creator must be the user the test
    // app authenticates as (SingleUserMode's server-process user).
    const authUser = ctx.userMode.authenticate(() => undefined);
    if (!authUser) {
      throw new Error('expected SingleUserMode.authenticate() to always return a user');
    }
    ownerId = authUser.id;
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  function wire(message: unknown): unknown {
    return JSON.parse(JSON.stringify(message));
  }

  async function createDefinition() {
    return ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        engine: 'openai-api',
        name: 'Drift',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        contextWindowTokens: 32000,
      },
      ownerId,
    );
  }

  function parseUpdated(message: AppServerMessage) {
    const parsed = v.safeParse(AppServerMessageSchema, wire(message));
    if (!parsed.success) {
      throw new Error(`safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`);
    }
    if (parsed.output.type !== 'embedded-agent-updated') {
      throw new Error(`Expected embedded-agent-updated, got: ${parsed.output.type}`);
    }
    return parsed.output.embeddedAgent;
  }

  it('both kinds survive record -> broadcast -> JSON -> strict parse, with no worker or session identifiers', async () => {
    const def = await createDefinition();
    broadcasts.length = 0;

    ctx.embeddedAgentManager.recordWindowObservation(def.id, { kind: 'providerStated', tokens: 131072 });
    ctx.embeddedAgentManager.recordWindowObservation(def.id, { kind: 'apparentClamp' });

    expect(broadcasts).toHaveLength(2);
    const parsed = parseUpdated(broadcasts[1]);
    expect(parsed.windowObservations?.providerStated?.tokens).toBe(131072);
    expect(typeof parsed.windowObservations?.providerStated?.observedAt).toBe('string');
    expect(typeof parsed.windowObservations?.apparentClamp?.observedAt).toBe('string');
    expect(Object.keys(parsed.windowObservations ?? {}).sort()).toEqual(['apparentClamp', 'providerStated']);
  });

  it('a repeated reading does not broadcast a second embedded-agent-updated', async () => {
    const def = await createDefinition();
    broadcasts.length = 0;

    ctx.embeddedAgentManager.recordWindowObservation(def.id, { kind: 'apparentClamp' });
    ctx.embeddedAgentManager.recordWindowObservation(def.id, { kind: 'apparentClamp' });

    expect(broadcasts.filter((b) => b.type === 'embedded-agent-updated')).toHaveLength(1);
  });

  it('an unobserved definition parses as ABSENT (no key, no spurious default)', async () => {
    const def = await createDefinition();
    broadcasts.length = 0;

    await ctx.embeddedAgentManager.updateEmbeddedAgent(def.id, { name: 'Renamed' });

    const parsed = parseUpdated(broadcasts[0]);
    expect('windowObservations' in parsed).toBe(false);
  });

  it('GET /api/embedded-agents serves the observation over real HTTP and PATCH of contextWindowTokens clears it', async () => {
    const def = await createDefinition();
    const app = await createTestApp(ctx);
    ctx.embeddedAgentManager.recordWindowObservation(def.id, { kind: 'providerStated', tokens: 8000 });

    const listRes = await app.request('/api/embedded-agents');
    const list = (await listRes.json()) as {
      embeddedAgents: Array<{ id: string; windowObservations?: { providerStated?: { tokens: number } } }>;
    };
    expect(list.embeddedAgents.find((a) => a.id === def.id)?.windowObservations?.providerStated?.tokens).toBe(8000);

    broadcasts.length = 0;
    const patchRes = await app.request(`/api/embedded-agents/${def.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextWindowTokens: 8000 }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { embeddedAgent: { windowObservations?: unknown } };
    expect(patched.embeddedAgent.windowObservations).toBeUndefined();

    expect('windowObservations' in parseUpdated(broadcasts[0])).toBe(false);
    const after = (await (await app.request('/api/embedded-agents')).json()) as {
      embeddedAgents: Array<{ id: string; windowObservations?: unknown }>;
    };
    expect(after.embeddedAgents.find((a) => a.id === def.id)?.windowObservations).toBeUndefined();
  });
});
