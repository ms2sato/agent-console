#!/usr/bin/env bun
/**
 * Shipping-path E2E for the `set_mcp_server_permission` MCP tool (epic #1636
 * Phase 5 PR-3a, docs/design/embedded-agent-sdk-engine.md §4.5 D-C / D-D).
 * The tool itself (`packages/server/src/mcp/mcp-server.ts`),
 * the hoisted decision-resolution helper
 * (`packages/server/src/lib/mcp-server-permissions.ts`'s
 * `resolvePermissionDecisions` / `listAllowedProjectMcpServerPairs`), the
 * durable write (`SessionManager.setMcpServerPermissions`), the live-apply
 * forward (`EmbeddedAgentWorkerService.applyMcpServerPermissions`), and the
 * `claude-sdk` engine's own discovery/live-add mechanism
 * (`SdkEngine.setMcpServers` / `classifyMcpServerScope`,
 * `packages/embedded-agent/src/mcp-discovery.ts`) all have real, tested unit
 * coverage; this script is the ONE place that drives the whole chain through
 * a REAL `/mcp` transport, a REAL TUI-Orchestrator-shaped bearer token, and a
 * REAL `claude-sdk` embedded-agent subprocess spawning REAL stdio MCP
 * servers, exactly the shape PR-2's own Q13 record named as the visible gap
 * ("P-a on the production spawn").
 *
 * ============================================================================
 * WHAT THIS SCRIPT VERIFIES
 * ============================================================================
 *
 *   Polarity (ALWAYS runs first, every invocation): with no permission ever
 *   recorded, activating the target worker and sending one turn produces
 *   NEITHER fixture's canary, the discovered pairs both read `pending`, and
 *   no tool-call names either server. `--expect-no-permission` stops here
 *   (exit 0 = the polarity holds; a canary present = exit 1, a genuine
 *   failure, never tolerated). This is what proves "nothing starts without a
 *   record" BEFORE any billed positive arm runs.
 *
 *   Positive arms (continue from the SAME activation when the flag is
 *   absent):
 *     1. Allow `srv-allowed` through the tool -> `mcp-servers-applied
 *        {applied:true}` + its canary appears WITHOUT a restart (the live
 *        add, `Query.setMcpServers`) -> a turn asking the model to call its
 *        `probe_echo` tool actually calls it. `srv-pending`'s canary stays
 *        absent throughout.
 *     2. Restart (deactivate+activate, canaries reset first): `srv-allowed`
 *        starts FROM THE RECORD at construction time (no live-add needed --
 *        the durable half); `srv-pending` still absent.
 *     3. Edit `srv-pending`'s `.mcp.json` entry (append an arg) and restart:
 *        its discovered hash differs, still `pending`, canary absent -- then
 *        allow it BY THE NEW HASH -> live add -> canary appears (hash-change
 *        resilience on the shipping path).
 *     4. Negative controls, same run: (a) deny `srv-allowed`, restart -> its
 *        canary is absent (the durable half of a deny); (b) an EMBEDDED
 *        caller's token is refused with nothing persisted (the containment
 *        rule under the real transport); (c) with `CLAUDE_CONFIG_DIR`
 *        pointed at an isolated, empty (but present) config, no discovered
 *        event ever reports a `user`/`local`-scope row and
 *        `userLocalNamesUnavailable` is never set (the operator's own
 *        `~/.claude.json` is never read).
 *
 * ============================================================================
 * ORDERING NOTE -- history: why this script used to read discovered pairs
 * IMMEDIATELY after activation, before ANY turn was sent, and why arm 1 no
 * longer has to (a server-side fix closed the underlying race)
 * ============================================================================
 *
 * `sdk-engine.ts`'s own comments establish two facts that combine into a
 * race: (1) the SDK's `system:init` handshake never arrives until the FIRST
 * prompt is yielded -- "zero events of any kind while the queue is empty,
 * not even a spawn signal" -- so a declared MCP server is not actually
 * spawned until a turn is sent; and (2) EVERY `mcp-servers-discovered` event
 * (the activation-time one from `main.ts`, AND every later one driven by
 * `system:init`/`mcpServerStatus()` in `sdk-engine.ts`) fires up to three
 * times per activation. `system:init`'s own report only ever names servers
 * the CLI actually knows about (the reserved pair, plus whatever was already
 * resolved into `Options.mcpServers` at construction), so once a turn
 * triggers it, that later event's `servers[]` OMITS a not-yet-allowed
 * project entry's `hash`/`decision` entirely.
 *
 * When this script was first written, the server applied every arrival
 * LAST-WRITE-WINS over the worker's persisted `mcpServers` array -- so that
 * omission would silently ERASE the very (name, hash) pair the
 * activation-time discovery had just reported, and this script worked
 * around it by reading `get_session_status` for the discovered pairs BEFORE
 * the first turn of every (re)activation, specifically to read the
 * activation-time report before anything could overwrite it. That was a
 * script-side workaround for a server-side bug, not a design choice worth
 * keeping once the bug was fixed.
 *
 * The Architect diagnosed the workaround during this smoke's own polarity
 * run and ruled the server-side fix in the SAME PR that added this script
 * (`EmbeddedAgentWorkerService`'s `mcp-servers-discovered` handler now
 * MERGES: the activation-time discovery's `hash`/`decision` for a
 * project-scope row survives every later arrival, which is only
 * authoritative for `status` and for non-project rows). The polarity read
 * (this file's own `--expect-no-permission` arm) still reads BEFORE the
 * first turn, unchanged -- that arm's own point is confirming the
 * activation-time pending pair exists at all, not proving survival across a
 * turn. Arm 1's read, by contrast, now happens AFTER the polarity turn --
 * see the comment at that call site -- because a post-turn
 * read that still returns both hashes IS the regression-path proof: before
 * the fix, this exact read would have returned `decision: undefined` for
 * both fixtures and arm 1's `set_mcp_server_permission` call would have
 * failed with `not-discovered`. Arms 2 and 3's restart-triggered reads keep
 * reading immediately after activation (before that incarnation's own first
 * turn) for an unrelated reason -- they need each fresh incarnation's
 * activation-time hash regardless of the merge fix, and reading any earlier
 * or later within that incarnation makes no difference now that a later
 * arrival can no longer erase it.
 *
 * ============================================================================
 * Q13 SELF-PASS RECORD (`pre-pr-completeness.md` Q13)
 * ============================================================================
 *
 *   The "TUI Orchestrator" identity is a token MINTED by the real
 *   `McpTokenRegistry` for a real, non-embedded (`type: 'agent'`) worker
 *   (a quick session's PTY-agent worker), rather than read from that
 *   worker's own token file. This substitutes HOW the caller identity
 *   arrives at the request -- upstream of, and outside, the chain under
 *   test (the tool's authorization logic, the target session/worker
 *   resolution, the durable write, the live-apply forward, and the engine's
 *   own discovery/live-add). Everything downstream of that header is real:
 *   the `/mcp` transport, `checkCallerOwnsSession`, the embedded-caller
 *   refusal, the hoisted decision-resolution helper, the durable repository
 *   write, and a real `claude-sdk` subprocess spawning real stdio fixtures.
 *
 *   Negative control (c)'s `CLAUDE_CONFIG_DIR` is `isolateClaudeConfigDir`'s
 *   throwaway directory holding a COPY of the operator's own real
 *   `~/.claude/.credentials.json` -- the recorded proxy for "the operator's
 *   own login" (upstream of, and outside, the chain under test: the
 *   negative control is about what `readUserLocalMcpNames` reads from
 *   `.claude.json`, never about how the credential itself was obtained).
 *   The directory's own `.claude.json` is written by this script (a plain
 *   `{}`), not by `isolateClaudeConfigDir` -- see that call site's own
 *   comment for why an absent file is untestable here.
 *
 * ============================================================================
 * SINGLE-USER ONLY
 * ============================================================================
 *
 * `AGENT_CONSOLE_MCP_AUTH=enforce` is passed DIRECTLY as a `createMcpApp`
 * construction-time override (`mcpAuthMode: 'enforce'`), never through
 * `resolveMcpAuthMode()`'s env resolution -- that resolver throws for an
 * explicit `enforce` outside `AUTH_MODE=multi-user` (bearer tokens are only
 * ever MINTED in multi-user mode in production; the override seam exists
 * exactly for a single-user test/smoke harness like this one, the same seam
 * every `set_mcp_server_permission` / `set_agent_parameters` unit test
 * already uses). `AUTH_MODE` itself stays unset (single-user), so the
 * `2775`/service-group multi-user data-root contract is not exercised here.
 *
 * COST: about 5-6 real Claude turns per full run (1 polarity + 1 probe_echo
 * call + 3 restart-triggering turns + a spare). Small, but real Claude usage
 * -- a manual tool, never a CI gate.
 *
 * REQUIREMENTS
 *   - A real, authenticated `claude` CLI for the invoking OS user (the
 *     `claude-sdk` builtin runs as the executing user and uses that user's
 *     own authentication -- no API key to configure).
 *   - `bun install` already run in this checkout.
 *   - Linux (the orphan-canary-process teardown sweep reads /proc; on any
 *     other platform every recorded pid is reported, never probed).
 *
 * USAGE
 *   bun scripts/smoke/check-embedded-agent-project-mcp-permission.ts [--] \
 *     [--expect-no-permission]
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  an assertion failed (the system is wrong)
 *   2  the probe could not run (bad usage, missing prerequisite, launch
 *      failure) -- deliberately distinct from 1, so an operator can tell
 *      "permissions are broken" from "this script never got to look"
 */

// --- CRITICAL ordering: `serverConfig` computes its values at MODULE-LOAD
// time, so every module that transitively imports server-config.ts must be
// loaded via a DYNAMIC import made from inside main(), not a static import
// at the top of this file -- same hazard as every sibling smoke (see
// check-embedded-agent-idle-eviction.ts's header comment for the full
// account).

import { Glob } from 'bun';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppContext } from '../../packages/server/src/app-context.js';
import { createScratchGitRepo } from '../../packages/server/src/__tests__/utils/scratch-git.js';
import { parseLedger, matchesLedgerEntry, type LedgerEntry } from './probe-sdk-mcp-settings-sources.js';
import { isolateClaudeConfigDir } from './probe-sdk-session-harness.js';

const FIXTURE_PATH = path.join(import.meta.dir, 'fixtures', 'stdio-echo-mcp-server.ts');

interface DiscoveredServerLite {
  name: string;
  scope: string;
  hash?: string;
  decision?: string;
  status?: string;
}

interface EventLite {
  type: string;
  [key: string]: unknown;
}

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

async function waitUntil(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(300);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Pure, exported helpers -- unit-tested directly in
// scripts/smoke/__tests__/check-embedded-agent-project-mcp-permission.test.ts
// (which never runs main()).
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  expectNoPermission: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let expectNoPermission = false;
  for (const arg of args) {
    if (arg === '--expect-no-permission') {
      expectNoPermission = true;
    } else {
      console.error(`unknown flag: ${arg}`);
      console.error(
        'Usage: bun scripts/smoke/check-embedded-agent-project-mcp-permission.ts [--] [--expect-no-permission]',
      );
      process.exit(2);
    }
  }
  return { expectNoPermission };
}

/** Finds one discovered-server entry by name in a `mcp-servers-discovered` event's `servers` array, or `get_session_status`'s equivalent `mcpServers` field. */
export function findDiscoveredServer(
  servers: DiscoveredServerLite[] | undefined,
  name: string,
): DiscoveredServerLite | undefined {
  return (servers ?? []).find((s) => s.name === name);
}

/**
 * CodeRabbit review finding (Minor): `callMcpTool`'s `data` field is `unknown`
 * -- it is `undefined` whenever the tool call has no content block or the
 * content failed to JSON.parse (see `callMcpTool`'s own `try { data =
 * rawText ? JSON.parse(rawText) : undefined } catch { data = undefined }`).
 * A bare `res.data as { workers?: ... }` cast does not change that at
 * runtime: reading `.workers` off `undefined` throws `TypeError`, and an
 * uncaught throw here means main()'s `catch` reports "PROBE COULD NOT RUN"
 * (exit 2) instead of a plain assertion failure (exit 1) -- the crash
 * masks whatever real signal the poll/read was trying to observe. This
 * guard makes the shape check explicit so every caller can treat a
 * malformed payload as "no data yet" rather than crashing.
 */
export function isSessionStatusPayload(
  data: unknown,
): data is { workers: Array<{ id: string; mcpServers?: DiscoveredServerLite[] }> } {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as Record<string, unknown>).workers)
  );
}

/** Whether any `tool-call` event in `events` named the given MCP server's namespaced tool (`mcp__<serverName>__...`). */
export function hasToolCallForServer(events: EventLite[], serverName: string): boolean {
  const prefix = `mcp__${serverName}__`;
  return events.some((e) => e.type === 'tool-call' && typeof e.name === 'string' && e.name.startsWith(prefix));
}

/** Whether any `mcp-servers-discovered` event in `events` reported a `user` or `local`-scope row. */
export function hasUserOrLocalScopeEntry(events: EventLite[]): boolean {
  return events.some(
    (e) =>
      e.type === 'mcp-servers-discovered' &&
      Array.isArray(e.servers) &&
      (e.servers as DiscoveredServerLite[]).some((s) => s.scope === 'user' || s.scope === 'local'),
  );
}

/** Whether any `mcp-servers-discovered` event in `events` declared `userLocalNamesUnavailable`. */
export function anyUserLocalNamesUnavailable(events: EventLite[]): boolean {
  return events.some((e) => e.type === 'mcp-servers-discovered' && e.userLocalNamesUnavailable === true);
}

// ---------------------------------------------------------------------------
// Orphan-canary-process teardown sweep. Reuses the SHARED PURE parsing/
// identity functions (`parseLedgerLine` / `parseLedger` / `matchesLedgerEntry`)
// exported by `probe-sdk-mcp-settings-sources.ts` rather than re-implementing
// them (`workflow.md`'s Duplication check). What is NOT reused is that
// module's own `sweepOrphanCanaryProcesses` orchestration function: it is
// module-private and closed over that module's own `fixturesCanaryDir` /
// `spawnLedgerPath()` state, so it cannot be imported directly. The ~20-line
// orchestration loop below is therefore a deliberate, small, documented
// duplicate of that module's orchestration SHAPE (read the ledger, confirm
// identity via /proc, SIGKILL only a confirmed match) -- reported to the
// requester as the Q6 disclosure this rule asks for, rather than silently
// re-implementing the pure logic too.
// ---------------------------------------------------------------------------

interface OrphanSweepResult {
  checked: number;
  survivors: number[];
  killed: number[];
  reportedOnly: number[];
}

function readProcFile(path: string): { content: string | null; permissionDenied: boolean } {
  try {
    return { content: readFileSync(path, 'utf8'), permissionDenied: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { content: null, permissionDenied: code === 'EACCES' || code === 'EPERM' };
  }
}

function sweepOrphanFixtureProcesses(ledgerPath: string): OrphanSweepResult {
  const result: OrphanSweepResult = { checked: 0, survivors: [], killed: [], reportedOnly: [] };
  let ledgerContent: string;
  try {
    ledgerContent = readFileSync(ledgerPath, 'utf8');
  } catch {
    return result;
  }
  const entries: LedgerEntry[] = parseLedger(ledgerContent);
  result.checked = entries.length;
  if (process.platform !== 'linux') {
    for (const entry of entries) result.reportedOnly.push(entry.pid);
    return result;
  }
  for (const entry of entries) {
    const stat = readProcFile(`/proc/${entry.pid}/stat`);
    if (stat.content === null) {
      if (stat.permissionDenied) result.reportedOnly.push(entry.pid);
      continue;
    }
    const cmdline = readProcFile(`/proc/${entry.pid}/cmdline`);
    if (cmdline.content === null) {
      result.reportedOnly.push(entry.pid);
      continue;
    }
    if (matchesLedgerEntry(entry.starttime, stat.content, cmdline.content, FIXTURE_PATH)) {
      result.survivors.push(entry.pid);
      try {
        process.kill(entry.pid, 'SIGKILL');
        result.killed.push(entry.pid);
      } catch {
        // Still a confirmed survivor even if the kill itself failed.
      }
    } else {
      result.reportedOnly.push(entry.pid);
    }
  }
  return result;
}

async function main(expectNoPermission: boolean): Promise<void> {
  // Ad-hoc invocation inherits the caller's cwd, which the spawn machinery
  // evaluates; an unreadable inherited cwd produces EACCES on posix_spawn.
  // Neutralized at script start, same as every sibling smoke.
  process.chdir('/');

  // --- Deferred imports: everything below transitively reaches server-config.ts.
  const { createTestContext, shutdownAppContext } = await import('../../packages/server/src/app-context.js');
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { CLAUDE_SDK_AGENT_ID } = await import('../../packages/server/src/services/embedded-agent-manager.js');
  const { CLAUDE_CODE_AGENT_ID } = await import('../../packages/server/src/services/agent-manager.js');
  const { createWorktreeWithSession } = await import('../../packages/server/src/services/worktree-creation-service.js');
  const { deleteWorktree } = await import('../../packages/server/src/services/worktree-deletion-service.js');

  // `hono` is hoisted under packages/server/node_modules, not under any
  // node_modules ancestor of scripts/smoke/ -- resolve it the way
  // packages/server would and import the resolved absolute path.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let home: string | undefined;
  let ledgerPath: string | undefined;
  let isolatedConfigDir: string | undefined;

  try {
    home = path.join(os.tmpdir(), `ac-mcp-permission-smoke-home-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', home]);
    process.env.AGENT_CONSOLE_HOME = home;

    // --- Negative control (c): an isolated, EMPTY-but-PRESENT CLAUDE_CONFIG_DIR.
    // `isolateClaudeConfigDir` (probe-sdk-session-harness.ts) creates a
    // throwaway `CLAUDE_CONFIG_DIR` holding ONLY a copy of the operator's own
    // `~/.claude/.credentials.json` -- the recorded proxy for "the operator's
    // own login" (Q13: upstream of, and outside, the chain under test), the
    // same isolation shape every sibling probe in this directory uses. It is
    // NOT modified here -- it stays the single writer of "credentials only";
    // every other caller of it depends on that. This script writes its OWN
    // `.claude.json` into the returned directory, one line below, instead.
    isolatedConfigDir = isolateClaudeConfigDir('mcp-permission');
    // ENOENT -> unavailable; `{}` -> empty (measured 2026-09-21). Without
    // this line, `.claude.json` is simply absent, and `readUserLocalMcpNames`
    // (mcp-discovery.ts) treats an absent file as a READ FAILURE
    // (`unavailable: true`) -- which would make this negative control
    // untestable, since an `unavailable: true` run proves nothing about "no
    // user-scope names configured", only "the file could not be read at
    // all". Writing `{}` makes the read succeed with a genuinely-empty name
    // set instead, which is the actual state under test.
    writeFileSync(path.join(isolatedConfigDir, '.claude.json'), '{}\n');

    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    const osUid = process.getuid?.() ?? 0;
    const username = os.userInfo().username;
    const owner = await ctx.userRepository.upsertByOsUid(osUid, username, os.homedir());

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
        suggestSessionMetadata: async () => ({ branch: 'unused', title: 'unused' }),
        createWorktreeWithSession,
        deleteWorktree,
        userRepository: ctx.userRepository,
        artifactRepository: ctx.artifactRepository,
        bookmarkRepository: ctx.bookmarkRepository,
        broadcastToApp: () => {},
        fetchPullRequestUrl: async () => null,
        findOpenPullRequest: async () => null,
        mcpTokenRegistry: ctx.mcpTokenRegistry,
        // Passed DIRECTLY (never via AGENT_CONSOLE_MCP_AUTH/resolveMcpAuthMode,
        // which throws for an explicit 'enforce' outside AUTH_MODE=multi-user)
        // -- see this file's header comment, "SINGLE-USER ONLY".
        mcpAuthMode: 'enforce',
      }),
    );
    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;

    // -----------------------------------------------------------------
    // One scratch git repository + one worktree session (the target).
    // `home` is already under os.tmpdir() (see above), so it doubles as
    // `parentDir` here -- the scratch repo is removed along with the rest
    // of `home` in the `finally` block below, no separate cleanup() call.
    // -----------------------------------------------------------------
    const scratchRepo = await createScratchGitRepo({ parentDir: home, name: 'repo-' });
    const repoDir = scratchRepo.dir;

    const repo = await ctx.repositoryManager.registerRepository(repoDir);
    console.log(`==> repository: ${repo.id}`);

    const worktreeDir = path.join(home, 'worktree');
    await scratchRepo.git(['worktree', 'add', worktreeDir, '-b', `smoke-mcp-permission-${process.pid}`]);

    const targetSession = await ctx.sessionManager.createSession(
      { type: 'worktree', repositoryId: repo.id, worktreeId: 'main', locationPath: worktreeDir, embeddedAgentId: CLAUDE_SDK_AGENT_ID },
      { createdBy: owner.id },
    );
    const targetWorker = targetSession.workers.find((w) => w.type === 'embedded-agent');
    if (!targetWorker) throw new Error('target session has no embedded-agent worker');
    const targetSessionId = targetSession.id;
    const targetWorkerId = targetWorker.id;

    // --- Two stdio fixtures, declared in the worktree's own .mcp.json. ---
    const canaryDir = path.join(home, 'canaries');
    Bun.spawnSync(['mkdir', '-p', canaryDir]);
    ledgerPath = path.join(canaryDir, 'spawns.ledger');
    const canaryPath = (name: string): string => path.join(canaryDir, `${name}.touched`);
    const resetCanary = (name: string): void => {
      const p = canaryPath(name);
      if (existsSync(p)) unlinkSync(p);
    };

    function writeMcpJson(pendingExtraArg: string | undefined): void {
      const pendingArgs = [FIXTURE_PATH, '--canary', canaryPath('srv-pending'), '--ledger', ledgerPath!];
      if (pendingExtraArg !== undefined) pendingArgs.push('--env-var', pendingExtraArg);
      writeFileSync(
        path.join(worktreeDir, '.mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              'srv-allowed': {
                command: process.execPath,
                args: [FIXTURE_PATH, '--canary', canaryPath('srv-allowed'), '--ledger', ledgerPath],
              },
              'srv-pending': {
                command: process.execPath,
                args: pendingArgs,
              },
            },
          },
          null,
          2,
        ),
      );
    }
    writeMcpJson(undefined);

    // -----------------------------------------------------------------
    // Callers: a TUI Orchestrator (a quick session's PTY-agent worker) and
    // an embedded caller (a quick session's embedded-agent worker, never
    // activated) -- see this file's Q13 record for what each substitutes.
    // -----------------------------------------------------------------
    const tuiSession = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: worktreeDir, agentId: CLAUDE_CODE_AGENT_ID },
      { createdBy: owner.id },
    );
    const tuiWorkerId = tuiSession.workers[0].id;
    const tuiToken = ctx.mcpTokenRegistry.mint({ sessionId: tuiSession.id, workerId: tuiWorkerId, userId: owner.id });

    const embeddedCallerSession = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: worktreeDir },
      { createdBy: owner.id },
    );
    const embeddedCallerWorker = await ctx.sessionManager.createWorker(embeddedCallerSession.id, {
      type: 'embedded-agent',
      embeddedAgentId: CLAUDE_SDK_AGENT_ID,
    });
    if (!embeddedCallerWorker) throw new Error('failed to create the embedded caller worker');
    const embeddedCallerToken = ctx.mcpTokenRegistry.mint({
      sessionId: embeddedCallerSession.id,
      workerId: embeddedCallerWorker.id,
      userId: owner.id,
    });

    // -----------------------------------------------------------------
    // Shared helpers.
    // -----------------------------------------------------------------
    const readEvents = async (sessionId: string, workerId: string): Promise<EventLite[]> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId, workerId);
      const events: EventLite[] = [];
      if (!hist) return events;
      for (const line of hist.data.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (typeof json.type === 'string') events.push(json as EventLite);
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
    ): Promise<{ reply: string; events: EventLite[] }> => {
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

    /** Polls `readEvents` (async, unlike `waitUntil`'s synchronous `cond`) until a matching event lands. */
    async function waitForEvent(
      sessionId: string,
      workerId: string,
      sinceIndex: number,
      predicate: (e: EventLite) => boolean,
      timeoutMs: number,
      label: string,
    ): Promise<EventLite> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = (await readEvents(sessionId, workerId)).slice(sinceIndex);
        const found = events.find(predicate);
        if (found) return found;
        await delay(300);
      }
      throw new Error(`timed out waiting for: ${label}`);
    }

    async function callMcpTool(
      toolName: string,
      args: Record<string, unknown>,
      authorizationHeader: string,
    ): Promise<{ status: number; isError: boolean | undefined; data: unknown; text: string }> {
      const res = await fetch(mcpBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: authorizationHeader,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: toolName, arguments: args },
          id: 1,
        }),
      });
      const text = await res.text();
      let body: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
      const rawText = body.result?.content?.[0]?.text;
      let data: unknown;
      try {
        data = rawText ? JSON.parse(rawText) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, isError: body.result?.isError, data, text };
    }

    /**
     * Diagnosed 2026-09-21 (follow-up investigation): a clean `deactivate()`
     * NEVER clears `worker.mcpServers` -- only the Q14 activation-FAILURE
     * rollback does (`embedded-agent-worker-service.ts`'s `worker.mcpServers
     * = undefined` sits exclusively in that catch block). So across a
     * restart, the PREVIOUS incarnation's `mcpServers` value survives
     * untouched on the `worker` object, and a bare `!== undefined` check
     * (this function's own prior implementation) is satisfied the INSTANT
     * `activateEmbeddedAgentWorker()` returns -- before the new
     * incarnation's subprocess has even spawned, let alone reported its own
     * discovery. That is a read-too-early bug (test-trigger.md's "Absence
     * assertions are the ones read-too-early makes pass falsely" applies
     * here to a PRESENCE check the same way: an unscoped `!== undefined`
     * check is satisfiable by a value that predates the event entirely),
     * and it is DETERMINISTIC, not an occasional flake: the condition is
     * already true before the subprocess exists, so the very first
     * `waitUntil` poll always short-circuits.
     *
     * Fixed by scoping the wait to "the value CHANGED from what it was
     * before this activation", via reference inequality against a
     * `baselineMcpServers` snapshot captured immediately before
     * `activateEmbeddedAgentWorker()` is even called. This is sound because
     * the service's `mcp-servers-discovered` handler always assigns a BRAND
     * NEW array to `worker.mcpServers` on every event it processes (both
     * the merge branch and the defensive fallback construct a fresh array
     * literal), so a changed reference is exactly, and only, "a discovered
     * event for the CURRENT incarnation has been processed" -- never
     * satisfied by the previous incarnation's leftover value, regardless of
     * whether its CONTENT happens to be identical.
     */
    const activate = async (label: string): Promise<void> => {
      const baselineWorker = ctx!.sessionManager.getWorker(targetSessionId, targetWorkerId);
      const baselineMcpServers = baselineWorker?.type === 'embedded-agent' ? baselineWorker.mcpServers : undefined;
      await ctx!.sessionManager.activateEmbeddedAgentWorker(targetSessionId, targetWorkerId);
      await waitUntil(
        () => {
          const w = ctx!.sessionManager.getWorker(targetSessionId, targetWorkerId);
          return !!w && w.type === 'embedded-agent' && w.mcpServers !== undefined && w.mcpServers !== baselineMcpServers;
        },
        30_000,
        `${label}: activation-time mcp-servers-discovered event`,
      );
    };

    /**
     * Reads the discovered pairs via the REAL `get_session_status` MCP tool
     * call, over the SAME `/mcp` transport, using the TUI Orchestrator's
     * bearer token -- exercising the wire read-side this PR adds. Called
     * immediately after activation/restart, BEFORE any turn -- see this
     * file's header "ORDERING NOTE".
     */
    const readDiscoveredViaWire = async (label: string): Promise<DiscoveredServerLite[]> => {
      const res = await callMcpTool('get_session_status', { sessionId: targetSessionId }, `Bearer ${tuiToken}`);
      expect(!res.isError, `${label}: get_session_status succeeded`, res.text.slice(0, 300));
      // Malformed/absent payload (no content block, or JSON.parse failure --
      // see `isSessionStatusPayload`'s own doc comment) is NOT thrown here:
      // `!res.isError` above already reported the real failure; `workerRow`
      // just stays undefined so the assertion below reports it too, instead
      // of a `TypeError` masking whatever `get_session_status` actually said.
      const workerRow = isSessionStatusPayload(res.data)
        ? res.data.workers.find((w) => w.id === targetWorkerId)
        : undefined;
      expect(workerRow !== undefined, `${label}: get_session_status reports the target worker`, res.text.slice(0, 300));
      return workerRow?.mcpServers ?? [];
    };

    /**
     * CHANGES-REQUESTED (Item 1): polls the SAME `get_session_status`
     * MCP tool `readDiscoveredViaWire` uses -- no new turn, no billing -- until
     * `serverName`'s discovered row satisfies `predicate` or `timeoutMs`
     * elapses, returning whatever the LAST poll saw either way. Deliberately
     * bypasses `readDiscoveredViaWire`'s own `expect()` calls (which would
     * otherwise register one pass per poll iteration, inflating the run's
     * pass count for what is really one check); the caller asserts once on
     * the returned value.
     */
    const pollDiscoveredServer = async (
      serverName: string,
      predicate: (server: DiscoveredServerLite | undefined) => boolean,
      timeoutMs: number,
    ): Promise<DiscoveredServerLite | undefined> => {
      const deadline = Date.now() + timeoutMs;
      let last: DiscoveredServerLite | undefined;
      do {
        const res = await callMcpTool('get_session_status', { sessionId: targetSessionId }, `Bearer ${tuiToken}`);
        // A malformed/absent payload on ANY single poll is not fatal --
        // treat it as "no reading yet" and keep polling (the same
        // fail-closed-but-keep-trying shape `readDiscoveredViaWire` uses at
        // its single call site, applied across a loop here instead).
        const workerRow = isSessionStatusPayload(res.data)
          ? res.data.workers.find((w) => w.id === targetWorkerId)
          : undefined;
        last = findDiscoveredServer(workerRow?.mcpServers, serverName);
        if (predicate(last)) return last;
        await delay(300);
      } while (Date.now() < deadline);
      return last;
    };

    // ===================================================================
    // POLARITY (always first).
    // ===================================================================
    console.log(`\n==> polarity${expectNoPermission ? ' (--expect-no-permission)' : ''}`);
    await activate('polarity');

    const initialDiscovered = await readDiscoveredViaWire('polarity');
    const initialAllowed = findDiscoveredServer(initialDiscovered, 'srv-allowed');
    const initialPending = findDiscoveredServer(initialDiscovered, 'srv-pending');
    expect(
      initialAllowed?.decision === 'pending' && initialPending?.decision === 'pending',
      'polarity: both fixtures are discovered as pending before any permission is recorded',
      JSON.stringify(initialDiscovered),
    );
    expect(
      typeof initialAllowed?.hash === 'string' && typeof initialPending?.hash === 'string',
      'polarity: both fixtures carry a computed hash',
      JSON.stringify(initialDiscovered),
    );

    const polarityTurn = await runTurn(targetSessionId, targetWorkerId, 'Reply with only the word DONE.');
    console.log(`  polarity turn reply: ${polarityTurn.reply.trim().slice(0, 120)}`);

    expect(!existsSync(canaryPath('srv-allowed')), 'polarity: srv-allowed canary is absent', canaryPath('srv-allowed'));
    expect(!existsSync(canaryPath('srv-pending')), 'polarity: srv-pending canary is absent', canaryPath('srv-pending'));
    expect(
      !hasToolCallForServer(polarityTurn.events, 'srv-allowed') && !hasToolCallForServer(polarityTurn.events, 'srv-pending'),
      'polarity: no tool-call named either fixture server',
      JSON.stringify(polarityTurn.events.filter((e) => e.type === 'tool-call')),
    );

    if (expectNoPermission) {
      console.log('\n==> --expect-no-permission: stopping after the polarity check.');
      await ctx.sessionManager.deactivateEmbeddedAgentWorker(targetSessionId, targetWorkerId).catch(() => {});
      return;
    }

    // Read the discovered pairs AGAIN, now AFTER the polarity
    // turn -- this is the actual regression-path proof, not a diagnostic.
    // Before the fix, `sdk-engine.ts`'s `system:init` handler
    // (`emitMcpServersDiscovered`, fired as a side effect of the turn just
    // sent) would have REPLACED `worker.mcpServers` wholesale with a
    // reading that never carries `hash`/`decision` for ANY entry --
    // silently erasing the very pair `set_mcp_server_permission` needs to
    // find `srv-allowed`/`srv-pending` by. See this file's header "ORDERING
    // NOTE" for the fuller account of why this read used to have to happen
    // BEFORE the turn instead.
    const postTurnDiscovered = await readDiscoveredViaWire('post-polarity-turn');
    const allowedHash = findDiscoveredServer(postTurnDiscovered, 'srv-allowed')?.hash;
    const pendingHashV1 = findDiscoveredServer(postTurnDiscovered, 'srv-pending')?.hash;
    expect(
      typeof allowedHash === 'string' && typeof pendingHashV1 === 'string',
      'post-polarity-turn: both fixtures still carry their discovered hash (the regression path this fix closes)',
      JSON.stringify(postTurnDiscovered),
    );

    if (allowedHash === undefined || pendingHashV1 === undefined) {
      throw new Error('cannot continue to the positive arms without both fixtures\' discovered hashes');
    }

    // ===================================================================
    // POSITIVE ARM 1: live add of srv-allowed.
    // ===================================================================
    console.log('\n==> positive arm 1: allow srv-allowed (live add)');
    const applyBaseline1 = (await readEvents(targetSessionId, targetWorkerId)).length;
    const allow1 = await callMcpTool(
      'set_mcp_server_permission',
      { sessionId: targetSessionId, workerId: targetWorkerId, name: 'srv-allowed', hash: allowedHash, decision: 'allow' },
      `Bearer ${tuiToken}`,
    );
    expect(!allow1.isError, 'arm1: set_mcp_server_permission (allow srv-allowed) succeeded', allow1.text.slice(0, 300));

    const applied1 = await waitForEvent(
      targetSessionId,
      targetWorkerId,
      applyBaseline1,
      (e) => e.type === 'mcp-servers-applied',
      20_000,
      'arm1: mcp-servers-applied',
    );
    expect(applied1.applied === true, 'arm1: mcp-servers-applied reports applied:true', JSON.stringify(applied1));

    // CHANGES-REQUESTED (Item 1): the live allow must be visible
    // via `get_session_status` as `decision: 'allowed'` -- not reverted to
    // `pending` by the `mcp-servers-discovered` form (c) event
    // `applyMcpServersOnce` emits right after `mcp-servers-applied`
    // (`sdk-engine.ts`: `mcpServerStatus()` is awaited, then
    // `emitMcpServersDiscovered(status)` fires) -- alongside a
    // `status: 'connected'` that must NOT be paired with a
    // self-contradictory `decision: 'pending'`. No new turn: polls the same
    // free `get_session_status` tool call already used above.
    const allowedAfterApply1 = await pollDiscoveredServer(
      'srv-allowed',
      (s) => s?.decision === 'allowed' && s?.status === 'connected',
      15_000,
    );
    expect(
      allowedAfterApply1?.decision === 'allowed' && allowedAfterApply1?.status === 'connected',
      'arm1: srv-allowed reads decision:allowed + status:connected via get_session_status after the live apply',
      JSON.stringify(allowedAfterApply1),
    );

    await waitUntil(() => existsSync(canaryPath('srv-allowed')), 15_000, 'arm1: srv-allowed canary appears').catch(
      (err) => expect(false, 'arm1: srv-allowed canary appears (live add)', String(err)),
    );
    expect(existsSync(canaryPath('srv-allowed')), 'arm1: srv-allowed canary is present after the live add');
    expect(!existsSync(canaryPath('srv-pending')), 'arm1: srv-pending canary is still absent');

    const echoTurn = await runTurn(
      targetSessionId,
      targetWorkerId,
      'Call the tool named exactly mcp__srv-allowed__probe_echo with no arguments, then reply with the JSON text it returned, verbatim.',
    );
    console.log(`  arm1 echo turn reply: ${echoTurn.reply.trim().slice(0, 200)}`);
    expect(
      hasToolCallForServer(echoTurn.events, 'srv-allowed'),
      'arm1: the turn actually called the srv-allowed tool',
      JSON.stringify(echoTurn.events.filter((e) => e.type === 'tool-call')),
    );
    expect(!existsSync(canaryPath('srv-pending')), 'arm1: srv-pending canary is still absent after the echo turn');

    // ===================================================================
    // POSITIVE ARM 2: restart -- srv-allowed starts from the durable record.
    // ===================================================================
    console.log('\n==> positive arm 2: restart, srv-allowed persists');
    resetCanary('srv-allowed');
    resetCanary('srv-pending');
    await ctx.sessionManager.deactivateEmbeddedAgentWorker(targetSessionId, targetWorkerId);
    await activate('arm2 restart');
    await readDiscoveredViaWire('arm2 restart'); // exercise the read side again; not needed for hashes here.
    await runTurn(targetSessionId, targetWorkerId, 'Reply with only the word DONE.');
    expect(existsSync(canaryPath('srv-allowed')), 'arm2: srv-allowed canary present after restart (from the record)');
    expect(!existsSync(canaryPath('srv-pending')), 'arm2: srv-pending canary still absent after restart');

    // ===================================================================
    // POSITIVE ARM 3: change srv-pending's config, restart, allow by new hash.
    // ===================================================================
    console.log('\n==> positive arm 3: srv-pending config change + allow by new hash');
    resetCanary('srv-allowed');
    resetCanary('srv-pending');
    writeMcpJson('PROBE_MCP_ECHO_VAR2');
    await ctx.sessionManager.deactivateEmbeddedAgentWorker(targetSessionId, targetWorkerId);
    await activate('arm3 restart');
    const arm3Discovered = await readDiscoveredViaWire('arm3 restart');
    const pendingV2 = findDiscoveredServer(arm3Discovered, 'srv-pending');
    expect(pendingV2?.decision === 'pending', 'arm3: srv-pending is still pending after the config change', JSON.stringify(pendingV2));
    expect(
      typeof pendingV2?.hash === 'string' && pendingV2.hash !== pendingHashV1,
      'arm3: srv-pending\'s discovered hash changed',
      `v1=${pendingHashV1} v2=${pendingV2?.hash}`,
    );
    expect(!existsSync(canaryPath('srv-pending')), 'arm3: srv-pending canary absent before any turn');
    const pendingHashV2 = pendingV2!.hash!;

    // A baseline turn to bring the SDK's query loop past `system:init`
    // before attempting the live add -- `probe-sdk-phase5-pr2-premises.ts`'s
    // P-a arm establishes this ordering for `Query.setMcpServers`.
    await runTurn(targetSessionId, targetWorkerId, 'Reply with only the word DONE.');
    const applyBaseline3 = (await readEvents(targetSessionId, targetWorkerId)).length;
    const allow3 = await callMcpTool(
      'set_mcp_server_permission',
      { sessionId: targetSessionId, workerId: targetWorkerId, name: 'srv-pending', hash: pendingHashV2, decision: 'allow' },
      `Bearer ${tuiToken}`,
    );
    expect(!allow3.isError, 'arm3: set_mcp_server_permission (allow srv-pending by new hash) succeeded', allow3.text.slice(0, 300));
    const applied3 = await waitForEvent(
      targetSessionId,
      targetWorkerId,
      applyBaseline3,
      (e) => e.type === 'mcp-servers-applied',
      20_000,
      'arm3: mcp-servers-applied',
    );
    expect(applied3.applied === true, 'arm3: mcp-servers-applied reports applied:true', JSON.stringify(applied3));

    // CHANGES-REQUESTED (Item 1): the same allow-by-new-hash
    // check as arm 1, at the pending server's NEW hash -- confirms the
    // repository-read merge also holds for a hash that changed mid-run, not
    // only for the fixture's original hash.
    const allowedAfterApply3 = await pollDiscoveredServer(
      'srv-pending',
      (s) => s?.decision === 'allowed' && s?.status === 'connected',
      15_000,
    );
    expect(
      allowedAfterApply3?.decision === 'allowed' && allowedAfterApply3?.status === 'connected',
      'arm3: srv-pending reads decision:allowed + status:connected via get_session_status after the live apply (new hash)',
      JSON.stringify(allowedAfterApply3),
    );

    await waitUntil(() => existsSync(canaryPath('srv-pending')), 15_000, 'arm3: srv-pending canary appears').catch((err) =>
      expect(false, 'arm3: srv-pending canary appears (live add by new hash)', String(err)),
    );
    expect(existsSync(canaryPath('srv-pending')), 'arm3: srv-pending canary is present after the live add');

    // ===================================================================
    // NEGATIVE CONTROLS.
    // ===================================================================

    // (a) deny srv-allowed, restart, canary absent -- the durable half of a deny.
    console.log('\n==> negative control (a): deny srv-allowed, restart');
    const denyRes = await callMcpTool(
      'set_mcp_server_permission',
      { sessionId: targetSessionId, workerId: targetWorkerId, name: 'srv-allowed', hash: allowedHash, decision: 'deny' },
      `Bearer ${tuiToken}`,
    );
    expect(!denyRes.isError, '(a): set_mcp_server_permission (deny srv-allowed) succeeded', denyRes.text.slice(0, 300));
    resetCanary('srv-allowed');
    resetCanary('srv-pending');
    await ctx.sessionManager.deactivateEmbeddedAgentWorker(targetSessionId, targetWorkerId);
    await activate('(a) restart');
    await runTurn(targetSessionId, targetWorkerId, 'Reply with only the word DONE.');
    expect(!existsSync(canaryPath('srv-allowed')), '(a): srv-allowed canary is absent after being denied and restarted');

    // (b) an EMBEDDED caller is refused, nothing persisted.
    console.log('\n==> negative control (b): embedded caller refusal');
    const embeddedAttempt = await callMcpTool(
      'set_mcp_server_permission',
      { sessionId: targetSessionId, workerId: targetWorkerId, name: 'srv-pending', hash: pendingHashV2, decision: 'deny' },
      `Bearer ${embeddedCallerToken}`,
    );
    expect(embeddedAttempt.isError === true, '(b): an embedded caller is refused', embeddedAttempt.text.slice(0, 300));
    const rowsAfterEmbeddedAttempt = await ctx.mcpServerPermissionRepository.listByRepository(repo.id);
    const pendingRowAfter = rowsAfterEmbeddedAttempt.find((r) => r.serverName === 'srv-pending');
    expect(
      pendingRowAfter?.decision === 'allow',
      '(b): the embedded caller\'s attempted deny was NOT persisted (srv-pending stays allow, from arm 3)',
      JSON.stringify(pendingRowAfter),
    );

    // (c) the operator's own ~/.claude.json is never read; no user/local rows.
    console.log('\n==> negative control (c): isolated CLAUDE_CONFIG_DIR -- no user/local rows, no unavailable flag');
    const allDiscoveredEvents = (await readEvents(targetSessionId, targetWorkerId)).filter(
      (e) => e.type === 'mcp-servers-discovered',
    );
    expect(allDiscoveredEvents.length > 0, '(c): at least one mcp-servers-discovered event exists to check');
    expect(
      !hasUserOrLocalScopeEntry(allDiscoveredEvents),
      '(c): no discovered event ever reported a user/local-scope row',
      JSON.stringify(allDiscoveredEvents.map((e) => e.servers)),
    );
    expect(
      !anyUserLocalNamesUnavailable(allDiscoveredEvents),
      '(c): userLocalNamesUnavailable was never set (the isolated config was readable)',
    );

    await ctx.sessionManager.deactivateEmbeddedAgentWorker(targetSessionId, targetWorkerId).catch(() => {});
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
    if (ledgerPath) {
      const sweep = sweepOrphanFixtureProcesses(ledgerPath);
      console.log(
        `==> orphan fixture-process sweep: checked=${sweep.checked} survivors=${JSON.stringify(sweep.survivors)} ` +
          `killed=${JSON.stringify(sweep.killed)} reportedOnly=${JSON.stringify(sweep.reportedOnly)}`,
      );
      if (sweep.survivors.length > 0) {
        console.error('  a fixture MCP server process outlived its session -- this is a finding, not routine cleanup.');
      }
    }
    // Ad-hoc, temporary capture-before-delete (2026-09-21 investigation of
    // the arm 3 read-too-early bug) -- mirrors
    // `check-fatal-incarnation-replacement.ts`'s `captureWorkerNdjson`
    // pattern (copy before `rm -rf`, never after) so a future failed run's
    // persisted worker NDJSON survives the disposable home's teardown for
    // inspection. Deliberately NOT extracted into a registered, documented
    // mechanism (`test-trigger.md` registration) -- this is a debugging aid
    // for one investigation, not a standing feature of this smoke.
    if (home) {
      const captureRoot = path.join(os.homedir(), '.agent-console-smoke-captures', 'check-embedded-agent-project-mcp-permission');
      const captureDir = path.join(captureRoot, path.basename(home));
      const glob = new Glob('**/outputs/**/*');
      let capturedAny = false;
      for (const rel of glob.scanSync({ cwd: home, onlyFiles: true })) {
        const dest = path.join(captureDir, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(path.join(home, rel), dest);
        capturedAny = true;
      }
      if (capturedAny) console.log(`==> worker NDJSON captured to: ${captureDir}`);
    }
    if (home) Bun.spawnSync(['rm', '-rf', home]);
    // `isolatedConfigDir` lives directly under the OS temp dir, NOT nested
    // under `home` -- it holds a copy of the operator's CLI credentials
    // (isolateClaudeConfigDir's own doc comment) and needs its own removal
    // on every exit path, success or thrown error (Issue #1819). Its last
    // read is negative control (c) above (line ~993), which reads
    // server-side events rather than the directory itself, so removal here
    // is strictly after every read.
    if (isolatedConfigDir) rmSync(isolatedConfigDir, { recursive: true, force: true });
  }
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  const { expectNoPermission } = parseArgs(process.argv.slice(2));
  main(expectNoPermission)
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
