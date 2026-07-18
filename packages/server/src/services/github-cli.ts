/**
 * Thin runner for `gh` CLI invocations.
 *
 * Composes `runAsUser` + the gh-specific argv shape (`['gh', ...args].map(shellEscape).join(' ')`)
 * + the gh-error semantics (throw on non-zero exit / timeout). Lives in
 * `services/github-cli.ts` rather than `privilege-elevation.ts` because it
 * adds a semantic layer (throw on failure) on top of the elevation primitive;
 * per `.claude/rules/elevation-helpers.md` the elevation-primitive layer
 * remains strict (returns underlying `RunAsUserResult` unchanged) and
 * domain-level runners that add caller semantics live at the consumer layer.
 *
 * `fetchPullRequestUrl`'s swallow-to-null behavior is the caller's semantics,
 * NOT the runner's: that function wraps `runGh` in `try { ... } catch { return null; }`.
 * Do NOT add a null-swallow variant here — strict-thin-wrapper composes
 * better than semantic helpers.
 */
import { runAsUser, shellEscape } from './privilege-elevation.js';

const DEFAULT_GH_TIMEOUT_MS = 5000;

export interface RunGhOpts {
  cwd?: string;
  requestUsername: string | null;
  timeoutMs?: number;
  /**
   * Subcommand label used in error messages. Defaults to `args[0] ?? 'gh'`.
   * Pass an explicit override when the first arg is not human-readable
   * (e.g. `args = ['api', 'repos/...']` → use `subcommand: 'api'`).
   */
  subcommand?: string;
  /**
   * Test-seam DI per `.claude/rules/elevation-helpers.md` "Test-correctness
   * DI is orthogonal to strict semantics". Production callers ignore this;
   * tests inject a captured-call fake to assert argv/opts shape without
   * spawning real `sh -c`.
   */
  runAsUserImpl?: typeof runAsUser;
}

/**
 * Run a `gh` CLI invocation, optionally elevated to `opts.requestUsername`.
 *
 * Strict semantics:
 * - On timeout: throws `Error('gh <subcommand> timed out after <ms>ms')`.
 * - On non-zero exit: throws `Error(stderr.trim() || 'gh <subcommand> failed')`.
 * - On success: returns stdout unchanged (no trim, no parse).
 *
 * Does NOT swallow errors — callers that want null-on-error wrap in try/catch
 * (see `github-pr-service.ts:fetchPullRequestUrl`). This keeps the runner's
 * contract aligned with the strict-thin-wrapper rule
 * (`.claude/rules/elevation-helpers.md`): `runGh` composes `runAsUser` + the
 * gh-specific argv shape + the gh-error semantics, and stops there.
 *
 * In multi-user mode (`AUTH_MODE=multi-user`) the spawn elevates to
 * `opts.requestUsername` via the underlying `runAsUser`, so `gh` runs under
 * that user's per-user gh auth token. `null` / `undefined` / matches-server-user
 * bypasses elevation (the runner inherits this contract from `runAsUser`).
 */
export async function runGh(args: string[], opts: RunGhOpts): Promise<string> {
  const impl = opts.runAsUserImpl ?? runAsUser;
  const sub = opts.subcommand ?? args[0] ?? 'gh';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const command = ['gh', ...args].map(shellEscape).join(' ');
  const result = await impl({
    username: opts.requestUsername,
    command,
    cwd: opts.cwd,
    timeoutMs,
  });
  if (result.timedOut) {
    throw new Error(`gh ${sub} timed out after ${timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `gh ${sub} failed`);
  }
  return result.stdout;
}
