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
 * Splits a resolved (absolute) path into the list of its ancestor
 * directories, from the immediate parent up to and including `/`. Pure
 * string manipulation -- no filesystem access.
 *
 * e.g. `/home/agentconsole/.bun/bin/bun` ->
 *   `['/home/agentconsole/.bun/bin', '/home/agentconsole/.bun', '/home/agentconsole', '/home', '/']`
 */
export function ancestorDirsOf(resolvedPath: string): string[] {
  const segments = resolvedPath.split('/').filter((segment) => segment.length > 0);
  // Drop the last segment (the file itself); what remains are the parent
  // directory's own path segments.
  segments.pop();
  const dirs: string[] = [];
  for (let i = segments.length; i >= 0; i--) {
    dirs.push(`/${segments.slice(0, i).join('/')}`);
  }
  return dirs;
}

/**
 * `true`      -- the configured path is reachable AND executable by users
 *   other than its owner: every ancestor directory has its other-execute
 *   (traverse) bit set, and the file itself has its other-execute bit set.
 * `'unknown'` -- the configured value is a bare name, or `io.realpath` /
 *   `io.stat` failed for the file or any ancestor directory (e.g. ENOENT,
 *   EACCES).
 * an object -- reachability is blocked at a specific point in the path
 *   (`blockedAt`), either an ancestor `directory` whose traverse bit is
 *   unset, or the `file` itself whose execute bit is unset.
 */
export type OtherExecutableResult =
  | true
  | 'unknown'
  | { executable: false; blockedAt: string; kind: 'file' | 'directory'; mode: number };

/**
 * Checks whether the configured `EMBEDDED_AGENT_BUN_PATH` is REACHABLE by
 * users other than its owner -- a proxy for "can an elevation-target user
 * other than whichever account owns this file actually get to it". A file's
 * own mode bits are necessary but not sufficient: every ancestor directory
 * in the resolved path must also have its other-execute (traverse) bit set,
 * or a non-owner is blocked from even reaching the file (e.g. a world
 * -executable file sitting inside a `0750` home directory).
 *
 * A bare command name is `'unknown'` WITHOUT calling `io.realpath` or
 * `io.stat`, for the same reason `compareBinaryIdentity` skips
 * `io.realpath` on a bare name: there is no single meaningful file to stat
 * until PATH resolution happens inside the target user's own shell.
 */
export async function isOtherExecutable(
  configured: string,
  io: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ mode: number }> },
): Promise<OtherExecutableResult> {
  if (!configured.startsWith('/')) {
    return 'unknown';
  }
  let resolved: string;
  try {
    resolved = await io.realpath(configured);
  } catch {
    return 'unknown';
  }

  // Walk from the file's immediate parent out to `/`; the FIRST ancestor
  // whose traverse bit is unset is the one that actually blocks
  // reachability, so stop there rather than continuing to walk further out.
  for (const dir of ancestorDirsOf(resolved)) {
    let dirStat: { mode: number };
    try {
      dirStat = await io.stat(dir);
    } catch {
      return 'unknown';
    }
    if ((dirStat.mode & 0o001) === 0) {
      // Mask to plain permission bits (with setuid/setgid/sticky preserved):
      // a real `fs.Stats.mode` also carries the file-type bits (`S_IFDIR` /
      // `S_IFREG` / etc, e.g. `0o040750` for a directory whose permission
      // bits are `0o750`), which are not part of what an operator-facing
      // "mode NNNN" message should ever display. Masking here, at the
      // source, means every caller of this function's `mode` field gets
      // plain permission bits for free -- no formatter has to remember to
      // strip them itself.
      return { executable: false, blockedAt: dir, kind: 'directory', mode: dirStat.mode & 0o7777 };
    }
  }

  let fileStat: { mode: number };
  try {
    fileStat = await io.stat(resolved);
  } catch {
    return 'unknown';
  }
  if ((fileStat.mode & 0o001) === 0) {
    return { executable: false, blockedAt: resolved, kind: 'file', mode: fileStat.mode & 0o7777 };
  }
  return true;
}

export interface AssessEmbeddedAgentBunPathParams {
  configured: string;
  selfExe: string;
  io: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ mode: number }> };
}

export interface AssessEmbeddedAgentBunPathResult {
  identity: BinaryIdentity;
  otherExecutable: OtherExecutableResult;
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
 *   - same identity      + other-executable true                 -> 0 warnings (happy path)
 *   - different identity + other-executable true                 -> 1 warning
 *   - same identity      + other-executable blocked (file)        -> 1 warning
 *   - different identity + other-executable blocked (file)        -> 2 warnings
 *   - same/different identity + other-executable blocked (dir)    -> 1 or 2 warnings, same shape as the file case
 *   - bare name (unresolvable identity, unknown other-executable) -> 1 warning
 *   - absolute path that could not be read at all (identity
 *     unresolvable or other-executable unknown, NOT a bare name)  -> 1 warning (short-circuits the branches above --
 *     nothing else is determinable when the path itself couldn't be read)
 */
export async function assessEmbeddedAgentBunPath(
  params: AssessEmbeddedAgentBunPathParams,
): Promise<AssessEmbeddedAgentBunPathResult> {
  const { configured, selfExe, io } = params;
  const identity = await compareBinaryIdentity(selfExe, configured, io);
  const otherExecutable = await isOtherExecutable(configured, io);

  const isBareName = !configured.startsWith('/');

  // The path itself (or one of its ancestors) could not be read at all --
  // distinct from "readable, but wrong" (the branches below). Nothing else
  // is determinable in this state, so short-circuit with a single warning
  // that surfaces the actual OS error code rather than silently returning
  // no warning at all (the #1291-follow-up EACCES-on-ancestor case).
  if (!isBareName && (identity === 'unresolvable' || otherExecutable === 'unknown')) {
    // Deliberate, cheap, second read purely to extract a `.code` for the
    // message -- the original error is never threaded through
    // compareBinaryIdentity's / isOtherExecutable's return values. Walks the
    // same ancestor chain isOtherExecutable does (rather than only
    // re-statting the resolved file) so the error surfaced here actually
    // matches WHICH read failed -- an EACCES on a containing directory
    // (the motivating case for this whole widening) throws inside the
    // ancestor loop, not at the final file stat, and a re-probe scoped to
    // only the resolved file would silently under-report it as 'UNKNOWN'.
    let errorCode = 'UNKNOWN';
    try {
      const resolved = await io.realpath(configured);
      for (const dir of ancestorDirsOf(resolved)) {
        await io.stat(dir);
      }
      await io.stat(resolved);
    } catch (err) {
      errorCode = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    }
    return {
      identity,
      otherExecutable,
      warnings: [
        `Could not read EMBEDDED_AGENT_BUN_PATH '${configured}': ${errorCode}; verify the path (and every ` +
          'containing directory) is reachable by every elevation-target user.',
      ],
    };
  }

  const warnings: string[] = [];

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

  if (typeof otherExecutable === 'object' && otherExecutable.executable === false) {
    const modeOctal = otherExecutable.mode.toString(8).padStart(4, '0');
    if (otherExecutable.kind === 'directory') {
      warnings.push(
        `EMBEDDED_AGENT_BUN_PATH is configured to '${configured}', but directory ${otherExecutable.blockedAt} ` +
          `(mode ${modeOctal}) is not traversable by other users -- an elevated activation for a user other than ` +
          `this directory's owner will fail with EACCES. ${SETUP_SCRIPT_FIX}, or fix the directory's ` +
          'permissions/location.',
      );
    } else {
      warnings.push(
        `EMBEDDED_AGENT_BUN_PATH is configured to '${configured}' (mode ${modeOctal}), which is not executable ` +
          `by other users -- an elevated activation for a user other than this file's owner will fail with ` +
          `EACCES. ${SETUP_SCRIPT_FIX}, or fix the file's permissions/location.`,
      );
    }
  }

  return { identity, otherExecutable, warnings };
}
