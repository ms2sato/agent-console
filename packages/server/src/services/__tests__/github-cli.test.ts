import { describe, it, expect } from 'bun:test';
import type { RunAsUserOpts, RunAsUserResult } from '../privilege-elevation.js';
import { runGh } from '../github-cli.js';

/**
 * Build a captured-call fake `runAsUser` implementation. Tests use this to
 * assert argv / opts shape without spawning a real `sh -c`. See
 * `.claude/rules/elevation-helpers.md` "Test-correctness DI is orthogonal to
 * strict semantics" for the rationale behind exposing `runAsUserImpl` on
 * `runGh`'s opts.
 */
function makeFakeRunAsUser(
  responder: () => Partial<RunAsUserResult>,
): {
  captured: RunAsUserOpts[];
  impl: (opts: RunAsUserOpts) => Promise<RunAsUserResult>;
} {
  const captured: RunAsUserOpts[] = [];
  const impl = async (opts: RunAsUserOpts): Promise<RunAsUserResult> => {
    captured.push(opts);
    const partial = responder();
    return {
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      exitCode: partial.exitCode ?? 0,
      timedOut: partial.timedOut ?? false,
    };
  };
  return { captured, impl };
}

describe('runGh / command shape', () => {
  it("escapes args via shellEscape and joins with the literal 'gh' prefix", async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: 'ok' }));
    // Single-quote-containing arg exercises shellEscape (per owner brief).
    await runGh(['pr', 'view', "feat/o'reilly", '--json', 'url'], {
      cwd: '/repo',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    expect(captured).toHaveLength(1);
    // shellEscape('foo') = "'foo'"; shellEscape("a'b") = "'a'\\''b'".
    expect(captured[0]?.command).toBe(
      "'gh' 'pr' 'view' 'feat/o'\\''reilly' '--json' 'url'",
    );
  });

  it('forwards cwd to runAsUser', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: '{}' }));
    await runGh(['api', 'repos/o/r/issues/1'], {
      cwd: '/some/path',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    expect(captured[0]?.cwd).toBe('/some/path');
  });

  it('forwards requestUsername as runAsUser.username (null passes through unchanged)', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: '{}' }));
    await runGh(['pr', 'list'], {
      cwd: '/repo',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    expect(captured[0]?.username).toBeNull();
  });

  it('forwards a non-null requestUsername unchanged (runner does not short-circuit; runAsUser handles bypass)', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: '{}' }));
    await runGh(['pr', 'list'], {
      cwd: '/repo',
      requestUsername: 'alice',
      runAsUserImpl: impl,
    });
    expect(captured[0]?.username).toBe('alice');
  });
});

describe('runGh / timeoutMs forwarding', () => {
  it('defaults to 5000ms when timeoutMs is omitted', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: '{}' }));
    await runGh(['pr', 'view', 'feat/x', '--json', 'url'], {
      cwd: '/repo',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    expect(captured[0]?.timeoutMs).toBe(5000);
  });

  it('forwards an explicit timeoutMs override as-is', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: '{}' }));
    await runGh(['api', 'repos/o/r/issues/1'], {
      cwd: '/repo',
      requestUsername: null,
      timeoutMs: 15_000,
      runAsUserImpl: impl,
    });
    expect(captured[0]?.timeoutMs).toBe(15_000);
  });
});

describe('runGh / timeout throwing', () => {
  it('throws with default subcommand (args[0]) when timedOut is true', async () => {
    const { impl } = makeFakeRunAsUser(() => ({ timedOut: true }));
    await expect(
      runGh(['pr', 'view', 'feat/x', '--json', 'url'], {
        cwd: '/repo',
        requestUsername: null,
        runAsUserImpl: impl,
      }),
    ).rejects.toThrow('gh pr timed out after 5000ms');
  });

  it('throws with explicit subcommand override on timeout', async () => {
    const { impl } = makeFakeRunAsUser(() => ({ timedOut: true }));
    await expect(
      runGh(['pr', 'list', '--head', 'feat/x'], {
        cwd: '/repo',
        requestUsername: null,
        subcommand: 'pr list',
        timeoutMs: 1234,
        runAsUserImpl: impl,
      }),
    ).rejects.toThrow('gh pr list timed out after 1234ms');
  });
});

describe('runGh / non-zero exit throwing', () => {
  it('throws with stderr.trim() when stderr is non-empty', async () => {
    const { impl } = makeFakeRunAsUser(() => ({
      exitCode: 1,
      stderr: '  gh: command failed  \n',
    }));
    await expect(
      runGh(['pr', 'list'], {
        cwd: '/repo',
        requestUsername: null,
        subcommand: 'pr list',
        runAsUserImpl: impl,
      }),
    ).rejects.toThrow('gh: command failed');
  });

  it('throws with fallback "gh <subcommand> failed" when stderr is empty', async () => {
    const { impl } = makeFakeRunAsUser(() => ({
      exitCode: 1,
      stderr: '',
    }));
    await expect(
      runGh(['api', 'repos/o/r/issues/1'], {
        cwd: '/repo',
        requestUsername: null,
        subcommand: 'api',
        runAsUserImpl: impl,
      }),
    ).rejects.toThrow('gh api failed');
  });

  it('uses args[0] for the fallback subcommand when subcommand is omitted', async () => {
    const { impl } = makeFakeRunAsUser(() => ({
      exitCode: 1,
      stderr: '',
    }));
    await expect(
      runGh(['pr', 'list'], {
        cwd: '/repo',
        requestUsername: null,
        runAsUserImpl: impl,
      }),
    ).rejects.toThrow('gh pr failed');
  });
});

describe('runGh / stdout passthrough', () => {
  it('returns stdout unchanged on success (no trim, no parse)', async () => {
    const { impl } = makeFakeRunAsUser(() => ({
      stdout: '  {"url":"https://github.com/o/r/pull/1"}\n',
    }));
    const result = await runGh(['pr', 'view', 'feat/x', '--json', 'url'], {
      cwd: '/repo',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    expect(result).toBe('  {"url":"https://github.com/o/r/pull/1"}\n');
  });
});

describe('runGh / DI substitution', () => {
  it('routes through opts.runAsUserImpl instead of the module-level default when provided', async () => {
    const { captured, impl } = makeFakeRunAsUser(() => ({ stdout: 'from-fake' }));
    const result = await runGh(['pr', 'view', 'feat/x'], {
      cwd: '/repo',
      requestUsername: null,
      runAsUserImpl: impl,
    });
    // If the runner had ignored the injected impl and called the real
    // module-level `runAsUser`, the fake would not capture the call AND the
    // real `runAsUser` would spawn `sh -c 'gh pr view feat/x'` against the
    // host. The captured-call assertion proves the DI seam is honoured.
    expect(captured).toHaveLength(1);
    expect(result).toBe('from-fake');
  });
});
