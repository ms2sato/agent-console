#!/usr/bin/env bun
/**
 * Shipping-path E2E for the restore-boundary usage seed: a restored
 * `openai-api` worker whose REAL context usage is over the compaction
 * threshold must compact at activation, even when re-estimating the
 * reconstructed text puts it comfortably below.
 *
 * WHY THIS IS A SMOKE AND NOT A CI TEST. The defect is a disagreement between
 * two numbers, and only one of them can be faked: `estimateTokensFromChars` is
 * ours, but the reading it is wrong against is the provider's own
 * `prompt_tokens` for a real request carrying real published tool schemas. A
 * fake adapter can be told to report anything, which makes the gap an input
 * rather than a measurement. The unit layer covers the extraction rule, the
 * max rule, the arm containment and the fallback; what only the real chain can
 * establish is that the gap EXISTS at the size the fix assumes, and that
 * seeding from the persisted reading changes the activation's behaviour.
 *
 * WHAT IS REAL HERE. Everything the fix touches:
 *   - a real `AppContext` (real SQLite under a disposable AGENT_CONSOLE_HOME,
 *     real `EmbeddedAgentWorkerService`, real restore reconstruction);
 *   - a real subprocess, spawned by the production `spawnAsUser` path;
 *   - a real `/mcp` endpoint on a real port, which the subprocess dials with
 *     its real per-worker bearer token -- and whose tool list is most of the
 *     schema mass the estimator omits;
 *   - a real provider over real HTTP, whose real `usage.prompt_tokens` is the
 *     reading under test;
 *   - the production entry points a WebSocket client's frames land on:
 *     `activateEmbeddedAgentWorker` / `sendEmbeddedAgentUserMessage` /
 *     `deactivateEmbeddedAgentWorker` / `getWorkerOutputHistory`.
 *
 * WHAT THIS DOES NOT REPRODUCE, AND WHY (Architect ruling, 2026-08-29).
 * The Issue's full wedge ends in a provider 400 that no `Compact` can escape.
 * Reaching it needs the declared window to be BOTH honest and small: with `G`
 * the tool-schema gap and `T` the threshold, the check must miss
 * (`E < T x W`) while the request exceeds the real limit (`W <= E + G`),
 * which requires
 *
 *     W < G / (1 - T)   ~=  5620 / 0.15  ~=  37,500 tokens.
 *
 * Measured 2026-08-29, the smallest context window across this provider's
 * entire catalogue is 196,608 -- five times the ceiling -- and that model
 * silently TRUNCATES rather than erroring. So the 400 is unreachable here, and
 * synthesizing it would stage a link rather than verify one. The causal claim
 * -- that the check now decides on a measurement -- is what this script
 * establishes, in both polarities. The 400's own downstream consequence (a
 * failed turn settles no compaction) is pinned in
 * `agent-loop-compaction.test.ts` instead, where a turn's ending is directly
 * constructible.
 *
 * THE SETUP, and why each number is what it is. `W = 12000` is declared on a
 * definition whose provider window is far larger -- a conservative operator
 * declaration, which is what makes the gap dominant without needing a small
 * model. Turns are grown with auto compaction OFF so the conversation can be
 * parked above `T x W` without the turn-end trigger clearing it; that is not a
 * contrivance but the documented wedge population itself ("sessions that ran
 * with the toggle off"). The toggle is then turned ON before the restart, so
 * the restore-boundary check is live.
 *
 * POLARITY. Run `--expect-underfire` against a tree whose fix is removed
 *   (`git checkout origin/main -- packages/` and back). Every assertion
 * inverts: the activation must publish the ESTIMATE, must report it as an
 * estimate, and must compact nothing. The flag asserts the defect rather than
 * merely tolerating a failure, so a run that silently compacts is reported as
 * a polarity failure.
 *
 * Usage:
 *   bun scripts/smoke/check-restore-boundary-usage-seed.ts
 *   bun scripts/smoke/check-restore-boundary-usage-seed.ts --expect-underfire
 *
 * Requirements:
 *   - A provider key store resolvable for `PROVIDER_KEY_REF`. By default the
 *     key is copied from the single-user dev home; override with
 *     `PROVIDER_KEY_FILE`. Billable, though cheaply: a handful of small turns.
 *   - Single-user mode, which seeds a real `users` row from the OS uid.
 *
 * Exit codes:
 *   0  every assertion in the selected mode passed
 *   1  an assertion failed (the smoke ran and the system is wrong)
 *   2  bad usage / the smoke could not run (boot failure, provider down, ...)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { McpDependencies } from '../../packages/server/src/mcp/mcp-server.ts';
import * as os from 'node:os';
import * as path from 'node:path';

const EXPECT_UNDERFIRE = process.argv.includes('--expect-underfire');

/**
 * The declared window. Deliberately far below the provider's real limit
 * (measured 983,616 for the default model), which is what makes the
 * tool-schema mass the dominant term rather than a rounding error -- and it
 * sits inside the `W < G/(1-T)` regime the header derives.
 *
 * 12,000 rather than something larger because the margin scales with it: the
 * gap is roughly fixed at the published tool list's size, so the smaller the
 * declared window, the more comfortably the estimate falls below `T x W`
 * while the reading clears it. At 20,000 the margin was thin enough that a
 * few turns either way could have decided the outcome.
 */
const WINDOW_TOKENS = 12_000;
/** The default auto threshold; `T x W` is the line both numbers straddle. */
const THRESHOLD_TOKENS = 0.85 * WINDOW_TOKENS;

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

const TURN_TIMEOUT_MS = 180_000;
/** Cap on growth turns, so a provider that reports no usage cannot loop forever. */
const MAX_GROWTH_TURNS = 12;

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (ok) console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

class BailError extends Error {}
/** The smoke cannot run. Throws rather than exiting so cleanup still runs. */
function bail(message: string): never {
  throw new BailError(message);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(150);
  }
  console.error(`  (timed out after ${timeoutMs}ms waiting for: ${what})`);
  return false;
}

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Filler text for the growth turns. Prose rather than a repeated character:
 * a run of identical bytes tokenizes far denser than natural text, which would
 * make the chars/4 estimate diverge from the provider's count for a reason
 * that has nothing to do with tool schemas -- and this script's whole subject
 * is the size of that divergence.
 */
function filler(nWords: number): string {
  // The parentheses are load-bearing: without them `.split(' ')` binds to the
  // LAST literal only, the concatenation coerces the resulting array back to a
  // string, and the indexing below walks CHARACTERS. That produced
  // single-letter "words" tokenizing at ~2 chars/token, which inflated the
  // measured estimate-vs-reading gap by roughly 2x -- a tokenization artifact
  // masquerading as this Issue's defect. Caught by noticing the persisted
  // `user-message` rows were 1865 chars where ~5000 was intended.
  const vocabulary = (
    'the quick brown fox jumps over a lazy dog while several curious badgers observe from beneath ' +
    'the old stone bridge and consider whether the afternoon light will hold long enough for them ' +
    'to finish counting every pebble in the shallow water below'
  ).split(' ');
  const words: string[] = [];
  for (let i = 0; i < nWords; i++) words.push(vocabulary[i % vocabulary.length]);
  return words.join(' ');
}

async function main(): Promise<void> {
  console.log(
    `==> mode: ${EXPECT_UNDERFIRE ? 'POLARITY (--expect-underfire: the defect must reproduce)' : 'SEEDED (the fix must hold)'}`,
  );

  const disposableHome = path.join(os.tmpdir(), `agent-console-1419-${process.pid}-${Date.now()}`);
  const workCwd = path.join(disposableHome, 'work');
  mkdirSync(workCwd, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);

  // The provider key is COPIED into the disposable home rather than the
  // instance being pointed at the dev home: the store is resolved relative to
  // AGENT_CONSOLE_HOME, and borrowing the dev instance's whole home would put
  // this run's sessions in it.
  let apiKey: string;
  try {
    const store = JSON.parse(readFileSync(PROVIDER_KEY_FILE, 'utf-8')) as Record<string, string>;
    if (typeof store[PROVIDER_KEY_REF] !== 'string') {
      bail(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
    }
    apiKey = store[PROVIDER_KEY_REF];
  } catch (err) {
    if (err instanceof BailError) throw err;
    bail(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
  }
  writeFileSync(path.join(disposableHome, 'provider-keys.json'), JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }), {
    mode: 0o600,
  });

  // Settle the port BEFORE building the context: the embedded-agent service
  // resolves the MCP base URL the subprocess will dial at context-creation.
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'none';
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  const { createAppContext, shutdownAppContext } = await import('../../packages/server/src/app-context.ts');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.ts');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.ts'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.ts');

  const ctx = await createAppContext({ broadcastToApp: () => {} });

  const mcpDeps: McpDependencies = {
    sessionManager: ctx.sessionManager,
    repositoryManager: ctx.repositoryManager,
    agentManager: ctx.agentManager,
    agentDirectory: ctx.agentDirectory,
    timerManager: ctx.timerManager,
    conditionalWakeupManager: ctx.conditionalWakeupManager,
    interactiveProcessManager: ctx.interactiveProcessManager,
    worktreeService: ctx.worktreeService,
    annotationService: ctx.annotationService,
    interSessionMessageService: ctx.interSessionMessageService,
    suggestSessionMetadata: ctx.suggestSessionMetadata,
    createWorktreeWithSession,
    deleteWorktree,
    userRepository: ctx.userRepository,
    artifactRepository: ctx.artifactRepository,
    bookmarkRepository: ctx.bookmarkRepository,
    broadcastToApp: () => {},
    fetchPullRequestUrl: ctx.fetchPullRequestUrl,
    findOpenPullRequest: ctx.findOpenPullRequest,
    mcpTokenRegistry: ctx.mcpTokenRegistry,
  };
  const server = Bun.serve({ fetch: createMcpApp(mcpDeps).fetch, port, hostname: '127.0.0.1' });
  console.log(`==> real /mcp served at http://127.0.0.1:${server.port}/mcp`);

  const sm = ctx.sessionManager;

  async function readEvents(sessionId: string, workerId: string): Promise<StreamEvent[]> {
    const hist = await sm.getWorkerOutputHistory(sessionId, workerId);
    if (!hist) return [];
    const events: StreamEvent[] = [];
    for (const line of hist.data.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line) as StreamEvent);
      } catch {
        // A previous incarnation may have been killed mid-write.
      }
    }
    return events;
  }

  const lastUsage = (events: StreamEvent[]): StreamEvent | undefined =>
    events.filter((e) => e.type === 'context-usage').at(-1);

  let sessionId = '';
  let workerId = '';
  try {
    const authUser = ctx.userMode.authenticate(() => undefined);

    const definition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `restore-boundary-seed-smoke-${process.pid}`,
        description: 'Disposable definition for the restore-boundary usage-seed smoke.',
        provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
        // A conservative declared window against a much larger real one. This
        // is what makes the tool-schema gap dominant.
        contextWindowTokens: WINDOW_TOKENS,
      },
      authUser.id,
    );
    console.log(`==> definition ${definition.id} (${PROVIDER_MODEL}, W=${WINDOW_TOKENS})`);

    const session = await sm.createSession({ type: 'quick', locationPath: workCwd }, { createdBy: authUser.id });
    sessionId = session.id;
    if (!session.createdBy) bail('the created session has no createdBy; activation cannot mint an MCP identity');

    const worker = await sm.createWorker(sessionId, { type: 'embedded-agent', embeddedAgentId: definition.id });
    if (!worker) bail('worker creation returned null');
    workerId = worker.id;

    // Grow with auto compaction OFF -- the documented wedge population, and
    // the only way to park a conversation above T x W at all.
    await sm.setEmbeddedAgentAutoCompaction(sessionId, workerId, false);

    await sm.activateEmbeddedAgentWorker(sessionId, workerId);
    if (
      !(await waitFor(
        async () => (await readEvents(sessionId, workerId)).some((e) => e.type === 'ready'),
        TURN_TIMEOUT_MS,
        'the first incarnation to report ready',
      ))
    ) {
      bail('the first incarnation never reported ready');
    }

    // ====================================================================
    // GROW: real turns until the provider's own reading clears T x W.
    // ====================================================================
    console.log(`\n==> growing the conversation until reported usage >= ${THRESHOLD_TOKENS}`);
    let reported = 0;
    for (let turn = 1; turn <= MAX_GROWTH_TURNS; turn++) {
      const marker = (await readEvents(sessionId, workerId)).length;
      const sent = await sm.sendEmbeddedAgentUserMessage(
        sessionId,
        workerId,
        `Reply with only the word OK. Ignore this reference text entirely: ${filler(900)}`,
      );
      if (!sent.ok) bail(`growth turn ${turn} was refused: ${JSON.stringify(sent)}`);
      const done = await waitFor(
        async () =>
          (await readEvents(sessionId, workerId)).slice(marker).some((e) => e.type === 'state' && e.state === 'idle'),
        TURN_TIMEOUT_MS,
        `growth turn ${turn} to complete`,
      );
      if (!done) bail(`growth turn ${turn} never completed`);

      const usage = lastUsage(await readEvents(sessionId, workerId));
      if (!usage) bail('the worker published no context-usage at all; the provider reports no usage');
      if (usage.estimated === true) {
        bail(
          'the provider did not report usage (the loop fell back to its estimator), so there is no real reading ' +
            'for this smoke to be about. Pick a provider that returns `usage`.',
        );
      }
      reported = usage.promptTokens as number;
      console.log(`    turn ${turn}: reported prompt_tokens = ${reported}`);
      if (reported >= THRESHOLD_TOKENS) break;
    }
    if (reported < THRESHOLD_TOKENS) {
      bail(`after ${MAX_GROWTH_TURNS} turns the reported usage is still ${reported} (< ${THRESHOLD_TOKENS})`);
    }

    // The reading that will become the seed, read from the persisted log --
    // the same place the server's extraction reads it from.
    const seedReading = lastUsage(await readEvents(sessionId, workerId));
    console.log(`==> parked at reported ${seedReading?.promptTokens} / ${WINDOW_TOKENS}`);

    // Turn the toggle ON so the restore-boundary check is live on restart.
    await sm.setEmbeddedAgentAutoCompaction(sessionId, workerId, true);

    // ====================================================================
    // RESTART: deactivate, then reactivate. The restore boundary is the
    // moment under test.
    // ====================================================================
    console.log('\n==> restarting the worker (deactivate -> activate)');
    await sm.deactivateEmbeddedAgentWorker(sessionId, workerId);
    await waitFor(
      async () => (await readEvents(sessionId, workerId)).some((e) => e.type === 'exited'),
      60_000,
      'the subprocess to exit',
    );

    const restartMarker = (await readEvents(sessionId, workerId)).length;
    await sm.activateEmbeddedAgentWorker(sessionId, workerId);
    if (
      !(await waitFor(
        async () => (await readEvents(sessionId, workerId)).slice(restartMarker).some((e) => e.type === 'ready'),
        TURN_TIMEOUT_MS,
        'the restored incarnation to report ready',
      ))
    ) {
      bail('the restored incarnation never reported ready');
    }

    const afterRestart = (await readEvents(sessionId, workerId)).slice(restartMarker);
    const boundaryUsage = afterRestart.find((e) => e.type === 'context-usage');
    const compacted = afterRestart.find((e) => e.type === 'context-compacted');

    if (!boundaryUsage) bail('the restored incarnation published no context-usage at the restore boundary');
    const boundaryTokens = boundaryUsage.promptTokens as number;
    console.log(
      `\n==> restore boundary published: promptTokens=${boundaryTokens} estimated=${boundaryUsage.estimated}`,
    );
    console.log(
      `    (the persisted reading was ${seedReading?.promptTokens}; the gap between them is the tool-schema mass ` +
        'the estimator omits)',
    );

    console.log('');
    if (EXPECT_UNDERFIRE) {
      // The DEFECT, asserted rather than tolerated.
      check(
        boundaryUsage.estimated === true,
        'pre-fix: the boundary decides on an ESTIMATE',
        `estimated=${boundaryUsage.estimated}`,
      );
      check(
        boundaryTokens < THRESHOLD_TOKENS,
        'pre-fix: that estimate falls below the threshold the real reading cleared',
        `${boundaryTokens} < ${THRESHOLD_TOKENS} <= ${seedReading?.promptTokens}`,
      );
      check(compacted === undefined, 'pre-fix: nothing is compacted at the restore boundary -- the under-fire');
    } else {
      check(
        boundaryUsage.estimated === false,
        'the boundary decides on a MEASUREMENT, not an estimate',
        `estimated=${boundaryUsage.estimated}`,
      );
      check(
        boundaryTokens === seedReading?.promptTokens,
        'the number it decides on is the persisted reading itself',
        `${boundaryTokens} vs ${seedReading?.promptTokens}`,
      );
      check(
        boundaryTokens >= THRESHOLD_TOKENS,
        'that reading clears the threshold',
        `${boundaryTokens} >= ${THRESHOLD_TOKENS}`,
      );
      check(compacted !== undefined, 'the restore boundary COMPACTS');
      if (compacted) {
        console.log(
          `    context-compacted: source=${compacted.source} preTokens=${compacted.preTokens} postTokens=${compacted.postTokens}`,
        );
      }
      // The point of compacting at all: the next turn goes out small.
      const nextMarker = (await readEvents(sessionId, workerId)).length;
      const followUp = await sm.sendEmbeddedAgentUserMessage(sessionId, workerId, 'Reply with only the word DONE.');
      check(followUp.ok, 'the restored worker accepts a first user turn');
      if (followUp.ok) {
        const completed = await waitFor(
          async () =>
            (await readEvents(sessionId, workerId))
              .slice(nextMarker)
              .some((e) => e.type === 'state' && e.state === 'idle'),
          TURN_TIMEOUT_MS,
          'the first post-restore turn to complete',
        );
        check(completed, 'the first post-restore turn completes');
        // Scoped to THIS turn, unlike a whole-history read: `compact()` ends by
        // publishing its own post-compaction size (542 in the recorded run),
        // which is comfortably below the threshold. A turn that published no
        // reading at all would leave that number as the newest one, and the
        // assertion below would pass on it -- reporting the compaction's own
        // output as though it were the next request's size.
        const post = lastUsage((await readEvents(sessionId, workerId)).slice(nextMarker));
        if (post) {
          check(
            (post.promptTokens as number) < THRESHOLD_TOKENS,
            'and it goes out below the threshold, which is what the compaction bought',
            `${post.promptTokens} < ${THRESHOLD_TOKENS}`,
          );
        }
      }
    }
  } finally {
    if (sessionId && workerId) {
      try {
        await sm.deactivateEmbeddedAgentWorker(sessionId, workerId);
      } catch {
        // Best effort: the run's verdict must not depend on teardown.
      }
    }
    server.stop(true);
    await shutdownAppContext(ctx);
    console.log(`\n==> disposable home left at ${disposableHome} (remove with: find ${disposableHome} -depth -delete)`);
  }

  console.log(`\n==> ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(
      EXPECT_UNDERFIRE
        ? '==> POLARITY FAILURE: the defect did not reproduce against this tree.'
        : '==> FAILURE: the restore boundary did not decide on the persisted reading.',
    );
    process.exit(1);
  }
  console.log(EXPECT_UNDERFIRE ? '==> the defect reproduces, as expected.' : '==> the seed decides the boundary.');
}

main().catch((err) => {
  if (err instanceof BailError) {
    console.error(`==> could not run: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(2);
});
