#!/usr/bin/env bun
/**
 * Shared harness for the SDK compaction / resume probes (Issue #1400):
 * `probe-sdk-compaction.ts` and `probe-sdk-resume.ts`. Not an entry point --
 * it has no `main()` and running it directly does nothing.
 *
 * WHY A THIRD FILE (a deliberate, reported deviation from #1400's two-script
 * layout): both probes need the identical live-session harness -- an
 * isolated `CLAUDE_CONFIG_DIR`, the production `spawnClaudeCodeProcess` /
 * `UserMessageQueue`, a `for await` consume loop that NEVER breaks early,
 * and a `getContextUsage()` poll issued from INSIDE that still-live loop
 * body. Copying ~200 lines of that into two scripts is the exact drift
 * vector the reference probe's "import the production functions directly"
 * convention exists to kill; a shared module keeps both probes provably on
 * one methodology. The two flag-selected entry points #1400 specifies are
 * unchanged.
 *
 * THE NEVER-BREAK RULE. `ProbeSession`'s consume loop iterates its `Query`
 * for the whole life of the session and only ever leaves the loop when the
 * stream itself ends (after `close()`, or when the child dies). Breaking a
 * `for await` early on an async generator invokes the generator's own
 * `return()` (`Query extends AsyncGenerator<SDKMessage, void>`), which
 * measurably wedges the transport on every subsequent control request --
 * `scripts/smoke/probe-sdk-h2-transport-settle-negative-control.ts`'s header
 * is the canonical account of that artifact, and reading it is a
 * prerequisite for changing anything in this file. Every `getContextUsage()`
 * poll a turn takes is awaited from inside the loop body (see
 * `pendingAfterResult`), exactly matching `sdk-engine.ts`'s
 * `consumeLoop` -> `handleMessage` -> `handleResult` -> `pollContextUsage`
 * chain.
 *
 * Requirements (same as the H2 probes): a real, authenticated `claude` CLI
 * session for the invoking OS user. These are billable manual tools, not CI
 * gates.
 */

// Resolved via a relative path into packages/embedded-agent's own
// node_modules, not the bare `@anthropic-ai/claude-agent-sdk` specifier:
// this repo's hoisted install does not place this package at the repo root
// (see packages/embedded-agent/package.json's own dependency), and a bare
// specifier from a script under scripts/smoke/ cannot walk up into a sibling
// workspace's node_modules. This is the same package instance sdk-engine.ts
// itself resolves, so the version under test cannot drift.
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKControlGetContextUsageResponse,
  type SpawnedProcess,
  type SpawnOptions,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { spawnClaudeCodeProcess, UserMessageQueue } from '../../packages/embedded-agent/src/sdk-engine.js';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type CompactBoundary = Extract<SDKMessage, { type: 'system'; subtype: 'compact_boundary' }>;
export type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

/** H2 (design doc §5) retry-with-settle, mirroring sdk-engine.ts's constants. */
const SETTLE_DELAY_MS = 500;
const MAX_ATTEMPTS = 6;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Isolates `CLAUDE_CONFIG_DIR` to a throwaway directory holding ONLY the
 * invoking user's credential file -- no `projects/`, no history, no memory
 * files. Same isolation shape as PR #1349's handoff E2E, and load-bearing
 * for the resume probe: a resumed session must be read back from the SAME
 * isolated directory the original session wrote its transcript into, so the
 * override is set once per probe process and never changed mid-run.
 *
 * The override travels through the child's INHERITED env (production leaves
 * `Options.env` unset, and `SpawnOptions.env` is what the production
 * `spawnClaudeCodeProcess` forwards), so this mutates this process's own env
 * rather than passing an `env` option the real engine never passes.
 * `verifyIsolation()` below turns that inheritance into a checked fact.
 */
export function isolateClaudeConfigDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-sdk-${label}-`));
  const credentials = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credentials)) {
    copyFileSync(credentials, join(dir, '.credentials.json'));
  }
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

/** Session transcript files the isolated config dir has accumulated. */
export function transcriptFiles(configDir: string): string[] {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(projects)) {
    const sub = join(projects, entry);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (f.endsWith('.jsonl')) out.push(join(sub, f));
    }
  }
  return out;
}

/**
 * Proof (not assertion) that the `CLAUDE_CONFIG_DIR` override actually
 * reached the spawned `claude` child: the child WROTE ITS OWN state into
 * the throwaway directory. If none of these appear, the probe is silently
 * running against the operator's real config dir and every isolation claim
 * in its output would be false -- callers treat that as a hard stop.
 *
 * The predicate is child-created state (`.claude.json`, `projects/`,
 * `sessions/`), NOT the session transcript specifically: a probe item that
 * never spends a turn (P1a reads `getContextUsage()` and nothing else)
 * legitimately produces no `.jsonl` while still proving the override
 * arrived. `files` reports the transcripts separately for the items that do
 * depend on them.
 */
export function verifyIsolation(configDir: string): { ok: boolean; files: string[]; evidence: string[] } {
  const evidence = ['.claude.json', 'projects', 'sessions'].filter((e) => existsSync(join(configDir, e)));
  return { ok: evidence.length > 0, files: transcriptFiles(configDir), evidence };
}

export interface TurnOutcome {
  /** Undefined when the turn timed out or the stream died before a `result`. */
  result?: ResultMessage;
  /** Concatenated assistant text emitted during this turn. */
  text: string;
  /** Message `type[/subtype]` labels observed between the prompt push and the turn settling. */
  observed: string[];
  /** `getContextUsage()` polled from INSIDE the live loop body right after `result`. */
  usage?: SDKControlGetContextUsageResponse;
  usageError?: string;
  timedOut: boolean;
  streamError?: string;
}

export interface ProbeSessionOptions {
  options: Options;
  /** Label used in the probe's own console trace. */
  label: string;
  /** Poll `getContextUsage()` after every turn's `result` (default true). */
  pollUsage?: boolean;
}

function messageLabel(m: SDKMessage): string {
  const sub = (m as { subtype?: string }).subtype;
  return sub ? `${m.type}/${sub}` : m.type;
}

/**
 * One live SDK session, driven exactly the way `sdk-engine.ts` drives its
 * own: streaming input via the production `UserMessageQueue`, a consume loop
 * that never breaks early, and per-turn usage polling from inside that loop.
 */
export class ProbeSession {
  readonly q: Query;
  /** Every `claude` child this session's SDK spawned, in spawn order. */
  readonly children: SpawnedProcess[] = [];
  readonly allMessages: string[] = [];
  readonly compactBoundaries: CompactBoundary[] = [];
  sessionId: string | null = null;
  streamEnded: 'clean' | 'error' | null = null;
  streamError: string | null = null;

  private readonly queue = new UserMessageQueue();
  private readonly consumePromise: Promise<void>;
  private readonly label: string;
  private readonly pollUsage: boolean;
  private initResolve: (() => void) | null = null;
  private initPromise: Promise<void>;
  private turnSettle: ((o: TurnOutcome) => void) | null = null;
  private turnObserved: string[] = [];
  private turnText = '';

  constructor(opts: ProbeSessionOptions) {
    this.label = opts.label;
    this.pollUsage = opts.pollUsage ?? true;
    this.initPromise = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    // The production spawn function still does the spawning -- this wrapper
    // only records the handle so a probe can kill the real child (P5).
    const captureSpawn = (o: SpawnOptions): SpawnedProcess => {
      const child = spawnClaudeCodeProcess(o);
      this.children.push(child);
      return child;
    };

    this.q = query({
      prompt: this.queue.stream(),
      options: { ...opts.options, spawnClaudeCodeProcess: captureSpawn },
    });
    this.consumePromise = this.consume();
  }

  /**
   * Resolves once the session is answering control requests. Deliberately
   * NOT "wait for `system/init`": that message does not arrive until a turn
   * has been pushed (observed on SDK 0.3.238 -- a session can answer
   * `getContextUsage()` for minutes without ever emitting one), so waiting
   * on it burns the whole timeout on every turn-less item. A control
   * request that answers is the readiness signal that actually matters
   * here.
   */
  async waitForReady(timeoutMs = 60_000): Promise<'init' | 'control' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    let initSeen = false;
    void this.initPromise.then(() => {
      initSeen = true;
    });
    while (Date.now() < deadline) {
      if (initSeen) return 'init';
      try {
        await this.q.getContextUsage();
        return 'control';
      } catch {
        await sleep(1000);
      }
    }
    return 'timeout';
  }

  /**
   * Pushes one user message and settles when its `result` arrives. `text`
   * may be a slash command (`/compact`) -- whether the CLI honors one over
   * streaming input is exactly what P2 measures.
   */
  async runTurn(text: string, timeoutMs = 240_000): Promise<TurnOutcome> {
    this.turnObserved = [];
    this.turnText = '';
    const settled = new Promise<TurnOutcome>((resolve) => {
      this.turnSettle = resolve;
    });
    const prompt: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.queue.push(prompt);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TurnOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            text: this.turnText,
            observed: [...this.turnObserved],
            timedOut: true,
          }),
        timeoutMs,
      );
    });
    const outcome = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    this.turnSettle = null;
    return outcome;
  }

  /**
   * A standalone `getContextUsage()` read, with the same H2 retry-with-settle
   * production uses. Issued from OUTSIDE a loop body (the loop is still live
   * and iterating concurrently) -- used only for reads that must happen
   * without spending a turn, e.g. immediately after `applyFlagSettings()`.
   * Per-turn reads go through the in-loop path instead.
   */
  async readUsage(): Promise<SDKControlGetContextUsageResponse> {
    return pollUsageWithSettle(this.q);
  }

  /**
   * Whether a turn is still awaiting its `result`. The mid-turn-kill probe
   * needs this: a kill that lands after the turn already settled measures
   * an idle kill, and would otherwise be indistinguishable from the case it
   * claims to test.
   */
  get turnInFlight(): boolean {
    return this.turnSettle !== null;
  }

  /** Deliberate teardown; mirrors `sdk-engine.ts`'s `dispose()`. */
  close(): void {
    try {
      this.q.close();
    } catch {
      // Already closed / never fully started -- nothing more to release.
    }
  }

  /** Waits for the consume loop to finish (after `close()` or a child death). */
  async waitForStreamEnd(timeoutMs = 30_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.consumePromise, timeout]);
    if (timer) clearTimeout(timer);
  }

  /**
   * The consume loop. It NEVER breaks -- see this file's header. It exits
   * only when the underlying stream ends on its own.
   */
  private async consume(): Promise<void> {
    try {
      for await (const message of this.q) {
        const label = messageLabel(message);
        this.allMessages.push(label);
        this.turnObserved.push(label);

        // `system/init` is NOT the only carrier of the session id, and (as
        // this probe's own P1a run showed) it does not arrive at all until
        // the first turn is pushed -- so take the id from whatever message
        // carries one first.
        const carried = (message as { session_id?: string }).session_id;
        if (carried && !this.sessionId) this.sessionId = carried;
        if (message.type === 'system' && message.subtype === 'init') {
          this.initResolve?.();
          this.initResolve = null;
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          this.compactBoundaries.push(message);
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') this.turnText += block.text;
          }
        }
        if (message.type === 'result') {
          // Awaited INSIDE the still-live loop body, exactly as production's
          // handleResult -> pollContextUsage does. Never move this out.
          let usage: SDKControlGetContextUsageResponse | undefined;
          let usageError: string | undefined;
          if (this.pollUsage) {
            try {
              usage = await pollUsageWithSettle(this.q);
            } catch (err) {
              usageError = err instanceof Error ? err.message : String(err);
            }
          }
          const settle = this.turnSettle;
          this.turnSettle = null;
          settle?.({
            result: message,
            text: this.turnText,
            observed: [...this.turnObserved],
            usage,
            usageError,
            timedOut: false,
          });
        }
      }
      this.streamEnded = 'clean';
    } catch (err) {
      this.streamEnded = 'error';
      this.streamError = err instanceof Error ? err.message : String(err);
    }
    // A turn still in flight when the stream ended can never settle on its
    // own -- settle it here rather than leaving the probe hanging.
    const settle = this.turnSettle;
    this.turnSettle = null;
    settle?.({
      text: this.turnText,
      observed: [...this.turnObserved],
      timedOut: false,
      streamError: this.streamError ?? `stream ended (${this.streamEnded}) with a turn in flight`,
    });
    this.initResolve?.();
    this.initResolve = null;
  }

  describe(): string {
    return `[${this.label}] session=${this.sessionId ?? '(none)'} messages=${this.allMessages.length}`;
  }
}

/** H2 retry-with-settle, mirroring `sdk-engine.ts`'s `pollContextUsage`. */
export async function pollUsageWithSettle(q: Query): Promise<SDKControlGetContextUsageResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await q.getContextUsage();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await sleep(SETTLE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Compact one-line rendering of the fields every item in #1400 reads. */
export function usageLine(u: SDKControlGetContextUsageResponse | undefined): string {
  if (!u) return '(no usage)';
  return [
    `isAutoCompactEnabled=${u.isAutoCompactEnabled}`,
    `autoCompactThreshold=${u.autoCompactThreshold ?? '(absent)'}`,
    `totalTokens=${u.totalTokens}`,
    `maxTokens=${u.maxTokens}`,
    `rawMaxTokens=${u.rawMaxTokens}`,
    `percentage=${u.percentage}`,
    `model=${u.model}`,
  ].join(' ');
}

export function nonce(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
}

export function stamp(): string {
  return new Date().toISOString();
}
