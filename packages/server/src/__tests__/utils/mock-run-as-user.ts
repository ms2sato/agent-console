/**
 * Test helper for mocking `runAsUser` (or any privilege-elevation-aware git
 * runner that produces `'git' '<arg>' '<arg>' ...` shell command strings).
 *
 * Lives alongside `mock-git-helper.ts` but operates at a different layer:
 *   - `mock-git-helper.ts` mocks the `lib/git.ts` module wrappers.
 *   - `mock-run-as-user.ts` mocks the underlying `runAsUser` that
 *     `git-diff-service.ts` routes every git invocation through (Issue #869).
 *
 * Use this in tests that exercise services which have migrated to call
 * `runAsUser` directly with `'git' ...` command strings.
 *
 * Usage:
 * ```ts
 * import { createMockRunAsUser, gitArgsToCommand } from '../../__tests__/utils/mock-run-as-user.js';
 * import { __setRunAsUserForTesting } from '../git-diff-service.js';
 *
 * let gitMock: ReturnType<typeof createMockRunAsUser>;
 *
 * beforeEach(() => {
 *   gitMock = createMockRunAsUser();
 *   __setRunAsUserForTesting(gitMock.fn);
 * });
 *
 * afterEach(() => {
 *   __setRunAsUserForTesting(null);
 * });
 *
 * it('does the thing', async () => {
 *   gitMock.respond(['rev-parse', 'main'], { stdout: 'abc1234\n' });
 *   const result = await resolveRef('main', '/repo', null);
 *   expect(result).toBe('abc1234');
 * });
 * ```
 */

import type { RunAsUserOpts, RunAsUserResult } from '../../services/privilege-elevation.js';

export interface GitMockResponse {
  stdout?: string;
  stderr?: string;
  /** Defaults to 0 (success). */
  exitCode?: number;
  timedOut?: boolean;
}

/**
 * Build the shell command string that `runGit` produces for a set of git
 * args. Mirrors the production formatting:
 *   `'git' '<arg1>' '<arg2>' ...` with single-quote shell escaping.
 */
export function gitArgsToCommand(args: string[]): string {
  return ['git', ...args].map(shellEscape).join(' ');
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface MockRunAsUser {
  /** The fake `runAsUser` implementation; pass to `__setRunAsUserForTesting`. */
  fn: (opts: RunAsUserOpts) => Promise<RunAsUserResult>;
  /**
   * Register a canned response for a specific git-arg invocation. Later calls
   * with the same args resolve with the provided result. Multiple calls to
   * `respond` overwrite earlier ones for the same args.
   */
  respond: (args: string[], response: GitMockResponse) => void;
  /**
   * Set a fallback response for ANY unregistered invocation. Without this,
   * unregistered calls resolve with exitCode 1 and a diagnostic stderr.
   */
  fallback: (response: GitMockResponse) => void;
  /** All recorded calls in order. */
  calls: RunAsUserOpts[];
  /**
   * Find the first call whose command matches the given git args. Returns
   * undefined if no matching call was recorded.
   */
  findCall: (args: string[]) => RunAsUserOpts | undefined;
  /** All calls whose command matches the given git args. */
  findCalls: (args: string[]) => RunAsUserOpts[];
}

export function createMockRunAsUser(): MockRunAsUser {
  const responses = new Map<string, GitMockResponse>();
  const calls: RunAsUserOpts[] = [];
  let fallbackResponse: GitMockResponse | null = null;

  const fn = async (opts: RunAsUserOpts): Promise<RunAsUserResult> => {
    calls.push(opts);
    const resp = responses.get(opts.command)
      ?? fallbackResponse
      ?? { exitCode: 1, stderr: `mock-run-as-user: no canned response for ${opts.command}` };
    return {
      stdout: resp.stdout ?? '',
      stderr: resp.stderr ?? '',
      exitCode: resp.exitCode ?? 0,
      timedOut: resp.timedOut ?? false,
    };
  };

  return {
    fn,
    respond(args, response) {
      responses.set(gitArgsToCommand(args), response);
    },
    fallback(response) {
      fallbackResponse = response;
    },
    calls,
    findCall(args) {
      const command = gitArgsToCommand(args);
      return calls.find((c) => c.command === command);
    },
    findCalls(args) {
      const command = gitArgsToCommand(args);
      return calls.filter((c) => c.command === command);
    },
  };
}
