#!/usr/bin/env bun
/**
 * Live probe for H2 (docs/design/embedded-agent-sdk-engine.md §5): does
 * calling `Query.getContextUsage()` immediately after a turn's `result`
 * still intermittently throw "ProcessTransport is not ready for writing"?
 *
 * This is the PRODUCTION-FAITHFUL half of a pair -- see the sibling script
 * `probe-sdk-h2-transport-settle-negative-control.ts` for the deliberately
 * WRONG methodology that reliably reproduces a false positive of this same
 * error, on every SDK version tested, regardless of whether the real race
 * is present. Read both scripts together; the pairing IS the finding
 * (the SDK bump's re-verification of the pin move to 0.3.238, #1338).
 *
 * Why this methodology and not the negative control's: this script keeps
 * its `for await` loop over the `Query`'s message stream running for the
 * ENTIRE probe -- it never `break`s -- and calls `getContextUsage()` from
 * a call AWAITED INSIDE that still-live loop body, exactly matching
 * `sdk-engine.ts`'s `consumeLoop` -> `handleMessage` -> `handleResult` ->
 * `pollContextUsage` -> `query.getContextUsage()` call chain. The negative
 * control instead `break`s the loop on the `result` message before calling
 * `getContextUsage()`. Breaking a `for await` early on an async generator
 * invokes the generator's own `return()` (`Query extends
 * AsyncGenerator<SDKMessage, void>`), which measurably wedges the
 * transport on EVERY attempt, indefinitely, independent of SDK version --
 * see the negative control script's own header for the full account.
 *
 * Uses the PRODUCTION `spawnClaudeCodeProcess` override and
 * `UserMessageQueue` (imported directly from `sdk-engine.ts`) so the argv
 * shape and streaming-input mechanism cannot drift from what the real
 * engine does.
 *
 * Requirements:
 *   - A real, authenticated `claude` CLI session for the invoking OS user
 *     (the same auth a TUI Claude Code worker would use). This script
 *     makes real Anthropic API calls and costs real usage -- it is a
 *     manual re-verification tool, not a CI gate. Run it by hand when
 *     re-verifying `@anthropic-ai/claude-agent-sdk` version-premised
 *     behavior (docs/design/embedded-agent-sdk-engine.md's "What a bump
 *     must re-verify" checklist), not on every push.
 *   - `bun install` already run so `@anthropic-ai/claude-agent-sdk`
 *     resolves to the version under test (this repo's currently pinned
 *     version by default; `cd` into a separate scratch project with a
 *     different version installed to test an alternate version).
 *
 * Usage:
 *   bun scripts/smoke/probe-sdk-h2-transport-settle.ts [trials] [--with-tool]
 *
 *   trials       number of trials to run (default 5)
 *   --with-tool  include a Bash-tool-call-bearing turn each trial instead
 *                of a plain-text turn (more realistic stream load)
 *
 * Exit codes:
 *   0  every trial's getContextUsage() call succeeded on the FIRST attempt
 *      (no retry needed) -- the race did not reproduce
 *   1  at least one trial needed a retry or never settled -- the race (or
 *      something shaped like it) reproduced; this is DATA, not necessarily
 *      a failure of this script -- see docs/design/embedded-agent-sdk-engine.md
 *      §5's H2 entry for how to interpret and record this
 *   2  bad usage / probe could not run (e.g. no `claude` auth)
 */

// Resolved via a relative path into packages/embedded-agent's own
// node_modules, not the bare `@anthropic-ai/claude-agent-sdk` specifier:
// this repo's hoisted install does not place this package at the repo
// root (see packages/embedded-agent/package.json's own dependency), and a
// bare specifier from a script under scripts/smoke/ cannot walk up into a
// sibling workspace's node_modules. This is the same package instance
// sdk-engine.ts itself resolves, so the version under test cannot drift.
import {
  query,
  type Options,
  type SDKUserMessage,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { spawnClaudeCodeProcess, UserMessageQueue } from '../../packages/embedded-agent/src/sdk-engine.js';

const args = process.argv.slice(2);
const withTool = args.includes('--with-tool');
const trialsArg = args.find((a) => /^\d+$/.test(a));
const trials = trialsArg ? Number(trialsArg) : 5;

function buildOptions(): Options {
  return {
    executable: 'bun',
    cwd: process.cwd(),
    model: 'claude-sonnet-5',
    ...(withTool ? { tools: ['Bash'] } : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [],
    settings: { autoCompactEnabled: false },
    spawnClaudeCodeProcess,
  };
}

interface TrialResult {
  trial: number;
  ok: boolean;
  elapsedMs: number;
  totalTokens?: number;
  error?: string;
}

async function runOneTrial(trial: number): Promise<TrialResult> {
  const queue = new UserMessageQueue();
  const q = query({ prompt: queue.stream(), options: buildOptions() });

  let result: TrialResult = { trial, ok: false, elapsedMs: -1, error: 'turn never completed' };

  // Mirrors sdk-engine.ts's consumeLoop: iterate the message stream for the
  // engine's whole life, never breaking early -- see this file's header for
  // why an early break is the artifact the negative control demonstrates.
  for await (const message of q) {
    if (message.type === 'result') {
      const t0 = Date.now();
      try {
        const resp = await q.getContextUsage();
        result = { trial, ok: true, elapsedMs: Date.now() - t0, totalTokens: resp?.totalTokens };
      } catch (err) {
        result = { trial, ok: false, elapsedMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
      }
      break; // safe HERE -- getContextUsage() has already resolved/rejected
             // from inside the still-live loop body, matching production.
    }
  }

  const prompt: SDKUserMessage = withTool
    ? { type: 'user', message: { role: 'user', content: 'Run the shell command `pwd` using your Bash tool, then reply with just the word done.' }, parent_tool_use_id: null }
    : { type: 'user', message: { role: 'user', content: 'Reply with exactly the single word: pong' }, parent_tool_use_id: null };
  queue.push(prompt);

  return result;
}

async function main(): Promise<number> {
  console.log(`Running ${trials} trial(s), ${withTool ? 'Bash-tool-call-bearing' : 'plain-text'} turns, production-faithful methodology (no early break)...\n`);

  const results: TrialResult[] = [];
  for (let i = 1; i <= trials; i++) {
    const r = await runOneTrial(i);
    results.push(r);
    console.log(r.ok ? `trial ${i}: OK (t+${r.elapsedMs}ms, totalTokens=${r.totalTokens})` : `trial ${i}: FAIL (t+${r.elapsedMs}ms): ${r.error}`);
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} trials succeeded on the FIRST getContextUsage() attempt (no retry).`);
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('probe could not run:', err);
    process.exit(2);
  });
