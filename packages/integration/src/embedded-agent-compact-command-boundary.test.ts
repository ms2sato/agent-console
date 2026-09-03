/**
 * Cross-Package Boundary Test: `/compact` console-slash-command interception.
 *
 * Q10 wire-boundary test for the `EmbeddedAgentCommandSchema` `compact`
 * variant (#1572): a REAL `openai-api` embedded-agent worker's
 * `sendUserMessage('/compact')` must reach the subprocess as the WIRE
 * command `{ v: 1, type: 'compact' }` -- parsed through the REAL
 * `EmbeddedAgentCommandSchema`, not a hand-typed object -- while the
 * PERSISTED transcript still shows the literal `/compact` text the user
 * typed. This is modeled closely on the sibling
 * `embedded-agent-compaction-boundary.test.ts`'s setup/teardown pattern:
 * real `SessionManager` + `EmbeddedAgentManager` wired against a real
 * in-memory SQLite DB and real repositories, with a fake `SpawnAsUserFn`
 * standing in for the subprocess so the test can read what was written to
 * its stdin and feed synthetic NDJSON back as its stdout.
 *
 * The `claude-sdk` control worker (item 4) is what makes assertion (2)
 * meaningful: without it, "the openai-api worker got a compact command"
 * could not be told apart from "every worker gets a compact command" --
 * claude-sdk's own `/compact` table entry is `engine`-handled, so it must
 * see the ordinary `user-message` forwarding path instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as v from 'valibot';

import { setupMemfs, cleanupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { createMockPtyFactory } from '@agent-console/server/src/__tests__/utils/mock-pty';
import { resetGitMocks } from '@agent-console/server/src/__tests__/utils/mock-git-helper';
import { initializeDatabase, closeDatabase, getDatabase } from '@agent-console/server/src/database/connection';
import { JobQueue } from '@agent-console/server/src/jobs/job-queue';
import { registerJobHandlers } from '@agent-console/server/src/jobs/handlers';
import { WorkerOutputFileManager } from '@agent-console/server/src/lib/worker-output-file';
import { SessionManager } from '@agent-console/server/src/services/session-manager';
import { SingleUserMode } from '@agent-console/server/src/services/user-mode';
import { AgentManager } from '@agent-console/server/src/services/agent-manager';
import { SqliteAgentRepository } from '@agent-console/server/src/repositories/sqlite-agent-repository';
import { EmbeddedAgentManager, CLAUDE_SDK_AGENT_ID } from '@agent-console/server/src/services/embedded-agent-manager';
import { SqliteEmbeddedAgentRepository } from '@agent-console/server/src/repositories/sqlite-embedded-agent-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { JsonSessionRepository } from '@agent-console/server/src/repositories/index';
import { AnnotationService } from '@agent-console/server/src/services/annotation-service';
import { McpTokenRegistry } from '@agent-console/server/src/mcp/mcp-auth';
import { defaultRepositoryLookup, defaultRepositoryEnvLookup } from '@agent-console/server/src/__tests__/utils/repository-lookup-mock';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

import { EmbeddedAgentCommandSchema, EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';

const TEST_CONFIG_DIR = '/test/config';
const ptyFactory = createMockPtyFactory();

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

/** One fake subprocess instance: its own stdin capture and controllable stdout. */
interface FakeSpawnInstance {
  captured: SpawnAsUserOpts;
  stdinWrites: string[];
  pushStdoutLine: (line: object) => void;
}

/**
 * Fake `spawnAsUser` that hands out a SEPARATE fake subprocess (separate
 * stdin capture, separate controllable stdout) per call, unlike the
 * compaction-boundary sibling's single-shared-fake factory -- this test
 * activates two independent workers (an openai-api subject and a claude-sdk
 * control) and must be able to tell their stdin writes apart.
 */
function makeMultiFakeSpawn(): { fn: SpawnAsUserFn; instances: FakeSpawnInstance[] } {
  const instances: FakeSpawnInstance[] = [];
  const fn: SpawnAsUserFn = (opts) => {
    const encoder = new TextEncoder();
    const stdinWrites: string[] = [];
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start() {} });
    const exited = new Promise<number>(() => {
      // Never resolves — this test never deactivates the workers.
    });
    const stdin: FakeFileSink = {
      write: (chunk) => {
        stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return 0;
      },
      end: () => {},
      flush: () => 0,
    };
    const subprocess = { pid: 8900 + instances.length, exited, stdin, stdout, stderr, kill: () => {} };
    instances.push({
      captured: opts,
      stdinWrites,
      pushStdoutLine: (line: object) => {
        if (!stdoutController) throw new Error('stdout controller not initialized');
        stdoutController.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      },
    });
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, instances };
}

/** Parse every NDJSON line in `data` with the client's replay schema (the FULL union). */
function parseReplayLines(data: string): { events: EmbeddedAgentStreamEvent[]; parseFailures: string[] } {
  const events: EmbeddedAgentStreamEvent[] = [];
  const parseFailures: string[] = [];
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      parseFailures.push(line);
      continue;
    }
    const parsed = v.safeParse(EmbeddedAgentStreamEventSchema, json);
    if (parsed.success) events.push(parsed.output);
    else parseFailures.push(line);
  }
  return { events, parseFailures };
}

describe('Client-Server Boundary: /compact console-slash-command interception (#1572)', () => {
  let sessionManager: SessionManager;
  let embeddedAgentManager: EmbeddedAgentManager;
  let jobQueue: JobQueue;
  let fake: ReturnType<typeof makeMultiFakeSpawn>;

  beforeEach(async () => {
    await closeDatabase();
    setupMemfs({ [`${TEST_CONFIG_DIR}/.keep`]: '' });
    process.env.AGENT_CONSOLE_HOME = TEST_CONFIG_DIR;
    await initializeDatabase(':memory:');

    jobQueue = new JobQueue(getDatabase(), { concurrency: 1 });
    registerJobHandlers(jobQueue, new WorkerOutputFileManager());

    ptyFactory.reset();
    resetGitMocks();
    fake = makeMultiFakeSpawn();

    const db = getDatabase();
    const agentManager = await AgentManager.create(new SqliteAgentRepository(db));
    embeddedAgentManager = await EmbeddedAgentManager.create(new SqliteEmbeddedAgentRepository(db));
    const sessionRepository = new JsonSessionRepository(`${TEST_CONFIG_DIR}/sessions.json`);

    sessionManager = await SessionManager.create({
      userMode: new SingleUserMode(ptyFactory.provider, { id: 'test-user-id', username: 'testuser', homeDir: '/home/testuser' }),
      pathExists: async () => true,
      sessionRepository,
      jobQueue,
      agentManager,
      embeddedAgentManager,
      annotationService: new AnnotationService(),
      mcpTokenRegistry: new McpTokenRegistry(),
      repositoryLookup: defaultRepositoryLookup,
      repositoryEnvLookup: defaultRepositoryEnvLookup,
      // Test seam: fake the loop subprocess so this boundary test exercises the
      // real activate/sendUserMessage/persist machinery without spawning a
      // real `bun` process (that shipping-path E2E is covered separately).
      spawnAsUserFn: fake.fn,
    });
  });

  afterEach(async () => {
    await jobQueue.stop();
    await closeDatabase();
    cleanupMemfs();
  });

  it('a real /compact turn on an openai-api worker writes the wire compact command (schema-validated), persists /compact as the transcript text, and does NOT intercept a claude-sdk control worker sent the same text', async () => {
    const userRepository = new SqliteUserRepository(getDatabase());
    const owner = await userRepository.upsertByOsUid(97531, 'compact-owner', '/home/compact-owner');

    const definition = await embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );

    // --- Subject: openai-api worker ---
    const subjectWorker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(subjectWorker).not.toBeNull();
    const subjectWorkerId = subjectWorker!.id;
    await sessionManager.activateEmbeddedAgentWorker(session.id, subjectWorkerId);
    expect(fake.instances.length).toBe(1);
    const subjectFake = fake.instances[0];
    const subjectInitWrites = subjectFake.stdinWrites.length;

    // --- Control: claude-sdk worker, same session, sent the SAME text ---
    const controlWorker = await sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: CLAUDE_SDK_AGENT_ID,
    });
    expect(controlWorker).not.toBeNull();
    const controlWorkerId = controlWorker!.id;
    await sessionManager.activateEmbeddedAgentWorker(session.id, controlWorkerId);
    expect(fake.instances.length).toBe(2);
    const controlFake = fake.instances[1];
    const controlInitWrites = controlFake.stdinWrites.length;

    // 1 & 2: send '/compact' to the openai-api subject and assert the WRITTEN
    // wire command, parsed through the REAL EmbeddedAgentCommandSchema.
    const subjectRes = await sessionManager.sendEmbeddedAgentUserMessage(session.id, subjectWorkerId, '/compact');
    expect(subjectRes.ok).toBe(true);

    const subjectForwardedRaw = JSON.parse(subjectFake.stdinWrites[subjectInitWrites]);
    const parsedCommand = v.safeParse(EmbeddedAgentCommandSchema, subjectForwardedRaw);
    expect(parsedCommand.success).toBe(true);
    if (parsedCommand.success) {
      expect(parsedCommand.output).toEqual({ v: 1, type: 'compact' });
    }

    // 3: the PERSISTED transcript still has a user-message row with the
    // literal text '/compact' -- the interception changes only the WIRE
    // command, never what the user is shown they typed.
    const subjectHistory = await sessionManager.getWorkerOutputHistory(session.id, subjectWorkerId, 0);
    expect(subjectHistory).not.toBeNull();
    const { events: subjectEvents, parseFailures: subjectParseFailures } = parseReplayLines(subjectHistory!.data);
    expect(subjectParseFailures).toEqual([]);
    const subjectUserMessage = subjectEvents.find((e) => e.type === 'user-message');
    expect(subjectUserMessage).toMatchObject({ type: 'user-message', text: '/compact' });

    // 4: control -- the SAME text sent to a claude-sdk worker must NOT be
    // intercepted; it reaches the subprocess as an ordinary user-message
    // wire command. Without this control, (1)/(2) above could not be told
    // apart from "every worker gets a compact command".
    const controlRes = await sessionManager.sendEmbeddedAgentUserMessage(session.id, controlWorkerId, '/compact');
    expect(controlRes.ok).toBe(true);

    const controlForwardedRaw = JSON.parse(controlFake.stdinWrites[controlInitWrites]);
    const parsedControlCommand = v.safeParse(EmbeddedAgentCommandSchema, controlForwardedRaw);
    expect(parsedControlCommand.success).toBe(true);
    if (parsedControlCommand.success) {
      expect(parsedControlCommand.output).toMatchObject({ v: 1, type: 'user-message', text: '/compact' });
    }

    // Polarity (recorded, not re-run automatically): with
    // `matchSlashCommand` short-circuited to return `null` unconditionally
    // inside `resolveConsoleSlashCommandOverride`
    // (embedded-agent-worker-service.ts), assertion (2) above fails --
    // observed manually: `parsedCommand.output` becomes
    // `{ v: 1, type: 'user-message', id: ..., text: '/compact' }` instead of
    // `{ v: 1, type: 'compact' }`, so the `toEqual({ v: 1, type: 'compact' })`
    // assertion fails as expected. Restored afterward; no source change
    // remains from this check.
  });
});
