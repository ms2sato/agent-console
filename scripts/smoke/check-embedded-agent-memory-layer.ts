#!/usr/bin/env bun
/**
 * Shipping-path E2E for the embedded-agent memory layer (epic #1636 Phase 2,
 * Issue #1709 PR-3b) -- the server-owned `memory/<definitionId>/` directory
 * introduced by 3a (`packages/server/src/lib/memory-dir.ts`), the MEMORY.md
 * index convention rendered by `formatMemoryHeader`
 * (`packages/embedded-agent/src/system-prompt.ts`), and its wiring through
 * `EmbeddedAgentWorkerService.runActivation` into `init.context.memoryDir`.
 *
 * See docs/design/embedded-agent-worker.md "Verification plan for PR-3",
 * steps 1-5, for the plan this script implements.
 *
 * ============================================================================
 * WHAT THIS SCRIPT VERIFIES
 * ============================================================================
 *
 * For EACH selected engine arm (openai-api and/or claude-sdk), against a
 * REAL disposable server (`AppContext`, `/mcp`, real embedded-agent
 * subprocesses):
 *
 *   1. The COMPUTED memory path -- `computeSessionDataBaseDir(home,
 *      'repository', slug)` + `SessionDataPathResolver.getMemoryDir(defId,
 *      { kind: 'repository' })`, the same single-writer path production
 *      uses -- matches what actually lands on `init.context.memoryDir` at
 *      activation, for FOUR (session, definition) pairs spanning both slug
 *      shapes the Session Data Path design produces: a two-segment
 *      "org/repo" slug (repo1, real `origin` remote) and a one-segment
 *      basename slug (repo2, no remote).
 *   2. A real turn that plants a fact via a TOOL call (never chat text, per
 *      `.claude/rules/test-trigger.md`'s "the conversation must use a tool"
 *      rule) actually creates a topic file under that memory directory
 *      containing the fact, adds a one-line MEMORY.md index pointer to it
 *      (never the fact itself), and never writes the fact into MEMORY.md.
 *   3. A FRESH worker on the SAME (repository, definition) pair -- which
 *      never saw the planting turn -- recalls the fact by reading the
 *      memory index and the topic file via a tool call, proving the memory
 *      directory is genuinely persistent and genuinely read, not merely
 *      created.
 *   4. Two negative controls in the SAME run: a fresh worker on the same
 *      repository but a DIFFERENT definition (proves memory is keyed by
 *      definition, not just repository), and a fresh worker on the SAME
 *      definition but a DIFFERENT repository (proves memory is keyed by
 *      repository too, not just definition). Neither may recall the fact.
 *   5. `--expect-no-memory` (polarity): with the memory layer's own
 *      construction-time seam substituted to return `undefined`, no
 *      `init.context` carries a `memoryDir` key at all, no `<base>/memory`
 *      directory is ever created on disk, and a recall attempt returns
 *      nothing to recall -- i.e. the mechanism this script exercises
 *      actually reaches the layer under test, per `workflow.md`'s "a
 *      check's existence is not its detection power".
 *
 * ============================================================================
 * Q13 SELF-PASS RECORD (`pre-pr-completeness.md` Q13) -- every substitution
 * this script makes, and why each sits upstream of / outside the chain
 * under test. Nothing else in the chain (the memory-dir loader, the
 * confinement check, the Read/Write/Edit tools, the on-disk files
 * themselves, the model's own turns) is stubbed, mocked, or bypassed.
 * ============================================================================
 *
 *   (a) NONCE DELIVERED VIA A FILE IN CWD, NOT IN PROSE. Changes how the
 *       model ARRIVES at the fact (it must call Read), never what the memory
 *       layer does with it once told. Same discipline as every restore/
 *       eviction smoke in this file's own family.
 *
 *   (b) POLARITY SEAM: `ensureMemoryDirFn: async () => undefined` passed as
 *       a CONSTRUCTION-TIME option to `createTestContext` (threaded through
 *       `SessionManager.create()` into `EmbeddedAgentWorkerService`'s own
 *       deps -- see that service's `EnsureMemoryDirFn` doc comment: "the
 *       ONLY test/polarity seam for the layer"). This substitutes the
 *       DECISION to resolve/create/verify a memory directory and send it
 *       downstream -- it never touches the loader that renders the memory
 *       header, the confinement/verification code in `memory-dir.ts`, or
 *       any tool. No runtime reassignment of a private field is performed
 *       anywhere in this script.
 *
 *   (c) INIT-FRAME OBSERVATION TAP: `spawnAsUserFn` is a pure OBSERVATION
 *       wrapper around the REAL `spawnAsUser` (imported from
 *       `privilege-elevation.js`, never reimplemented) -- it intercepts the
 *       bytes written to the real `FileSink` stdin returned by the real
 *       spawn, parses complete NDJSON lines, and records any `type: 'init'`
 *       frame for this script's own assertions. It changes nothing about
 *       what is spawned, what is written, or when -- `createTestContext`
 *       already exposes `spawnAsUserFn` as a first-class test seam for
 *       exactly this kind of wrapping (see its own doc comment).
 *
 *   (d) CLAUDE-SDK D1 / D2 PROVISIONING (the boot-through block at the top
 *       of `main()`): the REST creation route
 *       (`EmbeddedAgentManager.createEmbeddedAgent`) hardcodes
 *       `engine: 'openai-api'` by design (SDK Engine Phase 1 -- `claude-sdk`
 *       is reachable ONLY through the single builtin, `claude-sdk-builtin`),
 *       so there is no public creation path for a `claude-sdk` definition
 *       carrying `Write`/`Edit` in its `enabledTools`, which the WRITE half
 *       under test needs (see SMOKE_ENABLED_TOOLS: the builtin carried no
 *       `enabledTools` at all until the owner's 2026-09-17 opt-in added
 *       Write/Edit -- this smoke still does not use the builtin as its
 *       subject, since there is still no public creation path for a SECOND
 *       `claude-sdk` definition). Both claude-sdk definitions (D1 the
 *       subject, D2 the same-repository control) are therefore
 *       smoke-persisted rows shaped like the builtin plus
 *       SMOKE_ENABLED_TOOLS. This substitutes
 *       the ABSENT creation path -- it sits upstream of, and outside, the
 *       activation chain under test. The rows reach that chain through REAL
 *       production machinery, never a hand-assembled shortcut: (i) a
 *       disposable `createTestContext` boots against a FILE-backed (not
 *       in-memory) database; (ii) the rows are persisted through the real
 *       `SqliteEmbeddedAgentRepository.save`; (iii) that context is shut
 *       down (closing its DB handle); (iv) the context this script actually
 *       drives boots against the SAME file, and `EmbeddedAgentManager.create()`
 *       -> `.initialize()` loads them through the REAL startup boot path --
 *       the exact code path a production server runs after a restart. The
 *       manager's in-memory map is never written to directly by this script.
 *
 *       Both halves ride on `createTestContext`'s own override block:
 *       `dbPath` (a file-backed database, so boot #2 reads what boot #1
 *       persisted -- `createAppContext` has `dbPath` but none of the seams
 *       (b)/(c) need, and re-deriving its wiring here would duplicate what
 *       `createTestContext` exists to avoid) and `ensureMemoryDirFn`. The
 *       first design for D2 -- writing the manager's private map directly --
 *       was overruled: it never reaches `initialize()`, so it would prove
 *       nothing about what a restarted production server actually loads.
 *
 * ============================================================================
 * SINGLE-USER ONLY
 * ============================================================================
 *
 * This script's disposable home runs with `AUTH_MODE` UNSET (single-user),
 * so `resolveMemoryDirContract()` (`memory-dir.ts`) is exercised only under
 * the `0700` single-user contract. The multi-user `2775` + service-group
 * contract (tier 4 / Issue #1699) is explicitly NOT exercised here and must
 * NOT be added by switching this script to multi-user without also using
 * `createDisposableMultiUserHome` (Issue #1713) -- a bare `AUTH_MODE=multi-
 * user` override here would fail every activation with the memory
 * directory's own "unexpected group gid" fail-closed check, for reasons
 * that have nothing to do with the memory layer.
 *
 * COST: per selected engine arm, 4 real turns (A's plant, B's recall, C's
 * and D's control recalls) when the full positive+control flow runs, or 2
 * (A's plant, B's recall) under `--expect-no-memory`. A tool-using turn is
 * several provider round trips, so "turn" here is a lower bound on calls.
 * Real money for `openai-api`, real Claude usage for `claude-sdk`. A manual
 * tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - `openai-api` arm: a provider key store resolvable for
 *     `PROVIDER_KEY_REF` (default `opencode-go`, read from the single-user
 *     dev home; override with `PROVIDER_KEY_FILE`).
 *   - `claude-sdk` arm: a real, authenticated `claude` CLI for the invoking
 *     OS user (the builtin runs as the executing user and uses that user's
 *     own authentication -- no API key to configure).
 *   - `bun install` already run in this checkout.
 *
 * USAGE
 *   bun scripts/smoke/check-embedded-agent-memory-layer.ts [--] \
 *     [--engine openai-api|claude-sdk|both] [--expect-no-memory]
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- deliberately distinct from 1, so an operator can tell
 *      "the memory layer is broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every module that transitively imports server-config.ts must be
// loaded via a DYNAMIC import made from inside main(), not a static import
// at the top of this file -- same hazard as every sibling smoke (see
// check-embedded-agent-idle-eviction.ts's header comment for the full
// account).

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// `lib/config.ts` (NOT `lib/server-config.ts`) only imports `node:path`/
// `node:os` at module load, so it is safe as a static import here too.
import { getConfigDir } from '../../packages/server/src/lib/config.js';
import type { AppContext } from '../../packages/server/src/app-context.js';
import { createScratchGitRepo, type ScratchGitRepo } from '../../packages/server/src/__tests__/utils/scratch-git.js';

type EngineArm = 'openai-api' | 'claude-sdk';
type EngineSelection = EngineArm | 'both';

const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL ?? 'https://opencode.ai/zen/go/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL ?? 'qwen3.8-flash';
const PROVIDER_KEY_REF = process.env.PROVIDER_KEY_REF ?? 'opencode-go';
const PROVIDER_KEY_FILE =
  process.env.PROVIDER_KEY_FILE ?? path.join(os.homedir(), '.agent-console-dev', 'provider-keys.json');

const NONCE_FILE = 'qa-note.txt';

/**
 * ONE plant prompt for both modes, and it is CONDITIONAL on the instructions
 * the model actually has -- never an unconditional "record it in memory".
 * Measured reason: the polarity arm's first run at 342e140c used an
 * unconditional prompt ("record that word in your persistent memory
 * following your memory instructions"); with the memory header absent the
 * openai-api worker went hunting for a memory mechanism through the MCP
 * `run_process` tool (9 shell spawns: `find / -type d -name memory`,
 * `env | sort`, `ls ~/.claude/projects/<slug>/memory`, ...) and hit `runTurn`'s
 * 120 s deadline -- exit 2, a harness abort, not the polarity verdict the
 * arm exists to produce. The prompt had presupposed an instruction the flag
 * removes, the same class as test-trigger.md's "the secret word I told you"
 * lesson. Keeping a single prompt (rather than a per-mode one) preserves
 * the spec's "same sequence" polarity; the conditional lets the flag's arm
 * read the file and stop.
 */
const PLANT_TEXT =
  `Use the Read tool to read ${NONCE_FILE} in your working directory; it contains a secret word. ` +
  'If your instructions describe a persistent memory directory, record the word there following ' +
  'those instructions (a new topic file whose body contains the word, plus a one-line pointer in ' +
  'MEMORY.md; never the word in MEMORY.md itself). If your instructions describe no such ' +
  'directory, do nothing else. Reply with only the word OK.';

const RECALL_TEXT =
  'Do you have a secret word recorded in your memory? Consult your memory index and read the ' +
  'relevant topic file if there is one. If you find the word, reply with the word only. If you do ' +
  'not, reply with the single word UNKNOWN only.';

const MEMORY_INDEX_LINK_RE = /^\s*[-*]\s*\[[^\]]*\]\(([^)\s]+)\)/;

/**
 * The tool set EVERY smoke definition carries, on both engines, byte-identical
 * (Architect ruling on run 4 at 48559c2b): the memory layer's WRITE half is the
 * existing `Write`/`Edit` tools under `enabledTools` -- the design's named
 * mechanism -- and a definition without them has read-only memory by policy on
 * either engine (the SDK arm builds its `tools:` list from `enabledTools` too,
 * `sdk-engine.ts`). The builtin `claude-sdk-builtin` carried no `enabledTools`
 * at all until the owner's 2026-09-17 opt-in: measured on run 4, it answered
 * a `Write` with "No such tool available: Write" and wrote through the
 * `run_process` MCP shell instead -- the route the mechanism pins below now
 * reject. This smoke deliberately keeps its OWN Write-enabled definitions
 * (`SMOKE_ENABLED_TOOLS`) rather than switching to reference the builtin's
 * array directly, so the smoke's subject does not silently drift if a future
 * product decision changes the builtin's tool list again.
 */
const SMOKE_ENABLED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;

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

function randomNonce(): string {
  // Deliberately not memory-themed: a nonce that reads like a memory
  // artifact invites the model to reuse it as a title in MEMORY.md, which
  // the index-only assertion would then (correctly) fail.
  return `CORAL-${Math.floor(Math.random() * 9000 + 1000)}`;
}

// ---------------------------------------------------------------------------
// Argument parsing -- runs synchronously, before any context is booted, so a
// bad flag exits 2 with usage and NO context boot / NO turn sent.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  engine: EngineSelection;
  expectNoMemory: boolean;
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(message);
  console.error(
    'Usage: bun scripts/smoke/check-embedded-agent-memory-layer.ts [--] ' +
      '[--engine openai-api|claude-sdk|both] [--expect-no-memory]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let engine: EngineSelection = 'both';
  let expectNoMemory = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--engine') {
      const value = args[++i];
      if (value !== 'openai-api' && value !== 'claude-sdk' && value !== 'both') {
        printUsageAndExit(`invalid --engine value: ${String(value)}`);
      }
      engine = value;
    } else if (arg === '--expect-no-memory') {
      expectNoMemory = true;
    } else {
      printUsageAndExit(`unknown flag: ${arg}`);
    }
  }
  return { engine, expectNoMemory };
}

// ---------------------------------------------------------------------------
// Generic string-recursion helpers over a persisted `tool-call` event's
// `args` (whose shape differs per tool and per engine -- see this file's
// header comment on the `Read` builtin's `{ path }` vs a native SDK tool's
// `{ file_path }`), used by both the "did this event touch my memory dir"
// positive check and the "did this event mention the deleted nonce file"
// negative check.
// ---------------------------------------------------------------------------

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

function toolCallTouchesPrefix(event: Record<string, unknown>, prefix: string): boolean {
  if (event.type !== 'tool-call') return false;
  const strings: string[] = [];
  collectStrings((event as { args?: unknown }).args, strings);
  return strings.some((s) => s === prefix || s.startsWith(`${prefix}/`));
}

function toolCallMentionsAny(event: Record<string, unknown>, needles: string[]): boolean {
  if (event.type !== 'tool-call') return false;
  const strings: string[] = [];
  collectStrings((event as { args?: unknown }).args, strings);
  return strings.some((s) => needles.some((needle) => s === needle || s.includes(needle)));
}

// ---------------------------------------------------------------------------
// On-disk assertions for the planting turn: a topic file containing the
// nonce, and a MEMORY.md index line pointing at it.
// ---------------------------------------------------------------------------

function safeReaddirFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function findTopicFileContaining(memoryDir: string, nonce: string): string | null {
  for (const name of safeReaddirFiles(memoryDir)) {
    if (name === 'MEMORY.md') continue;
    const full = path.join(memoryDir, name);
    try {
      if (readFileSync(full, 'utf-8').includes(nonce)) return full;
    } catch {
      // Unreadable -- not a candidate.
    }
  }
  return null;
}

function memoryMdLinksTo(memoryMdContent: string, memoryDir: string, targetAbsPath: string): boolean {
  for (const line of memoryMdContent.split('\n')) {
    const match = line.match(MEMORY_INDEX_LINK_RE);
    if (!match) continue;
    const target = match[1];
    const resolved = path.isAbsolute(target) ? target : path.resolve(memoryDir, target);
    if (resolved === targetAbsPath) return true;
  }
  return false;
}

async function main(engine: EngineSelection, expectNoMemory: boolean): Promise<void> {
  // Ad-hoc invocation inherits the caller's cwd, which the spawn machinery
  // evaluates; an unreadable inherited cwd produces EACCES on posix_spawn.
  // Neutralized at script start, same as every sibling smoke.
  process.chdir('/');

  // --- Deferred imports: everything below transitively reaches server-config.ts.
  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { claudeSdkAgent } = await import('../../packages/server/src/services/embedded-agents/claude-sdk-builtin.js');
  const { SqliteEmbeddedAgentRepository } = await import(
    '../../packages/server/src/repositories/sqlite-embedded-agent-repository.js'
  );
  const { spawnAsUser } = await import('../../packages/server/src/services/privilege-elevation.js');
  const { computeSessionDataBaseDir } = await import('../../packages/server/src/lib/session-data-path.js');
  const { SessionDataPathResolver } = await import('../../packages/server/src/lib/session-data-path-resolver.js');
  const { createWorktreeWithSession } = await import(
    '../../packages/server/src/services/worktree-creation-service.js'
  );
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');

  // `hono` is hoisted under packages/server/node_modules, not under any
  // node_modules ancestor of scripts/smoke/ -- resolve it the way
  // packages/server would and import the resolved absolute path.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  const engines: EngineArm[] = engine === 'both' ? ['openai-api', 'claude-sdk'] : [engine];

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let home: string | undefined;

  // ---------------------------------------------------------------------
  // Init-frame observation tap (Q13 proxy (c)): a pure wrapper around the
  // REAL `spawnAsUser`. Records every `type: 'init'` NDJSON line written to
  // the real spawned subprocess's real stdin `FileSink`.
  // ---------------------------------------------------------------------
  const initFrames: Array<Record<string, unknown>> = [];

  function decodeChunk(chunk: unknown): string {
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
    if (chunk instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(chunk));
    return String(chunk);
  }

  function recordInitFrames(chunk: unknown): void {
    const text = decodeChunk(chunk);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.type === 'init') initFrames.push(parsed);
      } catch {
        // Non-JSON or a partial fragment -- not a concern for this
        // write-call-scoped tap (writeCommand always writes one complete
        // NDJSON line per stdin.write call).
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tapSpawnAsUserFn(opts: any): any {
    const result = spawnAsUser(opts);
    const realStdin = result.stdin;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxyStdin = new Proxy(realStdin as any, {
      get(target, prop, _receiver) {
        if (prop === 'write') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (chunk: any) => {
            recordInitFrames(chunk);
            return target.write(chunk);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...result, stdin: proxyStdin };
  }

  try {
    // -----------------------------------------------------------------
    // Disposable home + a shared FILE-backed database (Q13 proxy (d)):
    // needed so a throwaway "boot #1" context can persist a claude-sdk D2
    // definition that a SEPARATE, later "boot #2" context (the one this
    // script actually drives) loads through the real
    // EmbeddedAgentManager.initialize() startup path -- see this file's
    // header comment, proxy (d), for the full account.
    // -----------------------------------------------------------------
    home = path.join(os.tmpdir(), `ac-memory-layer-smoke-home-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', home]);

    // AGENT_CONSOLE_HOME must be set before the FIRST createTestContext call
    // below (`bootCtx`), not merely before the second one this script
    // actually drives -- createTestContext's own first statement is a
    // mkdir(getConfigDir()), and with AGENT_CONSOLE_HOME unset that resolves
    // to the operator's real data root, not this smoke's disposable home.
    // Also true for the later, more commonly cited reason: memory-dir
    // resolution reads getConfigDir() at call time, not at context
    // construction time, so this must precede the first activation too.
    process.env.AGENT_CONSOLE_HOME = home;

    const sharedDbPath = path.join(home, 'data.db');

    let claudeSdkD1Id: string | undefined;
    let claudeSdkD2Id: string | undefined;
    {
      // Boot-through unconditionally (simpler than branching the boot
      // itself), even for an openai-api-only run -- the only conditional
      // part is whether the claude-sdk rows get persisted into the shared
      // file. BOTH claude-sdk definitions (D1 the subject, D2 the control)
      // are smoke-persisted rows shaped like the builtin but carrying
      // SMOKE_ENABLED_TOOLS -- the builtin itself is not used by any arm
      // (see SMOKE_ENABLED_TOOLS).
      //
      // Guard: createTestContext's own initial mkdir(getConfigDir()) must
      // never run against the operator's real data root. Two explicit
      // checks -- before and after this createTestContext call -- each
      // throwing an Error (which the outer `main().catch(...)` below maps
      // to `process.exit(2)`) directly on a mismatch, mirroring the shape
      // probe-sdk-phase5-pr2-pc.ts's elevated arm landed at, rather than a
      // bare `expect()` whose result the final exit check might not
      // consult before the rest of the run has already touched the wrong
      // root. The SECOND createTestContext call below (`ctx`) needs no
      // additional guard -- AGENT_CONSOLE_HOME never changes between here
      // and there.
      const configDirBeforeBootCtx = getConfigDir();
      if (configDirBeforeBootCtx !== home) {
        throw new Error(
          `context data root is not the disposable home before the boot createTestContext: ` +
            `getConfigDir()=${configDirBeforeBootCtx} home=${home}`,
        );
      }
      const bootCtx = await createTestContext({ dbPath: sharedDbPath });
      const bootCtxConfigDir = getConfigDir();
      if (bootCtxConfigDir !== home) {
        throw new Error(
          `context data root is not the disposable home after the boot createTestContext: ` +
            `getConfigDir()=${bootCtxConfigDir} home=${home}`,
        );
      }
      try {
        if (engines.includes('claude-sdk')) {
          claudeSdkD1Id = `claude-sdk-smoke-d1-${process.pid}`;
          claudeSdkD2Id = `claude-sdk-smoke-d2-${process.pid}`;
          const now = new Date().toISOString();
          const repo = new SqliteEmbeddedAgentRepository(bootCtx.db);
          for (const [id, role] of [
            [claudeSdkD1Id, 'd1'],
            [claudeSdkD2Id, 'd2'],
          ] as const) {
            await repo.save({
              ...claudeSdkAgent,
              id,
              name: `memory-layer-smoke-claude-sdk-${role}-${process.pid}`,
              enabledTools: [...SMOKE_ENABLED_TOOLS],
              isBuiltIn: false,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      } finally {
        await shutdownAppContext(bootCtx);
      }
    }

    if (engines.includes('openai-api')) {
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
      await Bun.write(path.join(home, 'provider-keys.json'), JSON.stringify({ [PROVIDER_KEY_REF]: apiKey }));
      Bun.spawnSync(['chmod', '600', path.join(home, 'provider-keys.json')]);
    }

    let mcpBaseUrl = '';
    ctx = await createTestContext({
      getMcpBaseUrl: () => mcpBaseUrl,
      spawnAsUserFn: tapSpawnAsUserFn,
      dbPath: sharedDbPath,
      ...(expectNoMemory ? { ensureMemoryDirFn: async () => undefined } : {}),
    });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

    if (engines.includes('claude-sdk')) {
      if (!claudeSdkD1Id || !claudeSdkD2Id) {
        throw new Error('the claude-sdk definition ids were not set even though the claude-sdk arm is selected');
      }
      for (const id of [claudeSdkD1Id, claudeSdkD2Id]) {
        const loaded = ctx.embeddedAgentManager.getEmbeddedAgent(id);
        if (!loaded) {
          throw new Error(
            `claude-sdk definition (${id}) did not load from the shared file DB via ` +
              'EmbeddedAgentManager.initialize() -- the provisioning proxy did not reach the real boot path',
          );
        }
      }
    }

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

    // -----------------------------------------------------------------
    // Two disposable git repositories, one WITH a fake origin remote (a
    // two-segment "org/repo" slug) and one WITHOUT (a one-segment basename
    // slug) -- both slug shapes the Session Data Path design produces.
    // `home` is already under os.tmpdir() (see below), so it doubles as
    // `parentDir` here -- both scratch repos are removed along with the
    // rest of `home` in the `finally` block, no separate cleanup() calls.
    // -----------------------------------------------------------------
    const scratchRepo1 = await createScratchGitRepo({ parentDir: home, name: 'repo1-with-remote-' });
    const scratchRepo2 = await createScratchGitRepo({ parentDir: home, name: 'repo2-no-remote-' });
    const repo1Dir = scratchRepo1.dir;
    const repo2Dir = scratchRepo2.dir;
    const scratchRepoByDir = new Map<string, ScratchGitRepo>([
      [repo1Dir, scratchRepo1],
      [repo2Dir, scratchRepo2],
    ]);
    const nonceOrg = `smoke-org-${process.pid}`;
    const nonceRepo = `smoke-repo-${process.pid}`;
    await scratchRepo1.git(['remote', 'add', 'origin', `https://github.com/${nonceOrg}/${nonceRepo}.git`]);

    const repo1 = await ctx.repositoryManager.registerRepository(repo1Dir);
    const repo2 = await ctx.repositoryManager.registerRepository(repo2Dir);
    console.log(`==> repo1 (two-segment slug): ${repo1.id}`);
    console.log(`==> repo2 (one-segment slug): ${repo2.id}`);

    // -----------------------------------------------------------------
    // Shared helpers used by every engine arm.
    // -----------------------------------------------------------------
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

    const runTurn = async (
      sessionId: string,
      workerId: string,
      text: string,
      timeoutMs = 120_000,
    ): Promise<{ reply: string; events: Array<Record<string, unknown> & { type: string }> }> => {
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
          const reply = events
            .filter((e) => e.type === 'assistant-message')
            .map((e) => String(e.text ?? ''))
            .join('\n');
          return { reply, events };
        }
        await delay(500);
      }
      throw new Error('turn did not complete before the deadline');
    };

    const makeWorktree = async (repoDir: string, branch: string): Promise<string> => {
      const dir = path.join(home!, `worktree-${branch}`);
      const scratchRepo = scratchRepoByDir.get(repoDir);
      if (!scratchRepo) throw new Error(`makeWorktree: no scratch repo registered for ${repoDir}`);
      await scratchRepo.git(['worktree', 'add', dir, '-b', branch]);
      return dir;
    };

    const makeSession = async (
      repositoryId: string,
      worktreeId: string,
      locationPath: string,
      embeddedAgentId: string,
    ): Promise<{ sessionId: string; workerId: string }> => {
      const session = await ctx!.sessionManager.createSession(
        { type: 'worktree', repositoryId, worktreeId, locationPath, embeddedAgentId },
        { createdBy: owner.id },
      );
      const worker = session.workers.find((w) => w.type === 'embedded-agent');
      if (!worker) throw new Error(`session ${session.id} has no embedded-agent worker`);
      return { sessionId: session.id, workerId: worker.id };
    };

    const expectedMemoryDir = async (repositoryId: string, definitionId: string): Promise<string> => {
      const slug = await ctx!.repositoryManager.getRepositorySlug(repositoryId);
      if (!slug) throw new Error(`could not resolve repository slug for ${repositoryId}`);
      const baseDir = computeSessionDataBaseDir(home!, 'repository', slug);
      return new SessionDataPathResolver(baseDir, home!).getMemoryDir(definitionId, { kind: 'repository' });
    };

    const activateAndCapture = async (
      sessionId: string,
      workerId: string,
      label: string,
    ): Promise<Record<string, unknown>> => {
      const before = initFrames.length;
      await ctx!.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);
      const after = initFrames.length;
      expect(
        after === before + 1,
        `${label}: activation produced exactly one recorded init frame`,
        `before=${before} after=${after}`,
      );
      return initFrames[after - 1];
    };

    const assertMemoryDirInInit = (
      initFrame: Record<string, unknown>,
      expectedDir: string,
      label: string,
    ): void => {
      const context = (initFrame.context ?? {}) as Record<string, unknown>;
      if (expectNoMemory) {
        expect(
          !('memoryDir' in context),
          `${label}: init frame's context carries NO memoryDir key (polarity)`,
          `context=${JSON.stringify(context)}`,
        );
      } else {
        expect(
          context.memoryDir === expectedDir,
          `${label}: init frame's context.memoryDir matches the expected path`,
          `expected ${expectedDir}, got ${JSON.stringify(context.memoryDir)}`,
        );
      }
    };

    // -----------------------------------------------------------------
    // Per-engine-arm run.
    // -----------------------------------------------------------------
    async function runArm(armLabel: EngineArm, d1Id: string, d2Id: string): Promise<void> {
      console.log(`\n==> arm: ${armLabel}${expectNoMemory ? ' (--expect-no-memory)' : ''}`);
      const nonce = randomNonce();
      console.log(`  nonce: ${nonce}`);

      const branchPrefix = `smoke-mem-${armLabel}-${process.pid}`;
      const s1Dir = await makeWorktree(repo1Dir, `${branchPrefix}-s1`);
      const s2Dir = await makeWorktree(repo1Dir, `${branchPrefix}-s2`);

      const a = await makeSession(repo1.id, `${branchPrefix}-s1`, s1Dir, d1Id);
      const b = await makeSession(repo1.id, `${branchPrefix}-s2`, s2Dir, d1Id);

      const expectedDirA = await expectedMemoryDir(repo1.id, d1Id);
      const expectedDirB = expectedDirA; // Same (repository, definition) pair as A.

      // Plant the nonce via a tool call, not chat text.
      await Bun.write(path.join(s1Dir, NONCE_FILE), `The secret word is ${nonce}.\n`);

      const initA = await activateAndCapture(a.sessionId, a.workerId, `${armLabel} A`);
      assertMemoryDirInInit(initA, expectedDirA, `${armLabel} A`);

      const plantMarker = (await readEvents(a.sessionId, a.workerId)).length;
      const plantResult = await runTurn(a.sessionId, a.workerId, PLANT_TEXT);
      const plantEvents = (await readEvents(a.sessionId, a.workerId)).slice(plantMarker);
      expect(
        plantEvents.some((e) => e.type === 'tool-call'),
        `${armLabel}: the planting turn actually called a tool`,
        `events after the plant: ${plantEvents.map((e) => e.type).join(',')}`,
      );
      console.log(`  A plant reply: ${plantResult.reply.trim().slice(0, 120)}`);

      if (!expectNoMemory) {
        // MECHANISM pins (Architect ruling on run 4 at 48559c2b): the write
        // must land through the design's named mechanism -- the `Write` /
        // `Edit` tools under `enabledTools` -- and not through any shell.
        // Marker-scoped (plantEvents), read after the turn's idle, like the
        // recall pins. Reach measured on run 4 itself, before these pins
        // existed: the claude-sdk plant events as captured (a refused
        // `Write` -- "No such tool available: Write" -- followed by three
        // `mcp__agent-console__run_process` calls that wrote the files with
        // `printf`) FAIL both (i) and (ii); the openai-api plant events
        // (two `Write` calls under memoryDir) PASS both. The on-disk pins
        // below are mechanism-agnostic and stay.
        const plantToolCalls = plantEvents.filter((e) => e.type === 'tool-call');
        expect(
          plantToolCalls.some(
            (e) => (e.name === 'Write' || e.name === 'Edit') && toolCallTouchesPrefix(e, expectedDirA),
          ),
          `${armLabel}: the plant wrote under the memory directory with Write or Edit (the enabledTools mechanism)`,
          `tool calls: ${JSON.stringify(plantToolCalls.map((e) => ({ name: e.name, args: e.args }))).slice(0, 600)}`,
        );
        expect(
          !plantToolCalls.some((e) => String(e.name).includes('run_process')),
          `${armLabel}: the plant did NOT go through the run_process MCP shell`,
          `tool calls: ${plantToolCalls.map((e) => String(e.name)).join(',')}`,
        );

        const memoryDirExists = existsSync(expectedDirA);
        expect(memoryDirExists, `${armLabel}: the memory directory exists on disk after the planting turn`, expectedDirA);

        const topicFile = memoryDirExists ? findTopicFileContaining(expectedDirA, nonce) : null;
        expect(
          topicFile !== null,
          `${armLabel}: a topic file under the memory directory contains the planted nonce`,
          `memoryDir=${expectedDirA}`,
        );

        const memoryMdPath = path.join(expectedDirA, 'MEMORY.md');
        const memoryMdExists = existsSync(memoryMdPath);
        expect(memoryMdExists, `${armLabel}: MEMORY.md exists under the memory directory`, memoryMdPath);
        const memoryMdContent = memoryMdExists ? readFileSync(memoryMdPath, 'utf-8') : '';

        expect(
          !memoryMdContent.includes(nonce),
          `${armLabel}: MEMORY.md itself does NOT contain the nonce (index only, never the fact)`,
          `MEMORY.md content: ${memoryMdContent.slice(0, 300)}`,
        );

        if (topicFile !== null) {
          expect(
            memoryMdLinksTo(memoryMdContent, expectedDirA, topicFile),
            `${armLabel}: MEMORY.md has an index line pointing at the topic file`,
            `topicFile=${topicFile}, MEMORY.md content: ${memoryMdContent.slice(0, 300)}`,
          );
        }
      }

      // Close the second route: the nonce file has been used by the
      // planting turn; remove it so a later recall cannot answer from the
      // cwd file instead of from the memory layer.
      unlinkSync(path.join(s1Dir, NONCE_FILE));

      // Fresh worker, same (repository, definition) pair, never told the nonce.
      const initB = await activateAndCapture(b.sessionId, b.workerId, `${armLabel} B`);
      assertMemoryDirInInit(initB, expectedDirB, `${armLabel} B`);

      const recallMarker = (await readEvents(b.sessionId, b.workerId)).length;
      const recallResult = await runTurn(b.sessionId, b.workerId, RECALL_TEXT);
      console.log(`  B recall reply: ${recallResult.reply.trim().slice(0, 200)}`);
      const recallEvents = (await readEvents(b.sessionId, b.workerId)).slice(recallMarker);

      if (expectNoMemory) {
        expect(
          !recallResult.reply.includes(nonce),
          `${armLabel} (polarity): B did NOT recall the nonce with the memory layer absent`,
          `got: ${recallResult.reply.trim().slice(0, 300)}`,
        );
        expect(
          /\bUNKNOWN\b/.test(recallResult.reply),
          `${armLabel} (polarity): B answered UNKNOWN`,
          `got: ${recallResult.reply.trim().slice(0, 300)}`,
        );

        // With the seam returning `undefined`, the real mkdir never runs
        // either -- pin the absence on disk, not just on the wire.
        const memoryRootForRepo1 = path.join(
          computeSessionDataBaseDir(home!, 'repository', (await ctx!.repositoryManager.getRepositorySlug(repo1.id))!),
          'memory',
        );
        expect(
          !existsSync(memoryRootForRepo1),
          `${armLabel} (polarity): no memory/ directory was ever created for repo1's base dir`,
          memoryRootForRepo1,
        );
        return;
      }

      expect(
        recallResult.reply.includes(nonce),
        `${armLabel}: B recalled the nonce planted by A via the memory layer`,
        `expected ${nonce} in: ${recallResult.reply.trim().slice(0, 300)}`,
      );
      expect(
        recallEvents.some((e) => toolCallTouchesPrefix(e, expectedDirB)),
        `${armLabel}: B's recall used a tool call that touched the memory directory`,
        `events: ${recallEvents.map((e) => e.type).join(',')}`,
      );
      // Needle = S1's absolute cwd DIRECTORY, not the file path and not the
      // bare basename (Architect ruling on run 4 at 48559c2b). A substring
      // match over the args subsumes the deleted file's path and also
      // catches a Glob / Grep / shell over S1's tree; the bare basename was
      // a false positive on run 4 -- B, in S2, `Read` its OWN cwd's
      // `qa-note.txt` (ENOENT; the file never existed there) after the
      // topic file named it as its source, and the recall had already come
      // from the topic file. Precision holds: s1Dir and s2Dir are siblings
      // under the home, and memoryDir is under the home's base dir, so
      // neither contains the other.
      expect(
        !recallEvents.some((e) => toolCallMentionsAny(e, [s1Dir])),
        `${armLabel}: B's recall did NOT touch S1's cwd (the deleted nonce file's directory)`,
        `events: ${JSON.stringify(recallEvents.filter((e) => e.type === 'tool-call'))}`,
      );

      // --- Negative controls: C (same repo, DIFFERENT definition) and
      // D (same definition, DIFFERENT repo). Both REQUIRED to create and
      // activate -- a failure here is a harness problem (throws -> exit 2),
      // never a tolerated "skip".
      const s3Dir = await makeWorktree(repo1Dir, `${branchPrefix}-s3`);
      const s4Dir = await makeWorktree(repo2Dir, `${branchPrefix}-s4`);
      const c = await makeSession(repo1.id, `${branchPrefix}-s3`, s3Dir, d2Id);
      const d = await makeSession(repo2.id, `${branchPrefix}-s4`, s4Dir, d1Id);

      const expectedDirC = await expectedMemoryDir(repo1.id, d2Id);
      const expectedDirD = await expectedMemoryDir(repo2.id, d1Id);

      const initC = await activateAndCapture(c.sessionId, c.workerId, `${armLabel} C`);
      assertMemoryDirInInit(initC, expectedDirC, `${armLabel} C`);
      const initD = await activateAndCapture(d.sessionId, d.workerId, `${armLabel} D`);
      assertMemoryDirInInit(initD, expectedDirD, `${armLabel} D`);

      const controlC = await runTurn(c.sessionId, c.workerId, RECALL_TEXT);
      console.log(`  C (different definition) reply: ${controlC.reply.trim().slice(0, 200)}`);
      expect(
        !controlC.reply.includes(nonce),
        `${armLabel}: C (same repo, different definition) did NOT recall the nonce`,
        `got: ${controlC.reply.trim().slice(0, 300)}`,
      );
      expect(
        /\bUNKNOWN\b/.test(controlC.reply),
        `${armLabel}: C answered UNKNOWN`,
        `got: ${controlC.reply.trim().slice(0, 300)}`,
      );
      console.log(
        `  C used a tool: ${(await readEvents(c.sessionId, c.workerId)).some((e) => e.type === 'tool-call')}`,
      );

      const controlD = await runTurn(d.sessionId, d.workerId, RECALL_TEXT);
      console.log(`  D (different repository) reply: ${controlD.reply.trim().slice(0, 200)}`);
      expect(
        !controlD.reply.includes(nonce),
        `${armLabel}: D (same definition, different repository) did NOT recall the nonce`,
        `got: ${controlD.reply.trim().slice(0, 300)}`,
      );
      expect(
        /\bUNKNOWN\b/.test(controlD.reply),
        `${armLabel}: D answered UNKNOWN`,
        `got: ${controlD.reply.trim().slice(0, 300)}`,
      );
      console.log(
        `  D used a tool: ${(await readEvents(d.sessionId, d.workerId)).some((e) => e.type === 'tool-call')}`,
      );
    }

    for (const armLabel of engines) {
      if (armLabel === 'openai-api') {
        const d1 = await ctx.embeddedAgentManager.createEmbeddedAgent(
          {
            name: `memory-layer-smoke-openai-d1-${process.pid}`,
            description: 'Disposable definition D1 for the memory-layer E2E (epic #1636 Phase 2 PR-3b).',
            provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
            enabledTools: [...SMOKE_ENABLED_TOOLS],
          },
          owner.id,
        );
        const d2 = await ctx.embeddedAgentManager.createEmbeddedAgent(
          {
            name: `memory-layer-smoke-openai-d2-${process.pid}`,
            description: 'Disposable definition D2 (negative control) for the memory-layer E2E.',
            provider: { baseUrl: PROVIDER_BASE_URL, model: PROVIDER_MODEL, apiKeyRef: PROVIDER_KEY_REF },
            enabledTools: [...SMOKE_ENABLED_TOOLS],
          },
          owner.id,
        );
        await runArm('openai-api', d1.id, d2.id);
      } else {
        // Both ids were validated non-null and loaded above.
        await runArm('claude-sdk', claudeSdkD1Id!, claudeSdkD2Id!);
      }
    }
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
    if (home) Bun.spawnSync(['rm', '-rf', home]);
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  const { engine, expectNoMemory } = parseArgs(process.argv.slice(2));
  main(engine, expectNoMemory)
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
