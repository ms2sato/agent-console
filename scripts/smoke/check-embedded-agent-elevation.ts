#!/usr/bin/env bun
/**
 * Post-deploy smoke test for embedded-agent worker elevation (Phase 4).
 *
 * Drives the REAL shipping path -- `SessionManager.activateEmbeddedAgentWorker`
 * spawning the REAL embedded-agent loop subprocess via the REAL production
 * `spawnAsUser` -- against a REAL second OS user, with `AUTH_MODE=multi-user`
 * forced on and `AGENT_CONSOLE_MCP_AUTH` set explicitly by the `--auth-mode`
 * flag (default `enforce`; the resolver's own default is `warn` for every
 * AUTH_MODE since Issue #1107 -- see the "Note on AGENT_CONSOLE_MCP_AUTH"
 * below). This is the smoke bullet referenced by
 * docs/design/embedded-agent-worker.md Part II Testing plan.
 *
 * What this smoke exercises:
 *   - `resolveEmbeddedAgentEntryPath()` actually resolves via the
 *     package-resolution branch (`@agent-console/embedded-agent/package.json`),
 *     not the dev-source-tree fallback. This smoke runs from a repo checkout
 *     (no `dist/embedded-agent.js` sibling present), so the bundle-sibling
 *     branch a REAL bundled production deploy takes is structurally out of
 *     reach here -- unit tests cover that branch directly via a fixture
 *     directory (`embedded-agent-worker-service.test.ts`). What this smoke
 *     proves instead is that the checkout's OWN resolution (package, not
 *     source-tree fallback) is what a dev/CI environment actually exercises
 *     end-to-end, including the elevation and MCP handshake below.
 *   - The REAL `sudo -u <target-user> ... -i sh -c '<bunPath> <entry>'`
 *     elevation argv, spawned by the REAL `spawnAsUser`, against a REAL
 *     second OS user, using the configured `EMBEDDED_AGENT_BUN_PATH` (Issue
 *     #1221 -- resolving `bun` by bare PATH-only name inside a non-interactive,
 *     non-bash elevated shell does not find a user-local `~/.bun/bin/bun`).
 *   - (Issue #1222) When `EMBEDDED_AGENT_BUN_PATH` is configured to an
 *     absolute path, the LIVE `agent-console.service` systemd process is
 *     resolved via `systemctl show -p MainPID` and its actual executable
 *     (`/proc/<pid>/exe`) is asserted to be that same configured path --
 *     proving the running server really executes the unit-unified binary,
 *     not merely that two config strings happen to match (see the detailed
 *     comment at the assertion itself for why the pre-#1222 `--version`
 *     comparison was replaced rather than repointed). A version difference
 *     between the unified path and the service user's own `~/.bun/bin/bun`
 *     is reported as a WARNING (expected freshness after a `bun upgrade`,
 *     not a failure). Before comparing the live pid, a positive control runs
 *     `compareBinaryIdentity` against this smoke process's own
 *     `/proc/self/exe`, so a later `{ unresolvable: 'self' }` result on the
 *     LIVE pid is attributable specifically to a permission gap reading
 *     `/proc/<MainPID>/exe` (needs the unit's own `User=`/`Group=`, or root)
 *     rather than to some broader failure of `/proc/self/exe` resolution in
 *     this environment; `{ unresolvable: 'configured' }` is reported
 *     separately, naming the configured path itself as unreadable. Both are
 *     probe-cannot-run conditions (exit 2), not assertion failures.
 *   - MCP enforce handshake AND enforcement, read back from the running
 *     instance (Issue #1738). The loop's init handshake completes
 *     end-to-end against a REAL `/mcp` Streamable-HTTP endpoint whose gate
 *     mode is set explicitly by `--auth-mode` (default `enforce`, because
 *     `resolveMcpAuthMode` defaults to `warn` for every AUTH_MODE since
 *     Issue #1107 -- an unset value would silently run this whole smoke in
 *     warn mode). Then, after `ready` and before teardown, against the real
 *     Hono app on its real port, the same JSON-RPC `tools/call` of
 *     `list_sessions` is sent twice:
 *       E1  tokenless. Under `enforce`: refused with HTTP 401 and the
 *           gate's exact message ("MCP authentication required: no bearer
 *           token presented (AGENT_CONSOLE_MCP_AUTH=enforce)"), and the
 *           gate's warn line was NOT logged. Under `--auth-mode warn`:
 *           ACCEPTED with HTTP 200 and a result, and the gate's exact warn
 *           line ("MCP request without verified caller identity;
 *           proceeding (AGENT_CONSOLE_MCP_AUTH=warn)") was logged exactly
 *           once -- observed through a recording pass-through installed on
 *           `rootLogger.warn`, the parent the `mcp-auth` child logger
 *           resolves to.
 *       E2  `Authorization: Bearer <the token the loop itself presented>`
 *           (captured from the real /mcp request the init handshake made).
 *           Both arms: HTTP 200 with a JSON-RPC result -- under `enforce`
 *           this is what turns "the token hit /mcp" into "the token is
 *           what admits the call", since E1 was refused on the same
 *           endpoint a moment earlier.
 *     The two arms are one apparatus with inverted E1 expectations, so
 *     running either arm against the other's assertion set FAILS: that is
 *     the polarity, measured by running BOTH arms in the tier-2 container.
 *     The effective mode is thereby READ BACK by observable behaviour (401
 *     vs 200 on the same tokenless call) -- deliberately no mode-echo
 *     endpoint, which would only read back a configured string.
 *   - Negative secret assertions against the REAL `/proc/<pid>/cmdline` and
 *     `/proc/<pid>/environ` of the elevated subprocess: neither the MCP
 *     bearer token nor the provider API key must appear in either file.
 *   - (Issue #1694) A POSITIVE identity assertion in the same run: scanning
 *     `/proc/*\/environ` AS THE TARGET USER via the real `runAsUser` with
 *     the orphan sweep's exact match semantics (`grep -Fxz`), at least one
 *     live process carries `AGENT_CONSOLE_SESSION_ID=<activated sessionId>`
 *     -- the worker's own identity reached the elevated tree (and that tree
 *     is therefore in the sweep's population) -- while a never-activated id
 *     matches zero processes (negative control). See the assertion's own
 *     comment for why the wrapper pid's environ cannot carry it.
 *   - Closing the bundle-sibling gap documented above (OPT-IN, via the
 *     `EMBEDDED_AGENT_ENTRY_PATH` env var, since this smoke's default
 *     checkout has no `dist/embedded-agent.js` sibling to exercise): when
 *     set, a positive `/proc/<pid>/cmdline` assertion, PAIRED in the SAME
 *     run with the `ready` assertion above (same activation, same pid, no
 *     separate re-run). NEITHER half alone is the proof:
 *       - The cmdline match shows the SERVER composed the configured entry
 *         path into the elevated command -- it does NOT by itself show the
 *         elevated user could actually open that file, which is #1668's
 *         actual defect (a world-unreadable path composed into argv would
 *         still show up in cmdline and still fail to run).
 *       - The paired `ready` assertion is what proves the child process
 *         actually executed that entry to a working init handshake as the
 *         second OS user.
 *     Only both together prove the short-circuit reached a real, executable
 *     spawn -- a cmdline match with no completed handshake, or a completed
 *     handshake with no cmdline match, are both insufficient on their own.
 *
 *     The pid this reads is `spawnAsUser`'s own `['sh', '-c', command]`
 *     process (`buildSpawnArgs` in privilege-elevation.ts) -- in the
 *     non-elevated (degenerate, same-user) branch this `sh` does NOT exec
 *     into `bun`; it stays alive as a shell that forked `bun <entry>` as a
 *     CHILD process and sits in `wait4()` for it (confirmed via
 *     `ps -o pid,ppid,stat,args --ppid <pid>` on a quiet host: the `sh`'s
 *     own STAT stayed `S` for the worker's whole activation, with a
 *     separate-pid `bun <entry>` child alongside it). Reading the wrapper's
 *     OWN pid is deliberate, not a wrapper-vs-child mismatch: `sh -c`'s
 *     argv already embeds the full `'bun' '<entry>'` string verbatim
 *     (`shellEscape`d), so the wrapper's cmdline is sufficient proof of
 *     composition (the first half above) on its own, and it is the pid
 *     `internalWorker.subprocess.pid` actually exposes.
 *
 *     The read itself happens IMMEDIATELY after activation via a single
 *     `Bun.file(...).text()` call, not later alongside the negative /proc
 *     checks below and not via a preceding `.exists()` probe or an external
 *     `ps` invocation. OBSERVATION, mechanism not identified: on a quiet
 *     host the wrapper pid's `cmdline` is stable and reads correctly at any
 *     point during the activation (confirmed via `ps` snapshots taken both
 *     immediately after spawn and again after `ready`, byte-identical).
 *     Under this host's OWN sustained swap-exhaustion load, a SINGLE fast
 *     `.text()` read on that SAME live, non-zombie pid returned the correct
 *     content in 5/5 repeated runs, while adding ANY extra round trip to the
 *     same read -- a preceding `.exists()` stat() call, or replacing the
 *     read with an external `ps -p <pid>` subprocess spawn -- returned EMPTY
 *     content or "no such process" in 5/5 repeated runs, for the SAME pid,
 *     in the SAME run, with the process confirmed alive a moment later by
 *     the very next single-read check. WHY the extra round trip changes the
 *     result is not established here (an empty `/proc/<pid>/cmdline` read
 *     for a live, non-zombie, non-exiting task is not a documented outcome
 *     this comment can explain with confidence -- see `.claude/rules/
 *     os-environment-coupling.md`'s "don't trust 'should work' reasoning
 *     about OS behavior": a wrong mechanism stated confidently is worse than
 *     an unexplained repro). What IS established, by the repro counts above,
 *     is that the single immediate-post-spawn read is robust to whatever
 *     this is, regardless of cause. Opt in with either:
 *       # against a real build's bundle sibling:
 *       bun run build
 *       EMBEDDED_AGENT_ENTRY_PATH="$(pwd)/dist/embedded-agent.js" \
 *         bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>
 *       # or, on a live multi-user host, the real unified path:
 *       EMBEDDED_AGENT_ENTRY_PATH=/usr/local/lib/agent-console/embedded-agent.js \
 *         bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>
 *     The bundle-sibling form is expected to FAIL against a real second
 *     <target-user> on a live multi-user host -- the path under this
 *     checkout's own owner is exactly the unreachable-to-other-users path
 *     this whole config knob exists to route around, so a real cross-user
 *     run reproducing that failure is this check's own detection power
 *     confirming itself, not a gotcha. It is for local, same-user
 *     (degenerate-mode) iteration only;
 *     use the unified-path form for an actual pass/fail verification. (When
 *     invoking via an elevated login shell to reach the target user, set
 *     the variable via `env` AFTER the user switch, not as a prefix before
 *     it -- see docs/multi-user-setup-guide.md's Post-deploy Verification
 *     section for why a prefix silently does not reach `bun`.)
 *
 * What this smoke does NOT exercise:
 *   - The full user-message / tool-call / final-answer turn. `ready` fires at
 *     the end of the init handshake (loop's own MCP `listTools()` call),
 *     BEFORE any user message -- this smoke stops there. The full turn is
 *     already covered by the shipping-path E2E test at
 *     `packages/integration/src/embedded-agent-e2e.test.ts` (single-user mode).
 *   - Provider round-trip behavior. The stub provider server is inert (404s
 *     everything); the smoke never sends a user-message, so the provider is
 *     never dialed. The `provider.baseUrl` field is only present because the
 *     embedded-agent definition schema requires it.
 *
 * Note on AGENT_CONSOLE_MCP_AUTH: this smoke sets it EXPLICITLY from the
 * `--auth-mode` flag (default `enforce`), next to `AUTH_MODE=multi-user`. An
 * earlier revision left it unset on the premise that "unset + multi-user
 * resolves to enforce"; that default flip landed and was then reverted
 * (Issue #1107 is the open item to restore it), and `resolveMcpAuthMode`
 * returns `warn` for an unset value regardless of `AUTH_MODE`
 * (`packages/server/src/mcp/__tests__/mcp-auth.test.ts` pins exactly that)
 * -- so every run under the old premise exercised the `/mcp` boundary in
 * `warn` mode while claiming `enforce` (found by CodeRabbit on PR #1736;
 * Issue #1738 then added the E1/E2 read-back and the `--auth-mode warn`
 * polarity arm above). Setting the value explicitly is what makes the
 * "enforce" in this file's assertions true; E1 is what proves it.
 *
 * Usage:
 *   bun scripts/smoke/check-embedded-agent-elevation.ts <target-user> [--auth-mode enforce|warn]
 *   # default arm (enforce): E1 refused 401, E2 admitted 200
 *   bun scripts/smoke/check-embedded-agent-elevation.ts <target-user>
 *   # polarity arm (warn): E1 accepted 200 + exact warn line logged, E2 admitted 200
 *   bun scripts/smoke/check-embedded-agent-elevation.ts <target-user> --auth-mode warn
 *
 * Requirements:
 *   - Run as a user with elevation privilege for <target-user> (a working,
 *     non-interactive `sudo -u <target-user> -i ...` path). On the dogfood
 *     host this typically means running as the agentconsole service user
 *     (sudoers rules from scripts/setup-multiuser-for-ubuntu.sh).
 *   - <target-user> must be a real OS user with a login shell.
 *   - `bun install` must have wired `@agent-console/embedded-agent` into the
 *     server package's workspace resolution (true for any checkout that ran
 *     the repo's normal install step) -- otherwise the package-resolution
 *     assertion below fails by design.
 *   - Degenerate mode: passing the CURRENT process user as <target-user>
 *     exercises the entire pipeline (entry resolution, real subprocess, real
 *     MCP handshake + E1/E2 gate read-back, /proc negative checks) EXCEPT the actual
 *     cross-user `sudo` boundary crossing, since `spawnAsUser` bypasses
 *     elevation when the target user equals the server-process user. Useful
 *     when no second OS user + configured elevation is available.
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (system is wrong)
 *   2  bad usage / cannot run (missing target user, an unknown flag or an
 *      `--auth-mode` value other than enforce|warn, launch failure; also
 *      fired by the EMBEDDED_AGENT_BUN_PATH probe-cannot-run guard below when
 *      an absolute EMBEDDED_AGENT_BUN_PATH is configured but not present on
 *      disk -- the multi-user setup script's bun-copy step was not applied --
 *      and, symmetrically, when this smoke's own bare-name fallback ('bun',
 *      used when the operator's environment has no EMBEDDED_AGENT_BUN_PATH
 *      set at all -- NOT the production server's own default, which since
 *      Issue #1291 is `process.execPath`, an absolute path) cannot be
 *      resolved at all, e.g. under a real `sudo` invocation whose
 *      secure_path excludes a user-local ~/.bun/bin; also fired by the
 *      Issue #1222 live-process assertion when `systemctl` / the
 *      `agent-console` unit / its `/proc/<pid>/exe` cannot be resolved --
 *      the live-server check needs the real production service active,
 *      distinct from an assertion FAILURE which means the service IS
 *      running but on the wrong binary; also fired by the
 *      EMBEDDED_AGENT_ENTRY_PATH probe-cannot-run guard when it is
 *      configured but not present on disk)
 *
 * Sync contract: entry-path resolution is imported directly from
 * `resolveEmbeddedAgentEntryPath` (packages/server/src/services/
 * embedded-agent-worker-service.ts) -- the exact function
 * `EmbeddedAgentWorkerService` uses for its own default. No replication.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
// `compareBinaryIdentity` / `isOtherExecutable` are pure (no filesystem
// access at import time, no top-level side effects) and do not transitively
// import server-config.ts, so this is safe as a static import above the
// env-var prelude below -- unlike the deferred dynamic imports further down.
import {
  compareBinaryIdentity,
  isOtherExecutable,
} from '../../packages/server/src/lib/embedded-agent-bun-path-check.js';
// No transitive server-config.ts import (pure node:fs/promises + node:os +
// node:path + Bun.spawn), so this is safe as a static import above the
// env-var prelude, same as the two imports above.
import { createDisposableMultiUserHome } from './disposable-multi-user-home.js';
// Type-only imports are erased at compile time -- they do NOT trigger module
// evaluation, so they are safe above the env-var prelude despite the module
// they point at (app-context.ts) transitively importing server-config.ts, and
// despite packages/shared internally importing valibot.
import type { AppContext } from '../../packages/server/src/app-context.js';

/**
 * Minimal shape this smoke needs from an `EmbeddedAgentStreamEvent` line.
 * Deliberately NOT full valibot schema validation (unlike the shipping-path
 * E2E test): the smoke's job is to detect the `ready` / `fatal` / `turn-error`
 * signals that decide pass/fail, not to re-prove protocol conformance (already
 * exhaustively covered by packages/shared/src/schemas/__tests__/embedded-agent.test.ts
 * and the E2E test). This also sidesteps a real dependency-resolution
 * constraint: `scripts/smoke/` has no `node_modules` ancestry containing
 * `valibot` (it is only hoisted under `packages/shared/node_modules` and
 * `packages/server/node_modules`), so importing the `valibot` package
 * directly from this script would fail to resolve at runtime.
 */
function parseStreamEventLine(line: string): { type: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof json === 'object' && json !== null && typeof (json as { type?: unknown }).type === 'string') {
    return json as { type: string };
  }
  return undefined;
}

// The production systemd unit name rendered by setup-multiuser-for-ubuntu.sh
// (SYSTEMD_TARGET = /etc/systemd/system/agent-console.service). Used by the
// live-process assertion below to resolve the actual running server's PID.
const SYSTEMD_UNIT_NAME = 'agent-console';

/**
 * Marks a setup/launch failure (e.g. the disposable home's 2775 contract
 * verification) distinct from an unexpected exception during the actual
 * probe run. Caught separately in `main()`'s catch block so a setup failure
 * still runs the `finally` block's cleanup before exiting `2` (per this
 * script's documented exit-code contract), instead of either bypassing
 * cleanup via a bare `process.exit(2)` or being folded into `failures` and
 * exiting `1` like a genuine assertion failure. Same shape and rationale as
 * `check-embedded-agent-bash-env.ts`'s identically-named class.
 */
class SmokeSetupError extends Error {}

/**
 * The two `/mcp` gate modes this smoke can drive. `off` is deliberately not
 * offered: it has no observable of its own at the boundary (a tokenless call
 * is admitted silently, indistinguishable from `warn` minus the log line),
 * and nothing in this smoke's contract is about `off`.
 */
export type SmokeAuthMode = 'enforce' | 'warn';

/**
 * The gate's exact texts, copied from `evaluateMcpAuthGate` in
 * `packages/server/src/mcp/mcp-auth.ts`. Asserted by string EQUALITY (not
 * `includes`) so a reworded gate message fails here loudly rather than being
 * matched by a looser substring. Deliberately NOT imported from mcp-auth.ts:
 * the point of E1 and the warn arm is to read the gate's behaviour back
 * from the running instance, and an assertion that compares the gate's
 * output against the gate's own constant would pass under any rewording,
 * including one that broke the contract these lines document.
 */
const ENFORCE_REFUSAL_TEXT =
  'MCP authentication required: no bearer token presented (AGENT_CONSOLE_MCP_AUTH=enforce)';
const WARN_LOG_LINE = 'MCP request without verified caller identity; proceeding (AGENT_CONSOLE_MCP_AUTH=warn)';

function printUsageAndExit(reason: string): never {
  console.error(`error: ${reason}`);
  console.error('usage: bun scripts/smoke/check-embedded-agent-elevation.ts <target-user> [--auth-mode enforce|warn]');
  process.exit(2);
}

/**
 * `<target-user>` is the sole positional; `--auth-mode <enforce|warn>` (or
 * `--auth-mode=<value>`) selects BOTH the value written to
 * `AGENT_CONSOLE_MCP_AUTH` and the assertion set applied to the tokenless
 * `/mcp` call, so the two arms are one apparatus with inverted expectations
 * (the sibling `--expect-*` convention, here as a mode selector because the
 * inverse world is a real supported configuration rather than a removed
 * fix). Default `enforce`. A leading `--` (the form the sibling smokes
 * accept for `bun script -- --flag`) is tolerated. Exported for
 * `__tests__/check-embedded-agent-elevation.test.ts` (import-safe: the only
 * top-level invocation in this file is behind `import.meta.main`).
 */
export function parseArgs(argv: string[]): { targetUsername: string; authMode: SmokeAuthMode } {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let targetUsername: string | undefined;
  let authMode: SmokeAuthMode = 'enforce';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let modeValue: string | undefined;
    if (arg === '--auth-mode') {
      modeValue = args[++i];
    } else if (arg.startsWith('--auth-mode=')) {
      modeValue = arg.slice('--auth-mode='.length);
    } else if (arg.startsWith('--')) {
      printUsageAndExit(`unknown flag: ${arg}`);
    } else if (targetUsername === undefined) {
      targetUsername = arg;
      continue;
    } else {
      printUsageAndExit(`unexpected extra argument: ${arg}`);
    }
    if (modeValue !== 'enforce' && modeValue !== 'warn') {
      printUsageAndExit(`invalid --auth-mode value: ${String(modeValue)} (expected enforce|warn)`);
    }
    authMode = modeValue;
  }
  if (!targetUsername) {
    printUsageAndExit('missing <target-user>');
  }
  return { targetUsername, authMode };
}

const failures: string[] = [];
let passes = 0;
const expect = (cond: boolean, label: string, detail?: string): void => {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
};

async function main(): Promise<void> {
  // --- Probe-cannot-run guard (Issue #1221): EMBEDDED_AGENT_BUN_PATH pre-check.
  // Moved into main() (Issue #1479) -- was top-level, which ran on import.
  // Runs FIRST, before any other side effect in this function (process.chdir
  // below, the deferred-import env-var-ordering prelude further down) -- an
  // absolute EMBEDDED_AGENT_BUN_PATH that isn't actually present on this
  // machine would otherwise just reproduce the exit-127 bug this smoke exists
  // to catch, with a much less informative failure (a generic activation
  // timeout instead of a direct "the configured path doesn't exist" message).
  // When EMBEDDED_AGENT_BUN_PATH is unset, this guard is a no-op (normal PATH
  // resolution default, no absolute-path expectation, always runnable).
  const configuredBunPath = process.env.EMBEDDED_AGENT_BUN_PATH;
  if (configuredBunPath && configuredBunPath.startsWith('/') && !(await Bun.file(configuredBunPath).exists())) {
    console.error(
      `EMBEDDED_AGENT_BUN_PATH=${configuredBunPath} is configured but does not exist on disk -- this ` +
        'smoke cannot run meaningfully without the multi-user setup script\'s bun-copy step having been ' +
        'applied. Run scripts/setup-multiuser-for-ubuntu.sh or manually copy bun to that path, or unset ' +
        'EMBEDDED_AGENT_BUN_PATH to test the single-user default.',
    );
    process.exit(2);
  }

  // --- Same probe-cannot-run guard, for EMBEDDED_AGENT_ENTRY_PATH. Unlike
  // EMBEDDED_AGENT_BUN_PATH, this one is OPT-IN for this smoke (unset by
  // default -- see "closing the bundle-sibling gap" in the header comment):
  // set it to exercise the deployment-correct short-circuit path, either
  // against a real `bun run build` output (`<repo>/dist/embedded-agent.js`)
  // or the real unified path on a live multi-user host
  // (/usr/local/lib/agent-console/embedded-agent.js). Leaving it unset
  // exercises only the pre-existing package-resolution coverage below.
  const configuredEntryPath = process.env.EMBEDDED_AGENT_ENTRY_PATH;
  if (configuredEntryPath && !(await Bun.file(configuredEntryPath).exists())) {
    console.error(
      `EMBEDDED_AGENT_ENTRY_PATH=${configuredEntryPath} is configured but does not exist on disk -- run ` +
        '`bun run build` first to produce dist/embedded-agent.js, or unset EMBEDDED_AGENT_ENTRY_PATH to ' +
        'test only the default package-resolution path.',
    );
    process.exit(2);
  }

  // Ad-hoc invocation inherits cwd from the caller (often /root or an
  // interactive user's home, neither readable by an elevation-target service
  // account). Bun's spawn machinery evaluates the calling process's cwd, and an
  // inherited unreadable cwd produces EACCES on posix_spawn (same root cause
  // documented in check-multiuser-pty-env.ts). Neutralize at script start.
  process.chdir('/');

  const { targetUsername, authMode } = parseArgs(process.argv.slice(2));

  // --- CRITICAL ordering: env vars must be set before ANY module that reads
  // `serverConfig.AUTH_MODE` is evaluated. `packages/server/src/lib/
  // server-config.ts` computes `AUTH_MODE` via a top-level IIFE at MODULE-LOAD
  // time (`AUTH_MODE: (() => { ... })()`), not at call time. This assignment
  // only needs to run before the dynamic imports below, in this same
  // function, which it does as one of this function's first statements
  // (Issue #1479 moved it here from top-level; the ordering requirement is
  // unchanged, only the requirement's proof changed: it no longer depends on
  // where an `import` declaration sits relative to it in the whole file, only
  // on this function's own statement order).
  //
  // The only way to guarantee ordering in a single script is to defer every
  // import that transitively touches server-config.ts to a DYNAMIC `import()`
  // call, made from inside `main()`, AFTER the env vars below are set. Modules
  // that do not transitively import server-config.ts (node:os, node:path,
  // node:crypto, hono, @agent-console/shared) are safe as static imports.
  //
  // Verified empirically during smoke development: a temporary
  // `console.log(serverConfig.AUTH_MODE)` placed as the first line inside
  // `main()` printed 'multi-user' (not 'none'), confirming this ordering holds.
  //
  // `AGENT_CONSOLE_MCP_AUTH` is set EXPLICITLY from the `--auth-mode` flag
  // (default `enforce` -- see the "Note on AGENT_CONSOLE_MCP_AUTH" header
  // comment above: the resolver's default is `warn` for every AUTH_MODE
  // since Issue #1107, so an unset value would run the `/mcp` boundary in
  // warn mode while this file's assertions talk about enforce). The `warn`
  // arm is the polarity arm: same apparatus, inverted assertions on the
  // same tokenless call. Unlike `AUTH_MODE`, this variable carries no
  // module-load-time ordering hazard: `resolveMcpAuthMode`'s `rawValue`
  // parameter defaults to `process.env.AGENT_CONSOLE_MCP_AUTH` evaluated at
  // CALL time (a JS default parameter, not a module-load-time IIFE), and it
  // is only called later, from inside `main()`, once `createMcpApp` builds
  // the `/mcp` route -- setting it here, before the deferred imports, is
  // sufficient.
  process.env.AUTH_MODE = 'multi-user';
  process.env.AGENT_CONSOLE_MCP_AUTH = authMode;

  // --- Deferred imports: everything below transitively imports server-config.ts,
  // so it must be dynamically imported AFTER the env vars above are set.
  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.js');
  const { createTestContext, shutdownAppContext } = await import(
    '../../packages/server/src/app-context.js'
  );
  const { api } = await import('../../packages/server/src/routes/api.js');
  const { createMcpApp } = await import('../../packages/server/src/mcp/mcp-server.js');
  const { resolveEmbeddedAgentEntryPath } = await import(
    '../../packages/server/src/services/embedded-agent-worker-service.js'
  );
  // Issue #1694: the positive /proc environ assertion scans AS THE TARGET
  // USER through the real elevation primitive (see the assertion's comment
  // for why the server process cannot read the elevated tree's environ).
  const { runAsUser, shellEscape } = await import(
    '../../packages/server/src/services/privilege-elevation.js'
  );
  // The warn arm's observable is a LOG LINE, not an HTTP status, so the
  // smoke needs an instrument on the server's logger. `mcp-auth.ts` logs
  // through `createLogger('mcp-auth')`, a pino child of `rootLogger`; pino
  // builds a child with `Object.create(parent)` and, absent a per-child
  // level, never defines its own level methods -- so the child's `warn`
  // resolves through the prototype chain to whatever `rootLogger.warn` is
  // AT CALL TIME. Replacing that one property with a recording pass-through
  // therefore observes the gate's `log.warn(...)` without touching
  // mcp-auth.ts (the same seam the unit tests use via `spyOn(rootLogger,
  // ...)`; `bun:test`'s spyOn is not importable outside the test runner, so
  // this is the hand-rolled equivalent). The pass-through keeps the real
  // sink working, and `this` is forwarded so the child's own bindings still
  // apply. Installed BEFORE the app server exists, so no warn from the
  // gate can predate the instrument.
  const { rootLogger } = await import('../../packages/server/src/lib/logger.js');
  const recordedWarnLines: string[] = [];
  const originalRootWarn = rootLogger.warn;
  rootLogger.warn = function recordingWarn(this: unknown, ...args: unknown[]) {
    const msg = args.find((a): a is string => typeof a === 'string');
    if (msg !== undefined) recordedWarnLines.push(msg);
    return Reflect.apply(originalRootWarn, this, args);
  } as typeof rootLogger.warn;

  // `hono` is only hoisted under packages/server/node_modules (and
  // packages/client, packages/shared), not under any node_modules ancestor of
  // scripts/smoke/ -- a bare `import { Hono } from 'hono'` in THIS file would
  // fail to resolve at runtime. Resolve it as packages/server would (same
  // technique `resolveEmbeddedAgentEntryPath` uses for the embedded-agent
  // package edge) and import the resolved absolute path instead.
  const serverSrcDir = path.join(import.meta.dir, '../../packages/server/src');
  const honoEntryPath = Bun.resolveSync('hono', serverSrcDir);
  // Not typed against the `hono` package's own declarations (that would
  // require resolving the 'hono' type-declaration module from THIS file's
  // location, hitting the same node_modules-ancestry gap as the runtime
  // import above). Loosely typed is acceptable here: scripts/smoke/ is not
  // part of the `bun run typecheck` pipeline (no tsconfig covers `scripts/`),
  // and Bun strips types at runtime regardless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Hono } = (await import(honoEntryPath)) as { Hono: new () => any };

  let ctx: AppContext | undefined;
  let appServer: ReturnType<typeof Bun.serve> | undefined;
  let stubServer: ReturnType<typeof Bun.serve> | undefined;
  let realCwd: string | undefined;
  let realConfigDir: string | undefined;
  let prevUmask: number | undefined;
  let sessionId: string | undefined;
  let workerId: string | undefined;

  try {
    // --- Assertion 1: entry-path resolution takes the package-resolution branch. ---
    console.log('==> entry-path resolution');
    const resolution = resolveEmbeddedAgentEntryPath();
    console.log(`  resolved path:   ${resolution.path}`);
    console.log(`  resolved source: ${resolution.source}`);
    expect(
      resolution.source === 'package',
      "resolveEmbeddedAgentEntryPath() took the package-resolution branch (not the dev-source-tree fallback)",
      `got source='${resolution.source}'; this smoke runs from a checkout (no dist/embedded-agent.js sibling), so 'package' is the only deployment-correct branch reachable here -- a bundled production deploy instead takes the 'bundle' branch, covered by a fixture-directory unit test rather than this smoke`,
    );
    expect(
      await Bun.file(resolution.path).exists(),
      'resolved entry path exists on disk',
      resolution.path,
    );
    if (configuredEntryPath) {
      // resolveEmbeddedAgentEntryPath() itself has no knowledge of
      // EMBEDDED_AGENT_ENTRY_PATH -- the short-circuit happens one layer up,
      // in EmbeddedAgentWorkerService's constructor (resolveConstructorEntryPath),
      // which this smoke never constructs directly. This assertion is
      // therefore unaffected by the env var; the real proof that the
      // short-circuit reached the actually-spawned process is the
      // `/proc/<pid>/cmdline` assertion later in this run, paired with the
      // `ready` assertion below -- see this file's header comment.
      console.log(
        `  (informational) EMBEDDED_AGENT_ENTRY_PATH=${configuredEntryPath} is configured but does not ` +
          "affect this raw resolver call -- see the /proc/<pid>/cmdline assertion below for the real proof.",
      );
    }

    // --- Assertion 2 (Issue #1222 redesign, replacing the Issue #1221
    // follow-up comparison -- NOT a repoint): before Issue #1222,
    // setup-multiuser-for-ubuntu.sh rendered ExecStart from the service
    // user's own `${service_home}/.bun/bin/bun` while hardcoding
    // Environment=EMBEDDED_AGENT_BUN_PATH= to `/usr/local/bin/bun`, two
    // independent values. This assertion compared them (via `--version`) to
    // catch drift between the two. Issue #1222 unified both to derive from
    // the SAME rendered value, so as of that unification the two are always
    // the identical file -- continuing to compare
    // `${EMBEDDED_AGENT_BUN_PATH} --version` against
    // `${service_home}/.bun/bin/bun --version` would be a file-vs-itself
    // comparison: it can never fail, and would sit here passing forever
    // while proving nothing (see Issue #1222's architect ruling, which
    // explicitly corrects the Issue's own earlier "resync serverBunPath"
    // note -- that note predates the fix and would have produced exactly
    // this vacuous test if followed literally).
    //
    // What actually carries meaning after unification is RUNTIME reality,
    // not template intent: does the LIVE `agent-console.service` process
    // actually execute the configured EMBEDDED_AGENT_BUN_PATH binary? This
    // fails if the unit was never (re)installed after the #1222 upgrade, or
    // if someone hand-edited ExecStart and restarted with a different
    // binary -- both cases the OLD comparison could never detect (it only
    // ever inspected two config-derived strings, never what was actually
    // running). Only meaningful when EMBEDDED_AGENT_BUN_PATH is configured
    // to an absolute path (the multi-user contract); the smoke's own
    // bare-name fallback ('bun', used only when the operator's environment
    // has EMBEDDED_AGENT_BUN_PATH unset -- since Issue #1291 the production
    // server's own default is `process.execPath`, an absolute path, so this
    // fallback exists purely for the smoke's own degenerate-mode probing)
    // has no unified path to verify against -- Issue #1222 Ruling 2
    // explicitly scopes unification to multi-user (the single-user template
    // is unchanged). ---
    console.log('==> configured bun-path resolvability check');
    const configuredBunCmd = process.env.EMBEDDED_AGENT_BUN_PATH || 'bun';
    let configuredVersionResult: ReturnType<typeof Bun.spawnSync>;
    try {
      configuredVersionResult = Bun.spawnSync([configuredBunCmd, '--version']);
    } catch (err) {
      // Bun.spawnSync throws synchronously (rather than returning a non-zero
      // exit code) when the executable cannot be resolved via PATH at all.
      // Reached via this smoke's own bare-name fallback ('bun', bare-name,
      // PATH-resolved -- NOT the production server's default, see above)
      // branch when no absolute EMBEDDED_AGENT_BUN_PATH is configured: e.g.
      // under a real `sudo` invocation, the elevated child's PATH is sudo's
      // own secure_path, which does not include a user-local ~/.bun/bin --
      // so 'bun' is unresolvable until the multi-user setup script's
      // bun-copy step has provisioned /usr/local/bin/bun AND
      // EMBEDDED_AGENT_BUN_PATH has been set to point at it. Not a real
      // assertion failure; the environment simply isn't ready to run this
      // smoke meaningfully yet.
      console.error(
        `Could not execute '${configuredBunCmd} --version' (${err instanceof Error ? err.message : String(err)}) -- ` +
          'this smoke cannot run meaningfully without a resolvable bun binary. If EMBEDDED_AGENT_BUN_PATH is unset, ' +
          "the elevated shell's PATH (e.g. sudo's secure_path) may not include a user-local bun install; run " +
          'scripts/setup-multiuser-for-ubuntu.sh to provision /usr/local/bin/bun and set EMBEDDED_AGENT_BUN_PATH ' +
          'accordingly, then re-run this smoke.',
      );
      process.exit(2);
    }
    const configuredVersion = configuredVersionResult.stdout.toString().trim();
    console.log(`  configured (${configuredBunCmd}): ${configuredVersion}`);

    console.log('==> live systemd server process executes the configured EMBEDDED_AGENT_BUN_PATH');
    if (configuredBunCmd.startsWith('/')) {
      let pidResult: ReturnType<typeof Bun.spawnSync>;
      try {
        pidResult = Bun.spawnSync(['systemctl', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT_NAME]);
      } catch (err) {
        console.error(
          `Could not run 'systemctl show -p MainPID --value ${SYSTEMD_UNIT_NAME}' (${err instanceof Error ? err.message : String(err)}) -- ` +
            'this assertion needs systemd and the production agent-console.service unit to check the live process.',
        );
        process.exit(2);
      }
      const pidRaw = pidResult.stdout.toString().trim();
      if (pidResult.exitCode !== 0 || !pidRaw || pidRaw === '0') {
        console.error(
          `Could not resolve a running MainPID for systemd unit '${SYSTEMD_UNIT_NAME}' ` +
            `(exit=${pidResult.exitCode} stdout='${pidRaw}' stderr='${pidResult.stderr.toString().trim()}') -- ` +
            `this assertion needs the production service active. Run 'sudo systemctl status ${SYSTEMD_UNIT_NAME}' ` +
            'and start it if needed, then re-run this smoke.',
        );
        process.exit(2);
      }
      // Comparison delegated to the production `compareBinaryIdentity`
      // (packages/server/src/lib/embedded-agent-bun-path-check.ts, Issue
      // #1291) -- the same function the boot-time WARN uses -- rather than
      // reimplementing the realpath-and-compare logic here (single writer).

      // Positive control: exercise the IDENTICAL code path against this
      // smoke process's own /proc/self/exe compared to itself, BEFORE
      // comparing against the live (other-process) pid below. This makes a
      // later `{ unresolvable: 'self' }` result on the live pid attributable
      // specifically to a permission gap reading THAT OTHER process's
      // /proc/<pid>/exe -- rather than to some broader failure of
      // /proc/self/exe resolution in this environment, which this control
      // rules out first.
      const selfControlIdentity = await compareBinaryIdentity('/proc/self/exe', '/proc/self/exe', {
        realpath: async (p: string) => realpathSync(p),
      });
      if (selfControlIdentity !== 'same') {
        console.error(
          "Positive control failed: compareBinaryIdentity('/proc/self/exe', '/proc/self/exe', ...) returned " +
            `${JSON.stringify(selfControlIdentity)} instead of 'same' -- this environment does not support ` +
            '/proc/self/exe resolution at all, so nothing about the live-pid comparison below can be trusted here.',
        );
        process.exit(2);
      }

      const exeLinkPath = `/proc/${pidRaw}/exe`;
      console.log(`  live server exe (pid ${pidRaw}):    ${exeLinkPath}`);
      console.log(`  configured EMBEDDED_AGENT_BUN_PATH: ${configuredBunCmd}`);
      const identity = await compareBinaryIdentity(exeLinkPath, configuredBunCmd, {
        realpath: async (p: string) => realpathSync(p),
      });
      if (typeof identity === 'object') {
        const reason = identity.unresolvable;
        if (reason === 'self') {
          // The LIVE server process's own executable could not be read --
          // this is the permission-gap case: reading ANOTHER process's
          // /proc/<pid>/exe needs PTRACE_MODE_READ, which (absent
          // CAP_SYS_PTRACE) requires the reader to share BOTH uid and gid
          // with the target process, not merely be able to run as it via
          // sudo. Not an assertion failure -- the probe itself could not run.
          console.error(
            `Could not resolve the LIVE server process's own executable '${exeLinkPath}' (pid ${pidRaw}) -- this ` +
              "is a permission gap, not a proof that the binaries differ. Re-run this smoke AS the " +
              `${SYSTEMD_UNIT_NAME}.service unit's own identity -- matching BOTH the unit's configured User= and ` +
              'Group= (or root) -- then retry.',
          );
          process.exit(2);
        } else if (reason === 'configured') {
          console.error(
            `Could not resolve the configured EMBEDDED_AGENT_BUN_PATH '${configuredBunCmd}' -- verify the path ` +
              'exists and is reachable by this smoke process, then re-run.',
          );
          process.exit(2);
        } else if (reason === 'bare') {
          // Unreachable: this whole branch is gated on
          // `configuredBunCmd.startsWith('/')` above, and compareBinaryIdentity
          // only ever returns 'bare' when the CONFIGURED argument itself is
          // not absolute. Handled anyway so this if/else chain stays
          // exhaustive and type-safe against a future change to that gate.
          throw new Error(
            `internal error: compareBinaryIdentity returned { unresolvable: 'bare' } despite an absolute ` +
              `configuredBunCmd ('${configuredBunCmd}')`,
          );
        } else {
          const _exhaustive: never = reason;
          throw new Error(`internal error: unhandled BinaryIdentity unresolvable reason: ${String(_exhaustive)}`);
        }
      }
      expect(
        identity === 'same',
        'live agent-console.service process executes the configured EMBEDDED_AGENT_BUN_PATH (Issue #1222 -- unit reinstalled and ExecStart matches what is actually running; compared via the production compareBinaryIdentity helper)',
        `identity='${JSON.stringify(identity)}' liveExe(raw)='${exeLinkPath}' configured(raw)='${configuredBunCmd}'`,
      );
    } else {
      console.log(
        '  skipped: EMBEDDED_AGENT_BUN_PATH is not an absolute path in this smoke\'s own environment -- no ' +
          'unified path to verify (Issue #1222 Ruling 2 scopes unification to multi-user deployments only; ' +
          'the production server\'s own default is process.execPath, an absolute path, since Issue #1291 -- ' +
          'this branch is reached only via this smoke\'s own bare-name fallback or an explicit bare override).',
      );
    }

    // --- Freshness signal (Issue #1222 Ruling 1 -- WARNING, never a
    // failure): unification removes drift BETWEEN the server and the
    // embedded-agent subprocess (both now execute the same
    // EMBEDDED_AGENT_BUN_PATH file, verified above). It does NOT eliminate
    // ALL drift -- the service user's OWN `~/.bun/bin/bun` can still
    // legitimately advance past the provisioned EMBEDDED_AGENT_BUN_PATH
    // after a `bun upgrade`, until scripts/setup-multiuser-for-ubuntu.sh is
    // re-run. That divergence is expected freshness (the deployed server
    // deterministically stays on its provisioned version until
    // re-provisioned), not a correctness bug, so it is reported and never
    // fails the smoke. ---
    console.log('==> freshness check: service-user bun vs unified bun (warning-only, not a failure)');
    const serviceUserBunPath = path.join(os.homedir(), '.bun', 'bin', 'bun');
    try {
      const serviceUserVersionResult = Bun.spawnSync([serviceUserBunPath, '--version']);
      if (serviceUserVersionResult.exitCode === 0) {
        const serviceUserVersion = serviceUserVersionResult.stdout.toString().trim();
        if (configuredVersion !== serviceUserVersion) {
          console.warn(
            `  WARN  ${configuredBunCmd} is ${configuredVersion}, but ${serviceUserBunPath} (service user's own bun) is ` +
              `${serviceUserVersion} -- re-run scripts/setup-multiuser-for-ubuntu.sh to refresh the provisioned copy ` +
              'if you want the server to pick up the newer version. Not a failure: the deployed server stays on its ' +
              'provisioned version until setup is re-run (Issue #1222).',
          );
        } else {
          console.log(`  OK    ${configuredBunCmd} matches service-user bun (${configuredVersion})`);
        }
      } else {
        console.log('  skipped: could not run --version on the service-user bun path (non-fatal, informational check only)');
      }
    } catch {
      console.log('  skipped: could not spawn the service-user bun binary for the freshness check (non-fatal)');
    }

    // --- Other-user-executable check (Issue #1291, warning-only, not a
    // failure): a configured EMBEDDED_AGENT_BUN_PATH that is not executable
    // by users other than its owner means an elevated activation for any
    // target user other than the file's owner will fail with EACCES --
    // absent from this smoke prior to #1291. Uses the same production
    // `isOtherExecutable` (packages/server/src/lib/embedded-agent-bun-path-check.ts)
    // the boot-time WARN uses. Only meaningful for an absolute path (mirrors
    // the identity check's absolute-path gate above); the single-user/dev
    // default has no fixed file to stat. ---
    console.log('==> other-user-executable check (warning-only, not a failure)');
    if (configuredBunCmd.startsWith('/')) {
      const otherExecutable = await isOtherExecutable(configuredBunCmd, {
        realpath: async (p: string) => realpathSync(p),
        stat,
      });
      if (typeof otherExecutable === 'object' && otherExecutable.executable === false) {
        console.warn(
          `  WARN  ${configuredBunCmd}: ${otherExecutable.kind} ${otherExecutable.blockedAt} ` +
            `(mode ${otherExecutable.mode.toString(8)}) is not reachable/executable by users other than its owner -- ` +
            "an elevated activation for a target user other than this path's owner will fail with EACCES. Re-run " +
            "scripts/setup-multiuser-for-ubuntu.sh, or fix its permissions/location.",
        );
      } else if (otherExecutable === true) {
        console.log(`  OK    ${configuredBunCmd} is reachable and executable by other users`);
      } else {
        console.log(
          '  skipped: could not resolve/stat the configured EMBEDDED_AGENT_BUN_PATH (or one of its containing ' +
            'directories) for the other-executable check (non-fatal)',
        );
      }
    } else {
      console.log(
        '  skipped: EMBEDDED_AGENT_BUN_PATH is not an absolute path in this smoke\'s own environment -- no path to stat.',
      );
    }

    // --- Resolve the REAL target OS user (uid + home) via the production lookup. ---
    console.log('==> resolving real target OS user');
    const osUser = await lookupOsUser(targetUsername);
    if (!osUser) {
      console.error(`PROBE FAILED: could not resolve OS user '${targetUsername}' via lookupOsUser`);
      process.exit(2);
    }
    console.log(`  uid=${osUser.uid} home=${osUser.homeDir}`);
    const serverUsername = os.userInfo().username;
    const degenerate = targetUsername === serverUsername;
    if (degenerate) {
      console.warn(
        `  WARN  target user '${targetUsername}' equals the server-process user; spawnAsUser` +
          ' will bypass elevation (degenerate same-user mode). This still exercises the full' +
          ' pipeline except the actual sudo OS-user-boundary crossing.',
      );
    }

    // --- Fixture 1: inert stub OpenAI-compatible provider. The loop is never
    // sent a user-message, so this server only needs to exist (its baseUrl is
    // a required definition field) -- it is never actually dialed. ---
    stubServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response('not found (smoke never sends a user-message)', { status: 404 });
      },
    });
    const stubBaseUrl = `http://localhost:${stubServer.port}`;

    // --- Real AppContext (in-memory SQLite via createTestContext), with the
    // loop's MCP base URL late-bound to the real app server's ephemeral port. ---
    let mcpBaseUrl = '';
    ctx = await createTestContext({ getMcpBaseUrl: () => mcpBaseUrl });

    // Real target-user identity: session.createdBy -> resolveSpawnUsername
    // resolves to this user's REAL username, so spawnAsUser actually elevates.
    const targetUser = await ctx.userRepository.upsertByOsUid(
      osUser.uid,
      targetUsername,
      osUser.homeDir,
    );

    // --- Real temp provider-keys.json (0600), AGENT_CONSOLE_HOME pointed at a
    // real temp dir BEFORE any activation reads it via loadProviderKey/getConfigDir.
    // getConfigDir() reads process.env.AGENT_CONSOLE_HOME at CALL time (not
    // module load time), so this override is safe post-import.
    //
    // The disposable home must carry the production data root's 2775 setgid
    // contract (Issue #1713) -- a plain `mkdir -p` home is 755, and the
    // memory layer's verification (memory-dir.ts) fails closed against it,
    // since AUTH_MODE=multi-user is forced above. See
    // disposable-multi-user-home.ts's header for why. ---
    const homeResult = await createDisposableMultiUserHome('ac-embedded-smoke-cfg-');
    if (!homeResult.ok) {
      // Routed through SmokeSetupError (not a bare process.exit(2)) --
      // ctx and stubServer already exist by this point (created above,
      // before this check), and this class exists precisely so a
      // setup/launch failure here still runs the finally block's other
      // cleanup (deactivate/shutdownAppContext/stop servers) before
      // exiting 2. The helper itself already removed the failed mkdtemp
      // directory (best-effort) before returning, so there is nothing left
      // for this smoke's own cleanup to do for the home; ok:false also
      // never touched process.umask(), so there is no prevUmask to capture.
      throw new SmokeSetupError(
        `cannot build a disposable AGENT_CONSOLE_HOME satisfying the multi-user data-root 2775 contract: ${homeResult.reason}`,
      );
    }
    realConfigDir = homeResult.path;
    prevUmask = homeResult.prevUmask;
    process.env.AGENT_CONSOLE_HOME = realConfigDir;
    const apiKeyRef = 'smoke-provider-key';
    const fakeApiKey = `smoke-test-fake-key-${crypto.randomUUID()}`;
    const providerKeysPath = path.join(realConfigDir, 'provider-keys.json');
    await Bun.write(providerKeysPath, JSON.stringify({ [apiKeyRef]: fakeApiKey }));
    Bun.spawnSync(['chmod', '600', providerKeysPath]);

    // --- Fixture 2: real app server (real /api router + real /mcp app),
    // mirroring packages/integration/src/embedded-agent-e2e.test.ts almost
    // verbatim. Records the Authorization header of every real HTTP request to
    // /mcp (observes, does not intercept). ---
    const capturedMcpAuth: string[] = [];
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      c.set('appContext', ctx!);
      await next();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('*', async (c: any, next: any) => {
      if (c.req.path === '/mcp') {
        const auth = c.req.header('authorization');
        if (auth) capturedMcpAuth.push(auth);
      }
      await next();
    });
    app.route('/api', api);
    const mcpApp = createMcpApp({
      sessionManager: ctx.sessionManager,
      repositoryManager: ctx.repositoryManager,
      agentManager: ctx.agentManager,
      timerManager: ctx.timerManager,
      conditionalWakeupManager: ctx.conditionalWakeupManager,
      interactiveProcessManager: ctx.interactiveProcessManager,
      worktreeService: ctx.worktreeService,
      annotationService: ctx.annotationService,
      interSessionMessageService: ctx.interSessionMessageService,
      suggestSessionMetadata: ctx.suggestSessionMetadata,
      createWorktreeWithSession: (
        await import('../../packages/server/src/services/worktree-creation-service.js')
      ).createWorktreeWithSession,
      deleteWorktree: (await import('../../packages/server/src/services/worktree-deletion-service.js'))
        .deleteWorktree,
      userRepository: ctx.userRepository,
      broadcastToApp: ctx.broadcastToApp,
      fetchPullRequestUrl: ctx.fetchPullRequestUrl,
      findOpenPullRequest: ctx.findOpenPullRequest,
      mcpTokenRegistry: ctx.mcpTokenRegistry,
    });
    app.route('', mcpApp);

    appServer = Bun.serve({ fetch: app.fetch, port: 0 });
    mcpBaseUrl = `http://localhost:${appServer.port}/mcp`;
    console.log(
      `==> real app server on :${appServer.port}, /mcp under AGENT_CONSOLE_MCP_AUTH=${authMode} ` +
        `(set explicitly by --auth-mode; the resolver's default is warn for every AUTH_MODE since #1107)`,
    );

    // Subprocess cwd must exist on the REAL filesystem.
    realCwd = path.join(os.tmpdir(), `ac-embedded-smoke-cwd-${crypto.randomUUID()}`);
    Bun.spawnSync(['mkdir', '-p', realCwd]);

    // --- Create the embedded-agent definition through the REAL REST route,
    // referencing the fake provider key via apiKeyRef. ---
    const createRes = await app.fetch(
      new Request('http://localhost/api/embedded-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Smoke inert LLM',
          provider: { baseUrl: `${stubBaseUrl}/v1`, model: 'smoke-model', apiKeyRef },
        }),
      }),
    );
    if (createRes.status !== 201) {
      console.error(`PROBE FAILED: definition create returned ${createRes.status}`);
      console.error(await createRes.text());
      throw new Error(`embedded-agent definition create returned ${createRes.status}`);
    }
    const createBody = (await createRes.json()) as { embeddedAgent: { id: string } };
    const embeddedAgentId = createBody.embeddedAgent.id;

    // --- Session owned by the REAL target user, worker, activation. ---
    const session = await ctx.sessionManager.createSession(
      { type: 'quick', locationPath: realCwd, agentId: 'claude-code-builtin' },
      { createdBy: targetUser.id },
    );
    sessionId = session.id;

    const worker = await ctx.sessionManager.createWorker(sessionId, {
      type: 'embedded-agent',
      embeddedAgentId,
    });
    if (!worker) {
      throw new Error('createWorker returned null');
    }
    workerId = worker.id;

    console.log(`==> activating embedded-agent worker (session=${sessionId} worker=${workerId})`);
    console.log(`  spawnAsUser target username: ${targetUsername} (elevated: ${!degenerate})`);
    await ctx.sessionManager.activateEmbeddedAgentWorker(sessionId, workerId);

    // --- Capture the EMBEDDED_AGENT_ENTRY_PATH short-circuit's argv proof via
    // a SINGLE fast `.text()` read, IMMEDIATELY after spawn, not later
    // alongside the negative /proc checks and not preceded by a separate
    // `.exists()` probe. The pid read here is `spawnAsUser`'s own
    // `sh -c '...'` wrapper (non-elevated branch never execs; it forks the
    // real `bun <entry>` as a child and waits on it), whose OWN argv already
    // embeds the full escaped command -- see the header comment's "closing
    // the bundle-sibling gap" section for the full `ps`-verified process-tree
    // evidence and why a two-step read or an external `ps` invocation
    // intermittently returns empty/not-found for this SAME live pid under
    // this host's sustained memory pressure (5/5 repro each way; mechanism
    // not identified -- see header comment), while one direct read does not.
    // Reading here instead of after `ready` still pairs this fact (the
    // SERVER composed the configured path into argv) with the ready
    // assertion below IN THE SAME RUN, for the SAME pid, which is what
    // proves the child actually executed that entry -- neither half alone
    // is the proof (see header comment), and pairing them does not depend
    // on which of the two is observed first, only that both hold for the
    // one activation under test.
    let earlyEntryPathCmdline: { ran: boolean; content: string } | undefined;
    if (configuredEntryPath) {
      const earlyWorker = ctx.sessionManager.getWorker(sessionId, workerId);
      const earlyPid =
        earlyWorker && earlyWorker.type === 'embedded-agent' ? earlyWorker.subprocess?.pid : undefined;
      if (earlyPid !== undefined) {
        let content: string | undefined;
        try {
          content = await Bun.file(`/proc/${earlyPid}/cmdline`).text();
        } catch {
          content = undefined;
        }
        earlyEntryPathCmdline = { ran: content !== undefined, content: content ?? '' };
      }
    }

    // --- Poll the replayed NDJSON history for `ready` (or a loud failure). ---
    // Uses the lightweight `parseStreamEventLine` structural check (see its
    // doc comment) rather than full valibot schema validation.
    const readEvents = async (): Promise<Array<{ type: string } & Record<string, unknown>>> => {
      const hist = await ctx!.sessionManager.getWorkerOutputHistory(sessionId!, workerId!);
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      if (hist) {
        for (const line of hist.data.split('\n')) {
          if (line.trim() === '') continue;
          const parsed = parseStreamEventLine(line);
          if (parsed) events.push(parsed as { type: string } & Record<string, unknown>);
        }
      }
      return events;
    };

    console.log('==> waiting for `ready` (init handshake incl. real MCP listTools() call)');
    const deadline = Date.now() + 30_000;
    let sawReady = false;
    let lastEvents: Array<{ type: string } & Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const events = await readEvents();
      lastEvents = events;
      const fatal = events.find((e) => e.type === 'fatal');
      if (fatal) {
        console.error(`PROBE FAILED: loop emitted a fatal event: ${String(fatal.message)}`);
        break;
      }
      const turnErr = events.find((e) => e.type === 'turn-error');
      if (turnErr) {
        console.error(`PROBE FAILED: loop emitted a turn-error event: ${String(turnErr.message)}`);
        break;
      }
      if (events.some((e) => e.type === 'ready')) {
        sawReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!sawReady) {
      console.error(
        'PROBE FAILED: did not reach `ready` within 30s -- this could mean elevation failed,' +
          ` the MCP handshake failed under AGENT_CONSOLE_MCP_AUTH=${authMode}, or the loop crashed. Observed event types: ` +
          JSON.stringify(lastEvents.map((e) => e.type)),
      );
      const internalWorkerForStderr = ctx.sessionManager.getWorker(sessionId, workerId);
      if (internalWorkerForStderr?.type === 'embedded-agent' && internalWorkerForStderr.subprocess) {
        console.error(`  subprocess pid: ${internalWorkerForStderr.subprocess.pid}`);
      }
    }
    expect(
      sawReady,
      `reached \`ready\` (init handshake incl. real MCP call under AGENT_CONSOLE_MCP_AUTH=${authMode}, set explicitly by --auth-mode)`,
    );

    // --- Real bearer token hit the real /mcp endpoint (mirrors the E2E test's assertion). ---
    expect(capturedMcpAuth.length > 0, 'the init-minted MCP bearer token hit the real /mcp endpoint');
    let capturedToken: string | undefined;
    if (capturedMcpAuth.length > 0) {
      const match = /^Bearer\s+([0-9a-f]{64})$/.exec(capturedMcpAuth[0]);
      expect(match !== null, 'captured Authorization header has the expected Bearer <64-hex> shape', capturedMcpAuth[0]);
      capturedToken = match?.[1];
    }

    // --- The `/mcp` gate, read back from the running instance by its
    // observable behaviour (Issue #1738). Everything above proves the
    // worker's token REACHED /mcp; nothing above proves the token is what
    // ADMITS a call, because a warn-mode gate admits a tokenless call too
    // and the handshake looks identical from the loop's side. So, against
    // the REAL Hono app on its REAL port (not `app.fetch` in-process -- the
    // same TCP path the loop itself used), the same JSON-RPC `tools/call`
    // of `list_sessions` (a tool that claims no session, so the transport
    // gate is the ONLY thing that can refuse it) is sent twice:
    //
    //   E1  tokenless   -- enforce: HTTP 401 + the gate's exact refusal text
    //                      warn:    HTTP 200 + a result, AND the gate's exact
    //                               warn line was logged (string equality
    //                               on the recorded `rootLogger.warn` calls)
    //   E2  Bearer <the token captured in capturedMcpAuth[0]>
    //                   -- both arms: HTTP 200 + a JSON-RPC result (not an
    //                      error object) -- the token is what admits E2
    //                      under enforce, where E1 was refused a moment
    //                      earlier on the SAME endpoint.
    //
    // The two arms are one apparatus with inverted expectations on E1: the
    // enforce arm run with the warn arm's assertion set FAILS (401 !== 200,
    // no warn line recorded) and vice versa (200 !== 401), which is the
    // polarity -- measured by running BOTH arms in the tier-2 container
    // (PR body). The enforce arm ALSO asserts that no warn line was recorded
    // at all: that is the negative control on the logger instrument itself,
    // proving a `recordedWarnLines` hit in the warn arm is the gate's, not
    // ambient noise the instrument would have captured in either mode.
    //
    // This is also why no mode-echo endpoint exists: the mode is what the
    // gate DOES to a tokenless call, and reading that back is stronger than
    // reading back a string the process was configured with.
    //
    // Ordering: after `ready` (the token exists only once the loop's init
    // handshake minted and used it -- E2 needs the captured header) and
    // before teardown (the token is revoked at deactivation, so E2 after
    // the `finally` block would be measuring revocation, not admission).
    console.log(`==> /mcp gate read-back (E1 tokenless, E2 own token) under AGENT_CONSOLE_MCP_AUTH=${authMode}`);
    const gateCall = async (
      authorizationHeader: string | undefined,
    ): Promise<{ status: number; body: unknown; text: string }> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (authorizationHeader !== undefined) headers.Authorization = authorizationHeader;
      const res = await fetch(mcpBaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'list_sessions', arguments: {} },
          id: 1,
        }),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: res.status, body, text };
    };
    const hasJsonRpcResult = (body: unknown): boolean =>
      typeof body === 'object' &&
      body !== null &&
      'result' in body &&
      !('error' in body) &&
      typeof (body as { result: unknown }).result === 'object';
    const errorTextOf = (body: unknown): string | undefined =>
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : undefined;

    const warnLinesBeforeE1 = recordedWarnLines.filter((l) => l === WARN_LOG_LINE).length;
    const e1 = await gateCall(undefined);
    const warnLinesAfterE1 = recordedWarnLines.filter((l) => l === WARN_LOG_LINE).length;
    console.log(`  E1 tokenless tools/call list_sessions -> HTTP ${e1.status} ${e1.text.slice(0, 200)}`);
    console.log(`  gate warn lines recorded (exact text): before E1=${warnLinesBeforeE1}, after E1=${warnLinesAfterE1}`);
    if (authMode === 'enforce') {
      expect(e1.status === 401, 'E1 (enforce): tokenless /mcp call is refused with HTTP 401', `got HTTP ${e1.status}`);
      expect(
        errorTextOf(e1.body) === ENFORCE_REFUSAL_TEXT,
        'E1 (enforce): refusal body carries the gate\'s exact enforce message',
        `got ${e1.text.slice(0, 300)}`,
      );
      expect(
        warnLinesAfterE1 === 0,
        'E1 (enforce): the gate\'s warn line was NOT logged (negative control on the logger instrument)',
        `recorded ${warnLinesAfterE1} exact-match warn line(s)`,
      );
    } else {
      expect(e1.status === 200, 'E1 (warn): tokenless /mcp call is ACCEPTED with HTTP 200', `got HTTP ${e1.status}`);
      expect(hasJsonRpcResult(e1.body), 'E1 (warn): accepted call returned a JSON-RPC result', e1.text.slice(0, 300));
      expect(
        warnLinesAfterE1 === warnLinesBeforeE1 + 1,
        'E1 (warn): exactly one gate warn line with the exact text was logged for the tokenless call',
        `before=${warnLinesBeforeE1} after=${warnLinesAfterE1}; all recorded warn lines: ${JSON.stringify(recordedWarnLines)}`,
      );
    }

    if (capturedToken === undefined) {
      expect(false, 'E2: own-token /mcp call actually ran', 'no captured token to present');
    } else {
      const e2 = await gateCall(`Bearer ${capturedToken}`);
      console.log(`  E2 own-token tools/call list_sessions -> HTTP ${e2.status} ${e2.text.slice(0, 200)}`);
      expect(e2.status === 200, `E2 (${authMode}): the worker's own bearer token admits the same call (HTTP 200)`, `got HTTP ${e2.status}`);
      expect(hasJsonRpcResult(e2.body), `E2 (${authMode}): admitted call returned a JSON-RPC result, not an error`, e2.text.slice(0, 300));
    }

    // --- Negative secret assertions against the REAL /proc of the elevated subprocess. ---
    console.log('==> /proc negative secret assertions (cmdline + environ)');
    if (process.platform !== 'linux') {
      console.warn('  WARN  not running on Linux -- /proc assertions gracefully skipped (did NOT run)');
    } else {
      const internalWorker = ctx.sessionManager.getWorker(sessionId, workerId);
      const pid =
        internalWorker && internalWorker.type === 'embedded-agent'
          ? internalWorker.subprocess?.pid
          : undefined;
      expect(pid !== undefined, 'subprocess pid is known while activated');

      // --- Positive assertion, closing the "bundle-sibling branch is
      // structurally out of reach" gap documented in this file's header
      // comment: when EMBEDDED_AGENT_ENTRY_PATH is configured, the SAME
      // real elevated subprocess whose activation JUST reached `ready`
      // above (`expect(sawReady, ...)`, same run, same pid, no separate
      // re-activation) must have been spawned with that configured path as
      // its argv, not resolveEmbeddedAgentEntryPath()'s own 'package'-branch
      // result from Assertion 1. This is deliberately NOT a standalone
      // string-plumbing check: pairing it with `sawReady` in the same run
      // proves the elevated target user both RECEIVED the configured path
      // AND actually executed it all the way to a working init handshake --
      // a cmdline match alone would still pass even if the elevated user
      // could not read the file at all (the exact failure this fix exists
      // for), since spawnAsUser's argv is set before the OS ever attempts to
      // open the file. Skipped (not failed) when EMBEDDED_AGENT_ENTRY_PATH is
      // unset -- see the header comment's "closing the bundle-sibling gap"
      // section for how to opt in.
      if (configuredEntryPath && earlyEntryPathCmdline !== undefined) {
        expect(
          earlyEntryPathCmdline.ran,
          'EMBEDDED_AGENT_ENTRY_PATH short-circuit /proc/<pid>/cmdline check actually ran (not silently skipped)',
        );
        expect(
          earlyEntryPathCmdline.content.includes(configuredEntryPath),
          'the real elevated subprocess was spawned with the configured EMBEDDED_AGENT_ENTRY_PATH as its argv (short-circuit reached the actual spawn)',
          `configured='${configuredEntryPath}'; resolver's own package-branch path was '${resolution.path}' (must NOT be what was actually spawned when the short-circuit works); captured cmdline='${earlyEntryPathCmdline.content}'`,
        );
      } else if (configuredEntryPath) {
        expect(false, 'EMBEDDED_AGENT_ENTRY_PATH short-circuit /proc/<pid>/cmdline check actually ran (not silently skipped)', 'pid unknown at spawn time');
      } else {
        console.log(
          '  skipped: EMBEDDED_AGENT_ENTRY_PATH unset -- no configured short-circuit path to verify against argv.',
        );
      }

      const secrets: Array<{ label: string; value: string | undefined }> = [
        { label: 'MCP bearer token', value: capturedToken },
        { label: 'provider API key', value: fakeApiKey },
      ];

      for (const secret of secrets) {
        if (secret.value === undefined) {
          expect(false, `${secret.label} negative /proc check actually ran`, 'no captured value to check against');
          continue;
        }
        let procAssertionRan = false;
        let leaked = false;
        if (pid !== undefined) {
          for (const procFile of ['cmdline', 'environ']) {
            const file = Bun.file(`/proc/${pid}/${procFile}`);
            if (await file.exists()) {
              const content = await file.text().catch(() => null);
              if (content !== null) {
                procAssertionRan = true;
                if (content.includes(secret.value)) leaked = true;
              }
            }
          }
        }
        // A silently-skipped check (process already exited, unknown pid,
        // unreadable /proc) is a FAILURE, not a pass -- distinct from the
        // Linux-only graceful skip above.
        expect(
          procAssertionRan,
          `${secret.label} negative /proc check actually ran (not silently skipped)`,
        );
        expect(!leaked, `${secret.label} does NOT appear in /proc/${pid}/cmdline or /environ`);
      }

      // --- Issue #1694 POSITIVE identity assertion: some live process in
      // the elevated tree carries the EXACT NUL-delimited record
      // `AGENT_CONSOLE_SESSION_ID=<activated sessionId>` in its
      // /proc/<pid>/environ -- the same fixed-string whole-record match
      // (`grep -Fxz`) the orphan-process sweep uses
      // (`orphan-process-sweeper.ts`'s `buildSweepScript`), so a pass here
      // is also the proof that the embedded loop tree is now in that
      // sweep's population (C6). Scanned AS THE TARGET USER through the real
      // `runAsUser` (elevated when the target is a second OS user; the
      // bypass branch when degenerate) because `/proc/<pid>/environ` of
      // another user's process is EACCES for the server process -- the
      // negative secret checks above read the outer wrapper pid's environ,
      // which is the SERVER's environment on the elevated branch and
      // therefore can never carry the injected identity; only the inner
      // login shell and the loop it execs do. The scan script is the
      // sweeper's scan phase without the kill: single-line `sh -s` command,
      // multi-line script over stdin (`.claude/rules/elevation-helpers.md`,
      // "Multi-line elevated commands").
      //
      // Negative control in the same run: a marker for a session id that
      // was never activated must match ZERO processes, so the positive
      // result above is attributable to this activation and not to a
      // scanner that matches everything (workflow.md sub-pattern 9).
      //
      // Polarity, measured in the tier-2 container (PR #1694's body): on
      // main before the fix the positive half FAILS (no process carries
      // the record -- the loop inherited nothing on the elevated branch);
      // with the fix it passes.
      console.log('==> /proc positive identity assertion (AGENT_CONSOLE_SESSION_ID record, scanned as the target user)');
      const scanScript = (marker: string): string =>
        [
          'set -u',
          `marker=${shellEscape(marker)}`,
          'matches=0',
          'for envfile in /proc/[0-9]*/environ; do',
          '  [ -e "$envfile" ] || continue',
          '  if grep -Fxzq -- "$marker" "$envfile" 2>/dev/null; then',
          '    matches=$((matches + 1))',
          '  fi',
          'done',
          'echo "MATCHES=$matches"',
          '',
        ].join('\n');
      const countMatches = async (marker: string): Promise<number | undefined> => {
        const result = await runAsUser({
          username: targetUsername,
          command: 'sh -s',
          stdin: scanScript(marker),
          cwd: '/',
          timeoutMs: 30_000,
        });
        const m = /^MATCHES=(\d+)\s*$/m.exec(result.stdout);
        if (result.exitCode !== 0 || result.timedOut || m === null) {
          console.error(
            `  scan as ${targetUsername} did not produce a MATCHES line: exit=${result.exitCode} timedOut=${result.timedOut} stderr=${result.stderr.slice(0, 500)}`,
          );
          return undefined;
        }
        return Number(m[1]);
      };
      const identityMatches = await countMatches(`AGENT_CONSOLE_SESSION_ID=${sessionId}`);
      const controlMatches = await countMatches(`AGENT_CONSOLE_SESSION_ID=${crypto.randomUUID()}`);
      expect(identityMatches !== undefined, 'the /proc environ scan as the target user actually ran (identity marker)');
      expect(controlMatches !== undefined, 'the /proc environ scan as the target user actually ran (never-activated control marker)');
      expect(
        controlMatches === 0,
        'negative control: a never-activated session id matches no process',
        `matches=${controlMatches}`,
      );
      expect(
        identityMatches !== undefined && identityMatches >= 1,
        `a live process in the elevated tree carries the exact record AGENT_CONSOLE_SESSION_ID=${sessionId} (sweeper match semantics)`,
        `matches=${identityMatches}`,
      );
    }
  } catch (err) {
    if (err instanceof SmokeSetupError) {
      console.error('PROBE FAILED: smoke could not run to completion (setup/launch failure)');
      console.error(err.stack ?? err.message);
      process.exitCode = 2;
    } else {
      console.error('PROBE ERROR:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      failures.push('unexpected exception during smoke run');
    }
  } finally {
    console.log('==> cleanup');
    // Restore the umask createDisposableMultiUserHome() changed, first --
    // it was applied unconditionally (regardless of ok/false) the moment
    // that call returned, so nothing else in this block should run under
    // the smoke's own 0o002 override.
    if (prevUmask !== undefined) {
      process.umask(prevUmask);
    }
    if (ctx && sessionId && workerId) {
      try {
        await ctx.sessionManager.deactivateEmbeddedAgentWorker(sessionId, workerId);
      } catch (err) {
        console.warn('  cleanup: deactivate failed (best-effort):', err);
      }
    }
    if (ctx) {
      try {
        await shutdownAppContext(ctx);
      } catch (err) {
        console.warn('  cleanup: shutdownAppContext failed (best-effort):', err);
      }
    }
    try {
      appServer?.stop(true);
    } catch {
      // best-effort
    }
    try {
      stubServer?.stop(true);
    } catch {
      // best-effort
    }
    if (realCwd) {
      Bun.spawnSync(['rm', '-rf', realCwd]);
    }
    if (realConfigDir) {
      Bun.spawnSync(['rm', '-rf', realConfigDir]);
    }
  }

  console.log();
  if (process.exitCode === 2) {
    // Setup/launch failure was already logged above; finally-block cleanup
    // has already run (normal try/catch/finally ordering) by the time we
    // reach this point.
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  process.exit(0);
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    console.error('PROBE FAILED (uncaught):', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
}
