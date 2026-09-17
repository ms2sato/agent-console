/**
 * Client-Server Boundary Test: `cleanup:definition-memory` job (epic #1636
 * Phase 2 PR-3b, Issue #1709).
 *
 * Exercises the REAL chain end to end for deleting an embedded-agent
 * definition:
 *
 *   real HTTP POST /api/embedded-agents (creates the definition through the
 *   real route -- `packages/server/src/routes/embedded-agents.ts`)
 *     -> real HTTP DELETE /api/embedded-agents/:id
 *     -> real `EmbeddedAgentManager.deleteEmbeddedAgent` enqueues a real
 *        `cleanup:definition-memory` job on the real `JobQueue`
 *     -> the real job handler (`packages/server/src/jobs/handlers.ts`)
 *        removes every real memory directory
 *        (`buildDefinitionMemoryCleanupTargets`,
 *        `packages/server/src/lib/session-data-path.ts`) for that
 *        definition, across BOTH slug shapes plus the quick-session shape
 *
 * This is the integration test Q10 (pre-pr-completeness.md) calls for: the
 * job's payload has no valibot schema pair (job payloads are JSON.parsed
 * straight into the handler with no wire-boundary parse step -- see
 * `CleanupDefinitionMemoryPayload`'s own doc comment), but it DOES cross a
 * client/server contract surface (the client's `JOB_TYPE_LABELS` map in
 * `packages/client/src/routes/jobs/index.tsx` must have an entry for every
 * `JobType`, checked at typecheck time via `Record<JobType, string>`
 * exhaustiveness -- see the note on that assertion below for why this test
 * does not import that route module directly). A unit test that calls
 * `EmbeddedAgentManager.deleteEmbeddedAgent` or the job handler directly
 * does not prove the REAL REST route wiring enqueues the job with the
 * right payload shape, nor that the real filesystem walk removes exactly
 * the right directories -- this test drives both ends for real.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { access, mkdir } from 'node:fs/promises';
import type { Hono } from 'hono';

import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestApp,
  getTestConfigDir,
} from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext, AppBindings } from '@agent-console/server/src/app-context';
import {
  computeSessionDataBaseDir,
  computeQuickCwdSlug,
} from '@agent-console/server/src/lib/session-data-path';
import { SessionDataPathResolver } from '@agent-console/server/src/lib/session-data-path-resolver';

import {
  JOB_TYPES,
  type CleanupDefinitionMemoryPayload,
  type EmbeddedAgentDefinition,
} from '@agent-console/shared';

/**
 * Poll `ctx.jobQueue.getJobs({ type: ... })` for a job whose parsed payload
 * matches `definitionId`, until it reaches a terminal status. Fails fast on
 * `stalled` rather than burning the whole poll budget -- mirrors
 * `packages/server/src/__tests__/app-context.test.ts`'s "process an
 * enqueued worktree:delete job end-to-end" polling shape.
 */
async function pollForDefinitionMemoryJob(
  ctx: AppContext,
  definitionId: string,
  timeoutMs = 3000,
): Promise<{ id: string; type: string; status: string; payload: string }> {
  const start = Date.now();
  for (;;) {
    const candidates = await ctx.jobQueue.getJobs({ type: JOB_TYPES.CLEANUP_DEFINITION_MEMORY });
    const match = candidates.find((job) => {
      try {
        return (JSON.parse(job.payload) as CleanupDefinitionMemoryPayload).definitionId === definitionId;
      } catch {
        return false;
      }
    });
    if (match) {
      if (match.status === 'stalled') {
        throw new Error(`cleanup:definition-memory job stalled: ${match.last_error}`);
      }
      if (match.status === 'completed') {
        return match;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('pollForDefinitionMemoryJob timed out waiting for a completed job');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('Client-Server Boundary: cleanup:definition-memory job (Issue #1709)', () => {
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

  it('DELETE /api/embedded-agents/:id enqueues a real cleanup:definition-memory job that removes both slug shapes and the quick shape, leaving another definition intact', async () => {
    // Mutation measured: removing the `this.jobQueue.enqueue(...)` call in
    // `EmbeddedAgentManager.deleteEmbeddedAgent`
    // (packages/server/src/services/embedded-agent-manager.ts) fails this
    // test -- `pollForDefinitionMemoryJob` times out (no job is ever
    // enqueued) and none of the planted directories are removed.
    const createRes = await app.request('/api/embedded-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Definition to delete',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { embeddedAgent } = (await createRes.json()) as { embeddedAgent: EmbeddedAgentDefinition };
    const definitionId = embeddedAgent.id;

    // A different definition's memory dir, under the SAME flat slug, must
    // survive. Not created through the real route -- the cleanup walk only
    // cares about the literal id segment in the path, not FK-validity of
    // the id in the embedded_agents table.
    const otherDefinitionId = 'other-untouched-definition-id';

    const configDir = getTestConfigDir();
    const flatBase = computeSessionDataBaseDir(configDir, 'repository', 'flat');
    const nestedBase = computeSessionDataBaseDir(configDir, 'repository', 'org/repo');
    const quickBase = computeSessionDataBaseDir(configDir, 'quick', null);
    const flatResolver = new SessionDataPathResolver(flatBase);
    const nestedResolver = new SessionDataPathResolver(nestedBase);
    const quickResolver = new SessionDataPathResolver(quickBase);
    const cwdSlug = computeQuickCwdSlug('/some/quick/session/cwd');

    const flatTarget = flatResolver.getMemoryDir(definitionId, { kind: 'repository' });
    const nestedTarget = nestedResolver.getMemoryDir(definitionId, { kind: 'repository' });
    const quickTarget = quickResolver.getMemoryDir(definitionId, { kind: 'quick', cwdSlug });
    const otherTarget = flatResolver.getMemoryDir(otherDefinitionId, { kind: 'repository' });

    await mkdir(flatTarget, { recursive: true });
    await mkdir(nestedTarget, { recursive: true });
    await mkdir(quickTarget, { recursive: true });
    await mkdir(otherTarget, { recursive: true });

    const deleteRes = await app.request(`/api/embedded-agents/${definitionId}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ success: true });

    const job = await pollForDefinitionMemoryJob(ctx, definitionId);

    expect(job.type).toBe('cleanup:definition-memory');
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    expect(payload).toEqual({ definitionId });
    expect('requestUsername' in payload).toBe(false);

    expect(await pathExists(flatTarget)).toBe(false);
    expect(await pathExists(nestedTarget)).toBe(false);
    expect(await pathExists(quickTarget)).toBe(false);
    // The other definition's memory dir must survive.
    expect(await pathExists(otherTarget)).toBe(true);

    // Client-label cross-package contract (the client half of Q10): every
    // `JobType` must have a `JOB_TYPE_LABELS` entry
    // (`packages/client/src/routes/jobs/index.tsx`, exported for exactly
    // this purpose). Importing that module here would load a TanStack
    // Router `createFileRoute(...)` call as an import-time side effect,
    // which is unnecessary risk under bun:test for a fact `tsc` already
    // proves structurally: `JOB_TYPE_LABELS: Record<JobType, string>` is a
    // compile error if any `JobType` (including
    // `cleanup:definition-memory`) is missing an entry -- confirmed by
    // reverting that entry locally and observing
    // `error TS2741: Property '"cleanup:definition-memory"' is missing`.
    // What THIS test asserts instead is the wire fact the client label is
    // keyed on: the real `GET /api/jobs` route serves this job with the
    // EXACT `type` string `JOB_TYPE_LABELS` is indexed by.
    const listRes = await app.request(`/api/jobs?type=${encodeURIComponent(JOB_TYPES.CLEANUP_DEFINITION_MEMORY)}`);
    expect(listRes.status).toBe(200);
    const { jobs } = (await listRes.json()) as { jobs: Array<{ id: string; type: string }> };
    expect(jobs.some((j) => j.id === job.id && j.type === JOB_TYPES.CLEANUP_DEFINITION_MEMORY)).toBe(true);
  });
});
