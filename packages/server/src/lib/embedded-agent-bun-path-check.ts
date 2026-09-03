/**
 * Pure, dependency-injected assessment of `EMBEDDED_AGENT_BUN_PATH` against
 * the running server's own binary. No filesystem access at import time, no
 * side effects -- every filesystem operation is passed in via `io` so this
 * module is testable without touching a real disk and reusable from both the
 * boot-time WARN (`packages/server/src/index.ts`) and the multi-user
 * elevation smoke (`scripts/smoke/check-embedded-agent-elevation.ts`), which
 * is the single writer for both call sites.
 */

/**
 * `'same'`      -- both paths resolve (via realpath) to the identical file.
 * `'different'` -- both paths resolve, but to different files.
 * `'unresolvable'` -- the configured value is a bare name (not absolute), or
 *   either side could not be resolved (e.g. ENOENT).
 */
export type BinaryIdentity = 'same' | 'different' | 'unresolvable';

/**
 * Compares the server's own running binary (`selfExe`) against the
 * configured `EMBEDDED_AGENT_BUN_PATH` value (`configured`) by resolving
 * both through `io.realpath` and comparing the resolved strings.
 *
 * A bare command name (e.g. `'bun'`, the single-user/dev default's PATH-only
 * form when `process.execPath` itself is unavailable, or a hand-set
 * override) is `'unresolvable'` WITHOUT ever calling `io.realpath` -- a bare
 * name resolves differently per elevation-target user's login shell PATH
 * (the #1221 class), so there is nothing this process's realpath call could
 * meaningfully resolve it to.
 */
export async function compareBinaryIdentity(
  selfExe: string,
  configured: string,
  io: { realpath(p: string): Promise<string> },
): Promise<BinaryIdentity> {
  if (!configured.startsWith('/')) {
    return 'unresolvable';
  }
  let selfResolved: string;
  let configuredResolved: string;
  try {
    selfResolved = await io.realpath(selfExe);
    configuredResolved = await io.realpath(configured);
  } catch {
    return 'unresolvable';
  }
  return selfResolved === configuredResolved ? 'same' : 'different';
}

/**
 * `true`  -- the configured path is executable by users other than its owner.
 * `false` -- it is not.
 * `'unknown'` -- the configured value is a bare name, or `io.stat` failed
 *   (e.g. ENOENT).
 */
export type OtherExecutable = boolean | 'unknown';

/**
 * Checks whether the configured `EMBEDDED_AGENT_BUN_PATH` is executable by
 * users other than its owner -- a proxy for "is this file reachable by an
 * elevation-target user other than whichever account owns it". A bare
 * command name is `'unknown'` WITHOUT calling `io.stat`, for the same reason
 * `compareBinaryIdentity` skips `io.realpath` on a bare name: there is no
 * single meaningful file to stat until PATH resolution happens inside the
 * target user's own shell.
 */
export async function isOtherExecutable(
  configured: string,
  io: { stat(p: string): Promise<{ mode: number }> },
): Promise<OtherExecutable> {
  if (!configured.startsWith('/')) {
    return 'unknown';
  }
  let stats: { mode: number };
  try {
    stats = await io.stat(configured);
  } catch {
    return 'unknown';
  }
  return (stats.mode & 0o001) !== 0;
}

export interface AssessEmbeddedAgentBunPathParams {
  configured: string;
  selfExe: string;
  io: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ mode: number }> };
}

export interface AssessEmbeddedAgentBunPathResult {
  identity: BinaryIdentity;
  otherExecutable: OtherExecutable;
  warnings: string[];
}

const SETUP_SCRIPT_FIX = 're-run scripts/setup-multiuser-for-ubuntu.sh';

/**
 * Assesses `EMBEDDED_AGENT_BUN_PATH` (`configured`) against the server's own
 * running binary (`selfExe`) and produces operator-facing warning strings
 * for anything that looks wrong. Never throws; a warning is the strongest
 * signal this function ever produces.
 *
 * Warning-count table (see `.claude/rules/test-trigger.md`'s "Idle Eviction"
 * siblings for the shape this pattern follows -- exhaustive branch coverage
 * pinned in the sibling test file):
 *   - same identity      + other-executable true    -> 0 warnings (happy path)
 *   - different identity + other-executable true     -> 1 warning
 *   - same identity      + other-executable false    -> 1 warning
 *   - different identity + other-executable false     -> 2 warnings
 *   - bare name (unresolvable identity, unknown other-executable) -> 1 warning
 */
export async function assessEmbeddedAgentBunPath(
  params: AssessEmbeddedAgentBunPathParams,
): Promise<AssessEmbeddedAgentBunPathResult> {
  const { configured, selfExe, io } = params;
  const identity = await compareBinaryIdentity(selfExe, configured, io);
  const otherExecutable = await isOtherExecutable(configured, io);

  const warnings: string[] = [];
  const isBareName = !configured.startsWith('/');

  if (identity === 'different') {
    warnings.push(
      `EMBEDDED_AGENT_BUN_PATH is configured to '${configured}', which is a different binary than the ` +
        `server's own executable ('${selfExe}'). An embedded-agent worker spawned via elevation would run a ` +
        `different bun than the server itself -- ${SETUP_SCRIPT_FIX}, or set Environment=EMBEDDED_AGENT_BUN_PATH= ` +
        'in the unit to the same binary the server itself runs.',
    );
  } else if (identity === 'unresolvable' && isBareName) {
    warnings.push(
      `EMBEDDED_AGENT_BUN_PATH is set to the bare name '${configured}', which resolves via each target user's ` +
        'login PATH inside the elevated shell rather than to a fixed file (#1221 class) -- set it to an absolute ' +
        `path reachable by every elevation target user; ${SETUP_SCRIPT_FIX}.`,
    );
  }

  if (otherExecutable === false) {
    warnings.push(
      `EMBEDDED_AGENT_BUN_PATH is configured to '${configured}', which is not executable by other users -- an ` +
        `elevated activation for a user other than this file's owner will fail with EACCES. ${SETUP_SCRIPT_FIX}, ` +
        "or fix the file's permissions/location.",
    );
  }

  return { identity, otherExecutable, warnings };
}
