/**
 * Cross-Package Boundary Test: the embedded worker's own AGENT_CONSOLE_*
 * identity at spawn (Issue #1694).
 *
 * The identity key set lives in packages/shared
 * (`AGENT_CONSOLE_IDENTITY_ENV_KEYS`) and is consumed on two sides that never
 * meet in a unit test: the server's `buildAgentConsoleEnv` (what the spawn
 * emits) and the embedded-agent Bash tool's `buildBashEnv` (what the loop
 * keeps). This test enters through the integration package's real wiring --
 * `createTestContext` (a real `AppContext`: real `SessionManager`, real
 * `EmbeddedAgentWorkerService`, real session/worker rows) with a fake
 * `spawnAsUserFn` standing in for the loop subprocess at the lowest level --
 * and asserts, against the shared constant imported from packages/shared:
 *
 *   1. the composed spawn env's AGENT_CONSOLE_* key SET equals the constant
 *      for a delegated session (parentSessionId + parentWorkerId; a quick
 *      session, so REPOSITORY_ID is asserted ABSENT rather than merely
 *      allowed), with the session's own values -- so a key added on one
 *      side and forgotten on the other fails HERE, not in production;
 *   2. the C1 polarity through the real context: a stale
 *      `AGENT_CONSOLE_PARENT_SESSION_ID` seeded on the SERVER's own
 *      `process.env` never reaches the composed env of a session that has no
 *      parent (the base is `getCleanChildProcessEnv()`, not `process.env`);
 *   3. the loop-side allowlist keeps exactly what the server emits: feeding
 *      the composed env through the REAL `buildBashEnv` is an identity
 *      operation on the AGENT_CONSOLE_* namespace.
 *
 * The tier-2 smoke (`scripts/smoke/check-embedded-agent-bash-env.ts`) is the
 * production-real E2E for the same contract through a real elevated login
 * shell and a real Bash child; it is a manual gate. This test is the layer
 * that survives in `bun run test`.
 *
 * Reach measured (one mutation per side, per workflow.md): dropping
 * `'AGENT_CONSOLE_PARENT_WORKER_ID'` from the shared constant fails the
 * first test (at the key-set equality); dropping the `parentWorkerId`
 * spread from `buildAgentConsoleEnv` fails the first test; omitting
 * `baseEnv` at the embedded spawn fails the second (the C1 polarity).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { setupTestEnvironment, cleanupTestEnvironment } from '@agent-console/server/src/__tests__/test-utils';
import { createTestContext, shutdownAppContext } from '@agent-console/server/src/app-context';
import type { AppContext } from '@agent-console/server/src/app-context';
import type {
  SpawnAsUserFn,
  SpawnAsUserOpts,
  SpawnAsUserResult,
} from '@agent-console/server/src/services/privilege-elevation';
import { buildBashEnv } from '@agent-console/embedded-agent/src/tools/env-cleaner';

import { AGENT_CONSOLE_IDENTITY_ENV_KEYS, AGENT_CONSOLE_ENV_PREFIX } from '@agent-console/shared';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** The subset of `Subprocess` the service reads while a worker stays activated. */
interface FakeSubprocess {
  pid: number;
  exited: Promise<number>;
  stdin: FakeFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
}

function makeFakeSpawn(): { fn: SpawnAsUserFn; captured: SpawnAsUserOpts[] } {
  const captured: SpawnAsUserOpts[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves -- these tests never deactivate the worker.
  });
  const stdin: FakeFileSink = { write: () => 0, end: () => {}, flush: () => 0 };
  const subprocess: FakeSubprocess = { pid: 9997, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    // One direct cast at the fake boundary (no `unknown` intermediate): the
    // typed fake models exactly the subset the service consumes.
    const result: Pick<SpawnAsUserResult, 'elevated'> & { subprocess: FakeSubprocess; stdin: FakeFileSink } = {
      subprocess,
      stdin,
      elevated: false,
    };
    return result as SpawnAsUserResult;
  };
  return { fn, captured };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** What `spawnAsUser`'s non-elevated branch composes from the captured opts. */
function composedSpawnEnv(opts: SpawnAsUserOpts): Record<string, string> {
  return { ...opts.baseEnv, ...opts.env };
}

function agentConsoleEntries(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(AGENT_CONSOLE_ENV_PREFIX)));
}

describe('Server-Subprocess Boundary: embedded worker AGENT_CONSOLE_* identity at spawn (Issue #1694)', () => {
  let ctx: AppContext;
  let fake: ReturnType<typeof makeFakeSpawn>;
  let previousStaleParent: string | undefined;

  beforeEach(async () => {
    await setupTestEnvironment();
    fake = makeFakeSpawn();
    ctx = await createTestContext({ spawnAsUserFn: fake.fn });
    // C1 polarity seed: the SERVER's own environment carries a parent id
    // (as it does when the server is started from a delegated session).
    previousStaleParent = process.env.AGENT_CONSOLE_PARENT_SESSION_ID;
    process.env.AGENT_CONSOLE_PARENT_SESSION_ID = 'stale-parent-from-server-env';
  });

  afterEach(async () => {
    if (previousStaleParent === undefined) delete process.env.AGENT_CONSOLE_PARENT_SESSION_ID;
    else process.env.AGENT_CONSOLE_PARENT_SESSION_ID = previousStaleParent;
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  async function activateEmbeddedWorker(sessionRequest: Parameters<AppContext['sessionManager']['createSession']>[0]) {
    const owner = await ctx.userRepository.upsertByOsUid(24680, 'owner', '/home/owner');
    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { engine: 'openai-api', name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await ctx.sessionManager.createSession(sessionRequest, { createdBy: owner.id });
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    await ctx.sessionManager.activateEmbeddedAgentWorker(session.id, worker!.id);
    await waitFor(() => fake.captured.length >= 1);
    return { session, workerId: worker!.id, spawnOpts: fake.captured[0] };
  }

  it('a delegated session with every optional id spawns with EXACTLY the shared identity key set, valued from the session', async () => {
    const { session, workerId, spawnOpts } = await activateEmbeddedWorker({
      type: 'quick',
      locationPath: '/test/quick-cwd',
      parentSessionId: 'parent-session-1694',
      parentWorkerId: 'parent-worker-1694',
    });

    const composed = composedSpawnEnv(spawnOpts);
    const identity = agentConsoleEntries(composed);
    // Key SET equality against the constant imported from packages/shared,
    // minus REPOSITORY_ID (a quick session has no repository -- and its
    // absence is asserted explicitly, not merely allowed).
    const expectedKeys = AGENT_CONSOLE_IDENTITY_ENV_KEYS.filter((k) => k !== 'AGENT_CONSOLE_REPOSITORY_ID');
    expect(Object.keys(identity).sort()).toEqual([...expectedKeys].sort());
    expect(identity.AGENT_CONSOLE_SESSION_ID).toBe(session.id);
    expect(identity.AGENT_CONSOLE_WORKER_ID).toBe(workerId);
    expect(identity.AGENT_CONSOLE_PARENT_SESSION_ID).toBe('parent-session-1694');
    expect(identity.AGENT_CONSOLE_PARENT_WORKER_ID).toBe('parent-worker-1694');
    expect(new URL(identity.AGENT_CONSOLE_BASE_URL).pathname).toBe('/');
    // The seeded server value never wins over the session's own.
    expect(Object.values(composed)).not.toContain('stale-parent-from-server-env');

    // Case 3: the loop-side allowlist (the REAL buildBashEnv from
    // packages/embedded-agent) keeps exactly what the server emitted.
    expect(agentConsoleEntries(buildBashEnv(composed))).toEqual(identity);
  });

  it('C1 polarity through the real context: a session without a parent gets NO PARENT_* key even though the server environment carries one', async () => {
    const { session, spawnOpts } = await activateEmbeddedWorker({ type: 'quick', locationPath: '/test/quick-cwd' });

    const composed = composedSpawnEnv(spawnOpts);
    expect(spawnOpts.baseEnv).toBeDefined();
    expect('AGENT_CONSOLE_PARENT_SESSION_ID' in composed).toBe(false);
    expect('AGENT_CONSOLE_PARENT_WORKER_ID' in composed).toBe(false);
    expect(Object.values(composed)).not.toContain('stale-parent-from-server-env');
    expect(composed.AGENT_CONSOLE_SESSION_ID).toBe(session.id);
    // And the base itself carries no AGENT_CONSOLE_* key at all.
    for (const key of Object.keys(spawnOpts.baseEnv ?? {})) {
      expect(key.startsWith(AGENT_CONSOLE_ENV_PREFIX)).toBe(false);
    }
  });
});
