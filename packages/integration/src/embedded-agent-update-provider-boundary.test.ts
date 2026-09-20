/**
 * Client-Server Boundary Test: `UpdateEmbeddedAgentRequestSchema.provider`
 * union (CodeRabbit Major, `packages/shared/src/schemas/embedded-agent.ts:255`,
 * flagged against 27313ed0/c52f79a7's rescope of Issue #1779).
 *
 * `UpdateEmbeddedAgentRequestSchema` stays flat (a PATCH carries no `engine`
 * discriminant), yet the two engines' `EmbeddedAgentDefinition.provider`
 * shapes disagree (`openai-api` requires `baseUrl`; `claude-sdk` is
 * `{ model }` only, no provider secret ever crosses the server for that
 * engine). Before this fix, `provider` was typed to the openai-api shape
 * only, so a claude-sdk definition's own PATCH endpoint could never
 * legitimately update its `provider.model` -- a real, user-facing gap in
 * the KEEP half of the rescoped PR-1 (`'Task'` + the claude-sdk
 * create/update path), independent of the removed declared-mcpServers
 * scope.
 *
 * This is the integration test Q10 (pre-pr-completeness.md) calls for: a
 * unit test that calls `EmbeddedAgentManager.updateEmbeddedAgent` directly
 * does not prove the REAL REST route (`vValidator(UpdateEmbeddedAgentRequestSchema)`
 * at `packages/server/src/routes/embedded-agents.ts`) accepts the
 * claude-sdk-shaped payload at the wire boundary, nor that the response
 * actually carries the new model with no `baseUrl` leaking in anywhere.
 * This test drives the whole chain for real:
 *
 *   real HTTP POST /api/embedded-agents (engine: 'claude-sdk')
 *     -> real HTTP PATCH /api/embedded-agents/:id ({ provider: { model } })
 *     -> real HTTP GET /api/embedded-agents (read back via the list route,
 *        the only read endpoint this resource has)
 *   assert the new model landed and no `baseUrl` is present anywhere in
 *   either the PATCH response or the GET response.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';

import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';

import type { EmbeddedAgentDefinition } from '@agent-console/shared';

describe('Client-Server Boundary: UpdateEmbeddedAgentRequestSchema.provider union (claude-sdk PATCH)', () => {
  let ctx: AppContext;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('real REST round trip: POST create claude-sdk -> PATCH provider.model -> GET reflects the new model with no baseUrl anywhere', async () => {
    // 1. Create a claude-sdk definition through the real route.
    const createRes = await app.request('/api/embedded-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'claude-sdk',
        name: 'Claude via wire',
        provider: { model: 'claude-sonnet-5' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { embeddedAgent: created } = (await createRes.json()) as { embeddedAgent: EmbeddedAgentDefinition };
    expect(created.engine).toBe('claude-sdk');
    expect(created.provider).toEqual({ model: 'claude-sonnet-5' });

    // 2. PATCH provider.model through the real route with a bare
    //    { model } payload -- the exact shape that was previously
    //    rejected at the wire boundary (provider was typed openai-api-only).
    const patchRes = await app.request(`/api/embedded-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: { model: 'claude-opus-5' } }),
    });
    expect(patchRes.status).toBe(200);
    const { embeddedAgent: patched } = (await patchRes.json()) as { embeddedAgent: EmbeddedAgentDefinition };
    expect(patched.engine).toBe('claude-sdk');
    expect(patched.provider).toEqual({ model: 'claude-opus-5' });
    expect(JSON.stringify(patched).includes('baseUrl')).toBe(false);
    expect('baseUrl' in patched.provider).toBe(false);

    // 3. Read back via the list route (this resource has no GET /:id) and
    //    confirm the new model landed and no baseUrl leaked in anywhere in
    //    the response body.
    const listRes = await app.request('/api/embedded-agents');
    expect(listRes.status).toBe(200);
    const { embeddedAgents } = (await listRes.json()) as { embeddedAgents: EmbeddedAgentDefinition[] };
    const readBack = embeddedAgents.find((a) => a.id === created.id);
    expect(readBack).toBeDefined();
    expect(readBack?.engine).toBe('claude-sdk');
    expect(readBack?.provider).toEqual({ model: 'claude-opus-5' });
    expect('baseUrl' in (readBack?.provider ?? {})).toBe(false);

    // 4. Negative control (Q13's "a control that fails when the fact under
    //    test is false"): an openai-api-shaped PATCH against this SAME
    //    claude-sdk definition must still be rejected by the manager's
    //    engine-mismatch guard, surfaced as a 400 through the real route --
    //    confirming the wire-level acceptance above is specific to the
    //    correct shape, not a general relaxation of the endpoint.
    const mismatchRes = await app.request(`/api/embedded-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'should-be-rejected' },
      }),
    });
    expect(mismatchRes.status).toBe(400);

    // The rejected PATCH must not have mutated the definition.
    const listAfterMismatch = await app.request('/api/embedded-agents');
    const { embeddedAgents: afterMismatch } = (await listAfterMismatch.json()) as {
      embeddedAgents: EmbeddedAgentDefinition[];
    };
    const stillPatched = afterMismatch.find((a) => a.id === created.id);
    expect(stillPatched?.provider).toEqual({ model: 'claude-opus-5' });
  });
});
