#!/usr/bin/env bun
/**
 * NEGATIVE CONTROL for H2 (docs/design/embedded-agent-sdk-engine.md §5) --
 * see the sibling `probe-sdk-h2-transport-settle.ts` for the production-
 * faithful probe this pairs with. Read both together; the pairing IS the
 * finding.
 *
 * This script deliberately uses a WRONG methodology: it BREAKS its
 * `for await` loop over the `Query`'s message stream as soon as it sees
 * the turn's `result` message, THEN calls `getContextUsage()`. This is
 * NOT what `sdk-engine.ts`'s `consumeLoop` does (it never breaks -- see
 * the sibling script). Breaking a `for await` early on an async generator
 * invokes the generator's own `return()` (`Query extends
 * AsyncGenerator<SDKMessage, void>`), and this appears to measurably wedge
 * the transport: EVERY attempt (verified up to 12 retries over 3.3s) then
 * throws "ProcessTransport is not ready for writing", indefinitely,
 * regardless of SDK version.
 *
 * WHY THIS SCRIPT EXISTS: the original 2026-08-17 probe that produced the
 * H2 finding this repo has carried since is NOT preserved, so whether it
 * shared this exact artifact could not be determined during the SDK bump
 * (0.3.226 -> 0.3.238) re-verification (#1338). This script exists so
 * THAT never happens again: it is the concrete, re-runnable demonstration
 * of a plausible false-positive generator for H2, independent of SDK
 * version. A future re-prober who reaches for the "obvious" `break`-on-
 * result pattern should run this FIRST, see it reliably fail, and
 * understand why before concluding anything about the SDK's real
 * transport behavior.
 *
 * EXPECTED (and CORRECT) OUTCOME: every trial FAILS -- see Exit codes.
 * A clean run here does not mean the SDK improved; it means this specific
 * artifact stopped reproducing, which is itself worth investigating (see
 * Exit codes below).
 *
 * Requirements: same as the sibling script -- real authenticated `claude`
 * CLI session, manual re-verification tool, not a CI gate.
 *
 * Usage:
 *   bun scripts/smoke/probe-sdk-h2-transport-settle-negative-control.ts [trials]
 *
 * Exit codes:
 *   0  every trial reproduced the artifact (the expected, documented
 *      outcome -- confirms the pitfall this script exists to demonstrate
 *      is still present in this SDK version's/Node's/Bun's async-generator
 *      semantics)
 *   1  at least one trial did NOT reproduce the artifact -- the early-break
 *      artifact itself may have changed; this is worth a STOP-and-consult
 *      before trusting the production-faithful script's own results in
 *      isolation, the same way the pair was cross-checked during the SDK
 *      bump re-verification
 *   2  bad usage / probe could not run (including an invalid/unrecognized
 *      argument -- checked before any trial runs, so a typo never
 *      silently burns billable API usage)
 */

// See the sibling probe script for why this resolves via a relative path
// into packages/embedded-agent's own node_modules rather than the bare
// `@anthropic-ai/claude-agent-sdk` specifier.
import {
  query,
  type Options,
} from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import { spawnClaudeCodeProcess, UserMessageQueue } from '../../packages/embedded-agent/src/sdk-engine.js';

const args = process.argv.slice(2);
const invalidUsage = args.length > 1 || (args.length === 1 && !/^[1-9]\d*$/.test(args[0]));

if (invalidUsage) {
  console.error(`Usage: bun scripts/smoke/probe-sdk-h2-transport-settle-negative-control.ts [trials]\n  trials must be a positive integer (>= 1). Got: ${args.join(' ')}`);
  process.exit(2);
}

const trials = args.length === 1 ? Number(args[0]) : 5;
const RETRY_ATTEMPTS = 6;
const RETRY_DELAY_MS = 500;

function buildOptions(): Options {
  return {
    executable: 'bun',
    cwd: process.cwd(),
    model: 'claude-sonnet-5',
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
  reproduced: boolean;
  attemptsBeforeGivingUp: number;
}

async function runOneTrial(trial: number): Promise<TrialResult> {
  const queue = new UserMessageQueue();
  const q = query({ prompt: queue.stream(), options: buildOptions() });

  const consume = (async () => {
    // THE ARTIFACT: break out of the for-await as soon as `result` arrives,
    // instead of continuing to iterate like production's consumeLoop does.
    for await (const message of q) {
      if (message.type === 'result') break;
    }
  })();

  queue.push({ type: 'user', message: { role: 'user', content: 'Reply with exactly the single word: pong' }, parent_tool_use_id: null });
  await consume;

  let attempts = 0;
  for (; attempts < RETRY_ATTEMPTS; attempts++) {
    try {
      await q.getContextUsage();
      // Settled -- the artifact did NOT reproduce this trial.
      return { trial, reproduced: false, attemptsBeforeGivingUp: attempts + 1 };
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return { trial, reproduced: true, attemptsBeforeGivingUp: attempts };
}

async function main(): Promise<number> {
  console.log(`Running ${trials} trial(s) with the DELIBERATELY WRONG early-break methodology (expect every trial to reproduce "ProcessTransport is not ready for writing")...\n`);

  const results: TrialResult[] = [];
  for (let i = 1; i <= trials; i++) {
    const r = await runOneTrial(i);
    results.push(r);
    console.log(r.reproduced
      ? `trial ${i}: artifact REPRODUCED (never settled within ${RETRY_ATTEMPTS} attempts / ${RETRY_ATTEMPTS * RETRY_DELAY_MS}ms) -- expected`
      : `trial ${i}: did NOT reproduce (settled after ${r.attemptsBeforeGivingUp} attempt(s)) -- UNEXPECTED, see this script's header`);
  }

  const notReproduced = results.filter((r) => !r.reproduced);
  console.log(`\n${results.length - notReproduced.length}/${results.length} trials reproduced the artifact.`);
  return notReproduced.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('probe could not run:', err);
    process.exit(2);
  });
