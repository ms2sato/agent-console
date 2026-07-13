/**
 * Client-Server Boundary Test: EmbeddedAgentDefinition.instructions (Issue #1072, CLAUDE.md Q10)
 *
 * Regression guard for the wire boundary of the `instructions?: string[]`
 * field added to `EmbeddedAgentDefinition`. valibot's default object parse
 * silently strips unknown fields, so an `EmbeddedAgentDefinitionSchema`
 * missing an `instructions` entry would drop the field from the
 * `embedded-agent-created` / `embedded-agent-updated` app-sync messages with
 * no compile / runtime error until manual QA notices the gap. Neither server
 * unit tests (which never cross the schema boundary) nor frontend mock-factory
 * tests (which inject pre-built definition objects) can catch that.
 *
 * This boundary test exercises the real chain:
 *   ctx.embeddedAgentManager.createEmbeddedAgent({ instructions: [...] })
 *     -> the same definition object the manager broadcasts via
 *        onEmbeddedAgentCreated({ type: 'embedded-agent-created', embeddedAgent })
 *     -> JSON serialize (wire transmission simulation)
 *     -> AppServerMessageSchema.safeParse (the same parser the client uses)
 *   assert `instructions` survives end-to-end, including the empty-array shape.
 *
 * Removing the `instructions` entry from `EmbeddedAgentDefinitionSchema` in
 * packages/shared/src/schemas/embedded-agent.ts causes this test to fail
 * (the field is stripped by safeParse).
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

describe('Client-Server Boundary: EmbeddedAgentDefinition.instructions', () => {
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
    const owner = await ctx.userRepository.upsertByOsUid(54321, 'owner', '/home/owner');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Ollama qwen3',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
        instructions: ['docs/local-note.md', 'CONTRIBUTING.md'],
      },
      owner.id,
    );
    expect(def.instructions).toEqual(['docs/local-note.md', 'CONTRIBUTING.md']);

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-created', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(
        `safeParse failed unexpectedly: ${JSON.stringify(parsed.issues.map((i) => i.message))}`,
      );
    }
    if (parsed.output.type !== 'embedded-agent-created') {
      throw new Error(`Expected embedded-agent-created, got: ${parsed.output.type}`);
    }

    // The crucial assertion: `instructions` must survive the schema parser,
    // not just be undefined-and-therefore-absent.
    expect('instructions' in parsed.output.embeddedAgent).toBe(true);
    expect(parsed.output.embeddedAgent.instructions).toEqual([
      'docs/local-note.md',
      'CONTRIBUTING.md',
    ]);
  });

  it('an explicit empty instructions array survives the round-trip (not collapsed to undefined)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54322, 'owner2', '/home/owner2');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'No Instructions',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
        instructions: [],
      },
      owner.id,
    );
    expect(def.instructions).toEqual([]);

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-updated', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'embedded-agent-updated') {
      throw new Error('expected a successful embedded-agent-updated parse');
    }
    expect(parsed.output.embeddedAgent.instructions).toEqual([]);
  });

  it('absent instructions stays undefined through the round-trip (no spurious default)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(54323, 'owner3', '/home/owner3');

    const def = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: 'Default',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      },
      owner.id,
    );
    expect(def.instructions).toBeUndefined();

    const wirePayload = JSON.parse(
      JSON.stringify({ type: 'embedded-agent-created', embeddedAgent: def }),
    );

    const parsed = v.safeParse(AppServerMessageSchema, wirePayload);

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.output.type !== 'embedded-agent-created') {
      throw new Error('expected a successful embedded-agent-created parse');
    }
    expect(parsed.output.embeddedAgent.instructions).toBeUndefined();
  });
});
