/**
 * Client-Server Boundary Test: embedded-agent message attachments (Issue
 * #1570).
 *
 * Exercises the REAL chain end to end for a message with a file attachment
 * sent to an `openai-api` embedded-agent worker:
 *
 *   real HTTP POST /api/sessions/:id/messages (multipart/form-data, a real
 *   `files` entry)
 *     -> real route handler (packages/server/src/routes/workers.ts) saves
 *        the file to the shared per-OS-user upload directory
 *     -> real SessionManager.sendMessage's embedded-agent branch
 *        (activate-on-delivery + composeEmbeddedAgentDeliveryText fold)
 *     -> real EmbeddedAgentWorkerService.activate / .sendUserMessage
 *     -> the subprocess (faked at the lowest level, spawnAsUserFn) receives
 *        an `init` command whose `context.attachmentRoots` names the real
 *        upload directory, and a `user-message` command whose `text` is the
 *        labelled fold
 *
 * Neither a unit test on `composeEmbeddedAgentDeliveryText` alone nor a unit
 * test on `EmbeddedAgentWorkerService` alone proves that a REAL multipart
 * HTTP request -- the same shape the client's message composer sends --
 * reaches the real route, the real upload-dir save, and the real subprocess
 * init/user-message composition. This boundary test exercises that full
 * chain, per pre-pr-completeness.md Q10 and the AC for Issue #1570.
 *
 * NOTE: packages/integration uses a FLAT sibling test layout (no __tests__/).
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
import { resolveUploadDir } from '@agent-console/server/src/lib/message-upload-dir';
import type { SpawnAsUserFn, SpawnAsUserOpts, SpawnAsUserResult } from '@agent-console/server/src/services/privilege-elevation';

import { EmbeddedAgentStreamEventSchema, type EmbeddedAgentStreamEvent } from '@agent-console/shared';

/** Minimal subset of Bun's FileSink consumed by EmbeddedAgentWorkerService. */
interface FakeFileSink {
  write: (chunk: string | Uint8Array) => number;
  end: () => void;
  flush: () => number;
}

function makeFakeSpawn(): {
  fn: SpawnAsUserFn;
  captured: SpawnAsUserOpts[];
  stdinWrites: string[];
} {
  const captured: SpawnAsUserOpts[] = [];
  const stdinWrites: string[] = [];
  const stdout = new ReadableStream<Uint8Array>({ start() {} });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>(() => {
    // Never resolves — this test never deactivates the worker.
  });
  const stdin: FakeFileSink = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return 0;
    },
    end: () => {},
    flush: () => 0,
  };
  const subprocess = { pid: 9999, exited, stdin, stdout, stderr, kill: () => {} };
  const fn: SpawnAsUserFn = (opts) => {
    captured.push(opts);
    return { subprocess, stdin, elevated: false } as unknown as SpawnAsUserResult;
  };
  return { fn, captured, stdinWrites };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
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

describe('Client-Server Boundary: embedded-agent message attachments (Issue #1570)', () => {
  let ctx: AppContext;
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(async () => {
    await setupTestEnvironment();
    fake = makeFakeSpawn();
    ctx = await createTestContext({ spawnAsUserFn: fake.fn });
  });

  afterEach(async () => {
    await shutdownAppContext(ctx);
    await cleanupTestEnvironment();
  });

  it('a real multipart POST with a file attachment reaches the subprocess as attachmentRoots (init) + a labelled fold (user-message)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(24680, 'owner', '/home/owner');

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    const app = await createTestApp(ctx);

    const formData = new FormData();
    formData.append('toWorkerId', workerId);
    formData.append('content', 'please look at this');
    formData.append('files', new File(['attachment body'], 'notes.txt', { type: 'text/plain' }));

    // Do NOT set Content-Type manually -- fetch/Hono compute the multipart
    // boundary from the FormData body automatically.
    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(201);

    // The route's response `message.content` is the ORIGINAL typed content,
    // not the delivery text (SessionManager.sendMessage constructs
    // WorkerMessage.content from the caller-supplied `content`, unfolded).
    const body = (await res.json()) as { message: { content: string } };
    expect(body.message.content).toBe('please look at this');

    // Activation happens on delivery (sendMessage's embedded-agent branch),
    // so the FIRST stdin line is the init command.
    await waitFor(() => fake.stdinWrites.length >= 2);
    const initCommand = JSON.parse(fake.stdinWrites[0]);
    expect(initCommand.type).toBe('init');
    expect(initCommand.context.attachmentRoots).toEqual([resolveUploadDir()]);

    // The SECOND stdin line is the user-message command carrying the
    // labelled fold.
    const userMessageCommand = JSON.parse(fake.stdinWrites[1]);
    expect(userMessageCommand.type).toBe('user-message');
    expect(userMessageCommand.text).toContain('please look at this');
    expect(userMessageCommand.text).toContain('Attached files:');
    expect(userMessageCommand.text).toMatch(/^please look at this\n\nAttached files:\n- .+notes\.txt$/);

    // Close the wire-schema loop the same way the sibling boundary test does
    // for clientMessageId: read the persisted history back and parse it
    // with the client's REAL parser.
    await waitFor(async () => {
      const hist = await ctx.sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await ctx.sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(history).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message');
    expect(userMessageEvent).toBeDefined();
    if (userMessageEvent?.type === 'user-message') {
      expect(userMessageEvent.text).toContain('Attached files:');
    }
  });

  it('a real multipart POST with a PNG image attachment carries `attachments` on both the subprocess user-message command and the persisted event (Issue #1571)', async () => {
    const owner = await ctx.userRepository.upsertByOsUid(24681, 'owner2', '/home/owner2');

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      { name: 'Local model', provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' } },
      owner.id,
    );
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: '/test/path' },
      { createdBy: owner.id },
    );
    const worker = await ctx.sessionManager.createWorker(session.id, {
      type: 'embedded-agent',
      embeddedAgentId: definition.id,
    });
    expect(worker).not.toBeNull();
    const workerId = worker!.id;

    const app = await createTestApp(ctx);

    // A minimal valid 1x1 transparent PNG -- real bytes, not a text stub with
    // a spoofed mime type, so the wire carries a genuine image attachment.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const pngBytes = Buffer.from(pngBase64, 'base64');

    const formData = new FormData();
    formData.append('toWorkerId', workerId);
    formData.append('content', 'what is in this image?');
    formData.append('files', new File([pngBytes], 'screenshot.png', { type: 'image/png' }));

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(201);

    await waitFor(() => fake.stdinWrites.length >= 2);

    // The subprocess `user-message` command carries `attachments`.
    const userMessageCommand = JSON.parse(fake.stdinWrites[1]);
    expect(userMessageCommand.type).toBe('user-message');
    expect(userMessageCommand.attachments).toHaveLength(1);
    expect(userMessageCommand.attachments[0].mimeType).toBe('image/png');
    expect(userMessageCommand.attachments[0].path).toContain(resolveUploadDir());
    expect(userMessageCommand.attachments[0].path).toMatch(/screenshot\.png$/);

    // The persisted `user-message` event mirrors it.
    await waitFor(async () => {
      const hist = await ctx.sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
      return !!hist && hist.data.includes('user-message');
    });
    const history = await ctx.sessionManager.getWorkerOutputHistory(session.id, workerId, 0);
    expect(history).not.toBeNull();

    const { events, parseFailures } = parseReplayLines(history!.data);
    expect(parseFailures).toEqual([]);

    const userMessageEvent = events.find((e) => e.type === 'user-message');
    expect(userMessageEvent).toBeDefined();
    if (userMessageEvent?.type === 'user-message') {
      expect(userMessageEvent.attachments).toEqual(userMessageCommand.attachments);
    }
  });
});
