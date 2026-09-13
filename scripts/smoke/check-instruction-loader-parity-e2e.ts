#!/usr/bin/env bun
/**
 * Shipping-path E2E for Issue #1343's Phase A slice (project-instruction
 * parity on the SDK arm: one loader, `.claude/rules`, both engines) AND
 * Phase B's lazy scoped-rule activation slice (openai-api R1-R5, claude-sdk
 * R2/R3/R4/R6 -- see `rule-activation.ts`'s header comment for what
 * "activation" means at the wire level: a
 * `[rule activated: <name>]\n--- Rule (applies to: ...): <origin> ---\n<content>`
 * block appended to a `tool-result` event's `result` field on openai-api, or
 * delivered via a `PostToolUse` hook's `additionalContext` on claude-sdk).
 *
 * Modeled closely on `check-restart-all-embedded.ts` / the idle-eviction
 * smokes -- same disposable-server boilerplate, same real `AppContext` +
 * real `/mcp` + real embedded-agent workers spawned by the real
 * `EmbeddedAgentWorkerService`. What differs is the mechanism under test:
 * this is not a lifecycle event (restart / eviction), it is a single FIRST
 * turn on each engine, asking whether three pieces of content reached the
 * composed system prompt at activation:
 *
 *   - CLAUDE.md at the scratch repo's root (the pre-existing instructions
 *     chain layer, unaffected by Phase A but re-confirmed here as a
 *     no-regression baseline)
 *   - an UNSCOPED rule under `.claude/rules/*.md` (the new R2 layer --
 *     included eagerly, no frontmatter)
 *   - a NEGATIVE CONTROL under `.claude/rules-not/*.md` -- same file shape,
 *     wrong directory name; the loader only ever scans `.claude/rules`, so
 *     this must NEVER be honoured, on either engine
 *
 * All three checks run on BOTH `openai-api` and `claude-sdk` engines,
 * against the SAME scratch repo -- proving `loadInstructions` composes
 * identically for both, which is the whole point of R1.
 *
 * `settingSources: []` on the SDK arm is UNCHANGED by this PR (sdk-engine.ts
 * is not touched) and is already pinned at the unit level
 * (`packages/embedded-agent/src/__tests__/sdk-engine.test.ts`'s
 * `expect(options.settingSources).toEqual([])`), which runs in this PR's
 * full suite -- this script does not re-implement that capture, since
 * intercepting a live billed SDK session's `Options` from outside would be
 * strictly less reliable than the deterministic unit pin that already exists
 * for a file this PR does not modify.
 *
 * PHASE B ADDITION (lazy scoped-rule activation, both engines)
 *
 * `checkScopedRuleActivation` drives a turn sequence per engine against a
 * NEW scoped rule (`.claude/rules/scoped.md`, `paths: ["src/**"]`, nonce
 * `SCOPED_NONCE`) that the Phase A checks above never exercise (Phase A's
 * rule is unscoped and loaded eagerly; this one is loaded lazily, on a
 * matching tool call):
 *
 *   Turn 1: ask for the rule word (U, Phase A's unscoped nonce -- already
 *     known, eager) and the scoped word (S) -- S must be UNKNOWN (the index
 *     line names the rule, never its content, until a match; R2/R3).
 *   Turn 2: `Read src/x.ts` (matches `src/**`), then ask again -- S is now
 *     known, on BOTH engines.
 *   Turn 3: a FRESH worker on the SAME repo reads `README.md` (does NOT
 *     match `src/**`) and is asked for S -- must stay UNKNOWN. Negative
 *     control for the match rule (R3): reading a non-matching path must
 *     never activate a scoped rule.
 *   Turn 4 (openai-api only): reusing the SAME worker from turns 1-2 (NO
 *     restart in between -- deliberate, see the restore-check paragraph
 *     below), a SECOND matching `Read src/y.ts` in the same worker. Reads
 *     the worker's own persisted event history directly and asserts the
 *     substring `[rule activated: scoped.md]` appears EXACTLY ONCE across
 *     every `tool-result` event's `result` field -- proving the
 *     once-per-incarnation guard (`RuleActivator.matchScopedRules`'s
 *     `this.activated.has(rule.name)` check) actually holds at the
 *     shipping-path level, not just in the unit tests. claude-sdk has no
 *     equivalent check here and none is attempted: its activation travels
 *     through `additionalContext`, injected directly into the SDK's own
 *     context -- it never lands in a persisted `tool-result` event the way
 *     openai-api's `appendix` field does, so there is no transcript
 *     artifact to inspect for the SDK arm. The AC scopes turn 4 to
 *     openai-api for exactly this reason.
 *
 * RESTORE CHECK (R4, openai-api only): run AFTER turn 4, not between turns 2
 * and 4. The AC leaves the placement open ("your choice, but document
 * which") -- placing it between turns 2 and 4 would make turn 4's "no
 * second activation" outcome attributable to EITHER the in-memory `Set`
 * populated by turn 2's own `activate()` call OR the restore-seeded one
 * (main.ts re-seeds the `Set` from the persisted transcript on every
 * restart), and those are two different code paths worth distinguishing
 * rather than conflating into one turn. Running turn 4 first, with no
 * restart in between, isolates the in-incarnation guard cleanly; the
 * restore check that follows then isolates the seeding path just as
 * cleanly, reusing the SAME worker (already carrying the one persisted
 * marker from turn 2) rather than spending an extra turn to manufacture a
 * fresh one. Restarting the worker (deactivate + activate, the same
 * manual-restart sequence `check-restart-all-embedded.ts` and the
 * idle-eviction smokes use) after turn 4 gives a clean incarnation
 * boundary: main.ts's restore-seeding scan finds the ONE persisted
 * `[rule activated: scoped.md]` marker (from turn 2 -- turn 4 added none)
 * and pre-seeds the new incarnation's `RuleActivator` with it. A third
 * matching `Read src/z.ts` in the restarted incarnation is then asserted to
 * add NO second marker across the worker's FULL history -- R4's
 * restore-seeding pin at the shipping-path level.
 *
 * POLARITY (documentation only -- not re-run against reverted code): before
 * this PR (`git show c2d03e21`, `53953b6f`, `b6ba4048`), NEITHER engine had
 * any mechanism to deliver a scoped rule's content at all -- `ToolCallOutcome`
 * had no `appendix` field, `CompositeToolExecutorDeps` had no
 * `ruleActivator`, and `sdk-engine.ts`'s `buildOptions` registered no
 * `PostToolUse` hook. The feature is entirely new code, not a behavior
 * change to existing code, so turn 2's second ask returning UNKNOWN for S on
 * unmodified `main` is not a hypothesis worth re-verifying by reverting and
 * re-running this (billable) script -- it follows directly from the commit
 * diffs' additions. This mirrors, structurally, what
 * `probe-sdk-instruction-loading.ts`'s `--project` arm already measured for
 * its own scoped canary under the NATIVE claude CLI's OWN discovery
 * mechanism (`settingSources: ['project']`): unknown before a matching Read,
 * known after -- the same shape, via a different (and, at the time that
 * probe ran, pre-existing) delivery mechanism.
 *
 * COST: 14 real turns total -- 2 from the existing Phase A checks above (1
 * per engine, unchanged) + 12 from the Phase B additions (claude-sdk: 3
 * turns for the turn 1/turn 2 worker [ask, Read, ask] + 2 for turn 3's fresh
 * worker [Read, ask] = 5; openai-api: the same 5, + 1 for turn 4's extra
 * Read, + 1 for the restore check's post-restart Read = 7). Real money for
 * the `openai-api` arm and real Claude usage for the `claude-sdk` arm -- a
 * manual tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - `claude-sdk` arm: a real, authenticated `claude` CLI for the invoking
 *     OS user (the builtin runs as the executing user and uses that user's
 *     own authentication -- no API key to configure).
 *   - `openai-api` arm: a provider key store resolvable for
 *     `PROVIDER_KEY_REF` (default `opencode-go`, read from the single-user
 *     dev home; override with `PROVIDER_KEY_FILE`).
 *   - `bun install` already run in this checkout.
 *
 * USAGE
 *   bun scripts/smoke/check-instruction-loader-parity-e2e.ts
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- distinct from 1 so an operator can tell "the loader is
 *      broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every module that transitively imports server-config.ts must be
// loaded via a DYNAMIC import made from inside main(), not a static import
// at the top of this file -- same hazard as the sibling smokes (see
// check-embedded-agent-idle-eviction.ts's header comment for the full
// account).

import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';

const CLAUDE_NONCE = `PROJECT-${Math.floor(Math.random() * 9000 + 1000)}`;
const RULE_NONCE = `RULE-${Math.floor(Math.random() * 9000 + 1000)}`;
const IGNORED_NONCE = `IGNORED-${Math.floor(Math.random() * 9000 + 1000)}`;
const SCOPED_NONCE = `SCOPED-${Math.floor(Math.random() * 9000 + 1000)}`;

const ASK_TEXT =
  'Three words may or may not be available to you right now, in your own context: ' +
  'a "project word", a "rule word", and an "ignored word". For each of the three, ' +
  'either quote it exactly if you can see it verbatim in your own context, or say ' +
  'UNKNOWN if you cannot. Do not guess.';

/**
 * Phase B: deliberately a SEPARATE ask text from `ASK_TEXT` above rather than
 * a shared four-word question -- `ASK_TEXT` is Phase A's own three-nonce
 * check (CLAUDE.md / unscoped rule / rules-not negative control) and this
 * script must not conflate the two slices' assertions in one reply.
 */
const SCOPED_ASK_TEXT =
  'Two words may or may not be available to you right now, in your own context: ' +
  'a "rule word" and a "scoped word". For each of the two, either quote it exactly ' +
  'if you can see it verbatim in your own context, or say UNKNOWN if you cannot. ' +
  'Do not guess.';

const readPrompt = (relPath: string): string =>
  `Please use your Read tool to read the file ${relPath} (relative to your working ` +
  `directory) and tell me its exact contents.`;

/**
 * `loadRulesLayer` (system-prompt.ts) derives a rule's `name` from its raw
 * directory-entry filename WITHOUT stripping the `.md` extension (confirmed
 * against `system-prompt.test.ts`'s
 * `expect(result.scopedRules).toEqual([{ name: 'scoped.md', ... }])`) -- so
 * the activation block's header line (rule-activation.ts's
 * `` `[rule activated: ${r.name}]` ``) names the file `scoped.md`, not the
 * bare stem `scoped`.
 */
const SCOPED_RULE_NAME = 'scoped.md';
const SCOPED_RULE_ACTIVATION_MARKER = `[rule activated: ${SCOPED_RULE_NAME}]`;

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

const failures: string[] = [];
let passes = 0;

function expect(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  process.chdir('/');

  console.log(`==> CLAUDE.md nonce:        ${CLAUDE_NONCE}`);
  console.log(`==> .claude/rules nonce:    ${RULE_NONCE}`);
  console.log(`==> .claude/rules-not nonce (must NOT appear): ${IGNORED_NONCE}`);
  console.log(`==> .claude/rules/${SCOPED_RULE_NAME} nonce (lazy, Phase B): ${SCOPED_NONCE}`);

  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import(
    '../../packages/server/src/services/embedded-agent-manager.js'
  );
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');

  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let realConfigDir: string | undefined;
  let realCwd: string | undefined;

  try {
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    realConfigDir = path.join(os.tmpdir(), `ac-1343-instruction-loader-smoke-cfg-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realConfigDir]);
    process.env.AGENT_CONSOLE_HOME = realConfigDir;

    // The provider key is copied into the disposable home (resolved
    // relative to AGENT_CONSOLE_HOME) rather than borrowing the dev home
    // wholesale -- same rationale as the idle-eviction openai-api smoke.
    let apiKey: string;
    try {
      const store = JSON.parse(readFileSync(PROVIDER_KEY_FILE, 'utf-8')) as Record<string, string>;
      if (typeof store[PROVIDER_KEY_REF] !== 'string') {
        throw new Error(`provider key store ${PROVIDER_KEY_FILE} has no entry '${PROVIDER_KEY_REF}'`);
      }
      apiKey = store[PROVIDER_KEY_REF];
    } catch (err) {
      throw new Error(`could not read the provider key store at ${PROVIDER_KEY_FILE}: ${String(err)}`);
    }
    await Bun.write(
      path.join(realConfigDir, 'provider-keys.json'),
      JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }),
    );
    Bun.spawnSync(['chmod', '600', path.join(realConfigDir, 'provider-keys.json')]);

    // --- Scratch git repo shared by both engines' workers.
    realCwd = path.join(os.tmpdir(), `ac-1343-instruction-loader-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.git')]);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.claude', 'rules')]);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, '.claude', 'rules-not')]);
    Bun.spawnSync(['mkdir', '-p', path.join(realCwd, 'src')]);
    await Bun.write(path.join(realCwd, 'CLAUDE.md'), `The project word is ${CLAUDE_NONCE}.\n`);
    await Bun.write(
      path.join(realCwd, '.claude', 'rules', 'nonce-rule.md'),
      `# Nonce Rule\n\nThe rule word is ${RULE_NONCE}.\n`,
    );
    await Bun.write(
      path.join(realCwd, '.claude', 'rules-not', 'ignored.md'),
      `# Should Never Be Read\n\nThe ignored word is ${IGNORED_NONCE}.\n`,
    );
    // Phase B: a SCOPED rule (paths frontmatter) -- its content must stay
    // unreachable until a matching tool call activates it (R2/R3).
    await Bun.write(
      path.join(realCwd, '.claude', 'rules', SCOPED_RULE_NAME),
      `---\npaths:\n  - "src/**"\n---\n\n# Scoped Rule\n\nThe scoped word is ${SCOPED_NONCE}.\n`,
    );
    // Three distinct, FRESH (never read before) files under the scoped
    // rule's `src/**` glob -- one per turn that needs an unambiguous "first
    // Read of a matching path" (turn 2: x.ts, turn 4: y.ts, restore check:
    // z.ts).
    await Bun.write(path.join(realCwd, 'src', 'x.ts'), 'export const x = 1;\n');
    await Bun.write(path.join(realCwd, 'src', 'y.ts'), 'export const y = 2;\n');
    await Bun.write(path.join(realCwd, 'src', 'z.ts'), 'export const z = 3;\n');
    // A NON-matching path (root, not under src/**) -- turn 3's negative
    // control.
    await Bun.write(path.join(realCwd, 'README.md'), '# Scratch Repo\n\nNothing to see here.\n');

    const app = new Hono();
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('appContext', ctx!);
      await next();
    });
    app.route('/api', api);
    app.route(
      '',
      createMcpApp({
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
        broadcastToApp: ctx.broadcastToApp,
        fetchPullRequestUrl: ctx.fetchPullRequestUrl,
        findOpenPullRequest: ctx.findOpenPullRequest,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
      }),
    );
    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    const openaiDefinition = await ctx.embeddedAgentManager.createEmbeddedAgent(
      {
        name: `instruction-loader-smoke-${process.pid}`,
        description: 'Disposable definition for the instruction-loader-parity E2E (Issue #1343 Phase A).',
        provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
      },
      owner.id,
    );
    console.log(`==> openai-api definition ${openaiDefinition.id}`);

    const readEvents = async (
      sessionId: string,
      workerId: string,
    ): Promise<Array<Record<string, unknown> & { type: string }>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      const events: Array<Record<string, unknown> & { type: string }> = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') {
            events.push(json as Record<string, unknown> & { type: string });
          }
        } catch {
          // A trailing torn line is expected while the stream is live.
        }
      }
      return events;
    };

    /** Drive one turn and return the assistant text it produced. */
    const runTurn = async (
      sessionId: string,
      workerId: string,
      text: string,
      timeoutMs = 120_000,
    ): Promise<string> => {
      const before = (await readEvents(sessionId, workerId)).length;
      const res = await ctx!.sessionManager.sendEmbeddedAgentUserMessage(sessionId, workerId, text);
      if (!res.ok) throw new Error(`sendEmbeddedAgentUserMessage failed: ${res.code} ${res.error}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(before);
        const fatal = events.find((e) => e.type === 'fatal');
        if (fatal) throw new Error(`loop emitted fatal: ${JSON.stringify(fatal)}`);
        const turnErr = events.find((e) => e.type === 'turn-error');
        if (turnErr) throw new Error(`loop emitted turn-error: ${JSON.stringify(turnErr)}`);
        const sawIdle = events.some((e) => e.type === 'state' && e.state === 'idle');
        if (sawIdle) {
          return events
            .filter((e) => e.type === 'assistant-message')
            .map((e) => String(e.text ?? ''))
            .join('\n');
        }
        await delay(500);
      }
      throw new Error('turn did not complete before the deadline');
    };

    async function checkEngine(
      label: string,
      makeWorker: () => Promise<{ sessionId: string; workerId: string }>,
    ): Promise<void> {
      console.log(`==> ${label}: activate + ask`);
      const w = await makeWorker();
      await ctx!.sessionManager.activateEmbeddedAgentWorker(w.sessionId, w.workerId);
      const reply = await runTurn(w.sessionId, w.workerId, ASK_TEXT);
      console.log(`  ${label} reply: ${reply.trim().slice(0, 300)}`);

      expect(
        reply.includes(CLAUDE_NONCE),
        `${label}: CLAUDE.md content (chain layer, no-regression baseline) reached the composed system prompt`,
        `expected ${CLAUDE_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );
      expect(
        reply.includes(RULE_NONCE),
        `${label}: unscoped .claude/rules content (R2, new) reached the composed system prompt`,
        `expected ${RULE_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );
      expect(
        !reply.includes(IGNORED_NONCE),
        `${label}: negative control -- .claude/rules-not content was NOT honoured`,
        `unexpectedly found ${IGNORED_NONCE} in: ${reply.trim().slice(0, 300)}`,
      );

      await ctx!.sessionManager.deactivateEmbeddedAgentWorker(w.sessionId, w.workerId).catch(() => {});
    }

    /**
     * Counts (non-overlapping) occurrences of `needle` in `haystack`. Used
     * below to count `SCOPED_RULE_ACTIVATION_MARKER` occurrences across a
     * worker's persisted `tool-result` events.
     */
    function countOccurrences(haystack: string, needle: string): number {
      let count = 0;
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
      }
      return count;
    }

    /**
     * Reads a worker's FULL persisted history (never sliced -- the restore
     * check in particular needs to see markers written before a restart) and
     * counts how many times the scoped rule's activation marker appears
     * across every `tool-result` event's `result` field (agent-loop.ts
     * concatenates `CompositeToolExecutor`'s `appendix` onto that field, see
     * this file's header comment).
     */
    async function countScopedActivationMarkers(sessionId: string, workerId: string): Promise<number> {
      const events = await readEvents(sessionId, workerId);
      let count = 0;
      for (const e of events) {
        if (e.type !== 'tool-result') continue;
        const result = typeof e.result === 'string' ? e.result : '';
        count += countOccurrences(result, SCOPED_RULE_ACTIVATION_MARKER);
      }
      return count;
    }

    /**
     * Phase B, turns 1-3 (both engines): drives the scoped-rule activation
     * sequence documented in this file's header comment and returns the
     * PRIMARY worker (turns 1-2), left ACTIVE, so the openai-api-only caller
     * can continue with turn 4 + the restore check on the exact same
     * incarnation. The claude-sdk caller deactivates the returned worker
     * itself once done (mirroring `checkEngine`'s own cleanup).
     */
    async function checkScopedRuleActivation(
      label: string,
      makeWorker: () => Promise<{ sessionId: string; workerId: string }>,
    ): Promise<{ sessionId: string; workerId: string }> {
      console.log(`==> ${label}: scoped-rule activation (turns 1-3)`);
      const w = await makeWorker();
      await ctx!.sessionManager.activateEmbeddedAgentWorker(w.sessionId, w.workerId);

      // Turn 1: ask before any matching tool call in this incarnation.
      const reply1 = await runTurn(w.sessionId, w.workerId, SCOPED_ASK_TEXT);
      console.log(`  ${label} turn1 reply: ${reply1.trim().slice(0, 300)}`);
      expect(
        reply1.includes(RULE_NONCE),
        `${label}: unscoped rule word (U) is known before any matching tool call`,
        `expected ${RULE_NONCE} in: ${reply1.trim().slice(0, 300)}`,
      );
      expect(
        !reply1.includes(SCOPED_NONCE),
        `${label}: scoped rule word (S) is UNKNOWN before a matching tool call (index line names the rule, not its content)`,
        `unexpectedly found ${SCOPED_NONCE} in: ${reply1.trim().slice(0, 300)}`,
      );

      // Turn 2: a matching Read activates the scoped rule.
      await runTurn(w.sessionId, w.workerId, readPrompt('src/x.ts'));
      const reply2 = await runTurn(w.sessionId, w.workerId, SCOPED_ASK_TEXT);
      console.log(`  ${label} turn2 reply: ${reply2.trim().slice(0, 300)}`);
      expect(
        reply2.includes(SCOPED_NONCE),
        `${label}: scoped rule word (S) is known after a matching Read (src/x.ts)`,
        `expected ${SCOPED_NONCE} in: ${reply2.trim().slice(0, 300)}`,
      );

      // Turn 3: a FRESH worker on the same repo reads a NON-matching path --
      // negative control for the match rule (R3).
      const w3 = await makeWorker();
      await ctx!.sessionManager.activateEmbeddedAgentWorker(w3.sessionId, w3.workerId);
      await runTurn(w3.sessionId, w3.workerId, readPrompt('README.md'));
      const reply3 = await runTurn(w3.sessionId, w3.workerId, SCOPED_ASK_TEXT);
      console.log(`  ${label} turn3 (negative control) reply: ${reply3.trim().slice(0, 300)}`);
      expect(
        !reply3.includes(SCOPED_NONCE),
        `${label}: negative control -- reading a non-matching path (README.md) never activates the scoped rule`,
        `unexpectedly found ${SCOPED_NONCE} in: ${reply3.trim().slice(0, 300)}`,
      );
      await ctx!.sessionManager.deactivateEmbeddedAgentWorker(w3.sessionId, w3.workerId).catch(() => {});

      return w;
    }

    /**
     * Phase B, turn 4 + the R4 restore check -- openai-api only (see this
     * file's header comment for why claude-sdk has no equivalent). `w` is
     * the SAME worker `checkScopedRuleActivation` left active after turns
     * 1-2, still carrying exactly one persisted activation marker.
     */
    async function checkOpenAiScopedRuleExtras(w: { sessionId: string; workerId: string }): Promise<void> {
      console.log('==> openai-api: scoped-rule activation (turn 4 + restore check)');

      // Turn 4: a SECOND matching Read, same incarnation, no restart in
      // between -- proves the in-memory once-per-incarnation guard.
      await runTurn(w.sessionId, w.workerId, readPrompt('src/y.ts'));
      const afterTurn4 = await countScopedActivationMarkers(w.sessionId, w.workerId);
      expect(
        afterTurn4 === 1,
        'openai-api: exactly one activation marker after TWO matching Reads in the same incarnation (once-per-incarnation guard)',
        `expected 1 occurrence of ${SCOPED_RULE_ACTIVATION_MARKER}, found ${afterTurn4}`,
      );

      // Restore check (R4): restart the SAME worker (deactivate + activate,
      // the same manual-restart sequence check-restart-all-embedded.ts and
      // the idle-eviction smokes use), then a THIRD matching Read in the new
      // incarnation. main.ts's restore-seeding scan should have pre-marked
      // the scoped rule as already-activated from the persisted transcript,
      // so this Read must add NO second marker.
      await ctx!.sessionManager.deactivateEmbeddedAgentWorker(w.sessionId, w.workerId);
      await ctx!.sessionManager.activateEmbeddedAgentWorker(w.sessionId, w.workerId);
      await runTurn(w.sessionId, w.workerId, readPrompt('src/z.ts'));
      const afterRestore = await countScopedActivationMarkers(w.sessionId, w.workerId);
      expect(
        afterRestore === 1,
        'openai-api: exactly one activation marker across the FULL history after a restart + a third matching Read (R4 restore-seeding pin)',
        `expected 1 occurrence of ${SCOPED_RULE_ACTIVATION_MARKER}, found ${afterRestore}`,
      );

      await ctx!.sessionManager.deactivateEmbeddedAgentWorker(w.sessionId, w.workerId).catch(() => {});
    }

    const makeOpenAiWorker = async (): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: openaiDefinition.id,
      });
      if (!worker) throw new Error('createWorker returned null for openai-api');
      return { sessionId: session.id, workerId: worker.id };
    };

    const makeClaudeSdkWorker = async (): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'quick', locationPath: realCwd!, agentId: 'claude-code-builtin' },
        { createdBy: owner.id },
      );
      const worker = await ctx!.sessionManager.createWorker(session.id, {
        type: 'embedded-agent',
        embeddedAgentId: CLAUDE_SDK_AGENT_ID,
      });
      if (!worker) throw new Error('createWorker returned null for claude-sdk');
      return { sessionId: session.id, workerId: worker.id };
    };

    await checkEngine('openai-api', makeOpenAiWorker);
    await checkEngine('claude-sdk', makeClaudeSdkWorker);

    const openaiScopedWorker = await checkScopedRuleActivation('openai-api', makeOpenAiWorker);
    await checkOpenAiScopedRuleExtras(openaiScopedWorker);

    const claudeSdkScopedWorker = await checkScopedRuleActivation('claude-sdk', makeClaudeSdkWorker);
    await ctx!.sessionManager
      .deactivateEmbeddedAgentWorker(claudeSdkScopedWorker.sessionId, claudeSdkScopedWorker.workerId)
      .catch(() => {});
  } finally {
    if (ctx) {
      for (const s of ctx.sessionManager.getAllSessions()) {
        for (const w of s.workers) {
          if (w.type === 'embedded-agent') {
            await ctx.sessionManager.deactivateEmbeddedAgentWorker(s.id, w.id).catch(() => {});
          }
        }
      }
      await shutdownAppContext(ctx).catch(() => {});
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    for (const dir of [realConfigDir, realCwd]) {
      if (dir) Bun.spawnSync(['rm', '-rf', dir]);
    }
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then(() => {
      console.log(`\n==> ${passes} passed, ${failures.length} failed`);
      if (failures.length > 0) {
        for (const f of failures) console.error(`  FAILED: ${f}`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nPROBE COULD NOT RUN (or aborted before completing its assertions):');
      console.error(err);
      console.error(`\n==> ${passes} passed, ${failures.length} failed before the abort`);
      process.exit(2);
    });
}
