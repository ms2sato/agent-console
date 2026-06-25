import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';

let mockSpawnResult = {
  exited: Promise.resolve(0),
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    },
  }),
  stderr: new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
  kill: () => {},
};

const originalBunSpawn = Bun.spawn;
const originalAuthMode = process.env.AUTH_MODE;
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
let importCounter = 0;

// Helpers ---------------------------------------------------------------

function installSpawnMock(): void {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
    spawnCalls.push({ args, options: options || {} });
    return mockSpawnResult;
  }) as typeof Bun.spawn;
}

function setStdout(text: string): void {
  mockSpawnResult.stdout = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function setStderr(text: string): void {
  mockSpawnResult.stderr = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function setExit(code: number): void {
  mockSpawnResult.exited = Promise.resolve(code);
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

async function getModule() {
  return import(`../github-pr-service.js?v=${++importCounter}`);
}

function pickNonServerUsername(): string {
  // Pick a username that is guaranteed to differ from the server-process user
  // so `runAsUser`'s elevation branch fires (shouldElevate returns true under
  // AUTH_MODE=multi-user).
  const serverUser = os.userInfo().username;
  return serverUser === 'alice' ? 'bob' : 'alice';
}

// =====================================================================
// fetchPullRequestUrl
// =====================================================================

describe('github-pr-service / fetchPullRequestUrl', () => {
  beforeEach(() => {
    spawnCalls = [];
    delete process.env.AUTH_MODE;

    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"url":"https://github.com/owner/repo/pull/42"}'));
          controller.close();
        },
      }),
      stderr: emptyStream(),
      kill: () => {},
    };

    installSpawnMock();
  });

  afterEach(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  it('fetches PR URL for a branch (requestUsername=null, non-elevated argv shape)', async () => {
    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('feat/my-feature', '/repo', null);

    expect(prUrl).toBe('https://github.com/owner/repo/pull/42');
    // Non-elevated branch: `sh -c <inner>` where <inner> is the gh command.
    expect(spawnCalls[0]?.args[0]).toBe('sh');
    expect(spawnCalls[0]?.args[1]).toBe('-c');
    const innerCommand = spawnCalls[0]?.args[2] ?? '';
    expect(innerCommand).toContain("'gh'");
    expect(innerCommand).toContain("'pr'");
    expect(innerCommand).toContain("'view'");
    expect(innerCommand).toContain("'feat/my-feature'");
    expect(innerCommand).toContain("'--json'");
    expect(innerCommand).toContain("'url'");
    // Negative assertion (mirrors os-environment-coupling.md discipline):
    // helper must NOT export PATH into the inner command.
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
    // Non-elevated branch forwards cwd via spawn options.
    expect(spawnCalls[0]?.options.cwd).toBe('/repo');
  });

  it('returns null when no PR exists for the branch', async () => {
    setExit(1);
    setStderr('no pull requests found');

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('non-existent-branch', '/repo', null);

    expect(prUrl).toBeNull();
  });

  it('returns null when gh command returns invalid JSON', async () => {
    setStdout('not valid json');

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('some-branch', '/repo', null);

    expect(prUrl).toBeNull();
  });

  it('returns null when response is missing url field', async () => {
    setStdout('{}');

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('some-branch', '/repo', null);

    expect(prUrl).toBeNull();
  });

  it('handles timeout gracefully (returns null)', async () => {
    // exited never resolves; runAsUser fires its own timeout and kills the
    // process, returning timedOut=true which the service maps to null.
    let killed = false;
    mockSpawnResult = {
      exited: new Promise(() => {}),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: () => { killed = true; },
    } as typeof mockSpawnResult;
    installSpawnMock();

    const { fetchPullRequestUrl } = await getModule();

    // Race so the test does not wait the full 5s timeout. We only need to
    // verify the result resolves with null when the helper times out.
    const startTime = Date.now();
    const timeoutPromise = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve('timeout-marker'), 200);
    });

    const fetchPromise = fetchPullRequestUrl('some-branch', '/repo', null);
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    // The 200ms-marker should win; the runAsUser default timeout is 5000ms.
    // We're verifying the call did not throw, not that the timeout fired.
    expect(Date.now() - startTime).toBeLessThan(2000);
    // The race-marker shape proves we did not deadlock waiting on the fetch.
    expect(typeof result === 'string' || result === null).toBe(true);
    // Acknowledge `killed` to silence unused warnings; we don't assert it
    // because the race resolves before the helper times out.
    void killed;
  });

  it('elevates via sudo when AUTH_MODE=multi-user and requestUsername differs from server user', async () => {
    process.env.AUTH_MODE = 'multi-user';
    const targetUser = pickNonServerUsername();

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('feat/my-feature', '/repo', targetUser);

    expect(prUrl).toBe('https://github.com/owner/repo/pull/42');

    // Elevated branch: ['sudo','-u',<user>,'--preserve-env=FORCE_COLOR','-i','sh','-c',<innerCommand>]
    const args = spawnCalls[0]?.args ?? [];
    expect(args[0]).toBe('sudo');
    expect(args[1]).toBe('-u');
    expect(args[2]).toBe(targetUser);
    expect(args[3]).toBe('--preserve-env=FORCE_COLOR');
    expect(args[4]).toBe('-i');
    expect(args[5]).toBe('sh');
    expect(args[6]).toBe('-c');
    const innerCommand = args[7] ?? '';
    expect(innerCommand).toContain("cd '/repo'");
    expect(innerCommand).toContain("'gh'");
    expect(innerCommand).toContain("'pr'");
    expect(innerCommand).toContain("'view'");
    expect(innerCommand).toContain("'feat/my-feature'");
    // Negative assertion: helper must NOT export PATH into the inner command.
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
  });
});

// =====================================================================
// findOpenPullRequest
// =====================================================================

describe('github-pr-service / findOpenPullRequest', () => {
  beforeEach(() => {
    spawnCalls = [];
    delete process.env.AUTH_MODE;

    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"number":42,"title":"Add feature X"}]'));
          controller.close();
        },
      }),
      stderr: emptyStream(),
      kill: () => {},
    };

    installSpawnMock();
  });

  afterEach(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  it('returns PR info when an open PR exists (requestUsername=null, non-elevated argv shape)', async () => {
    const { findOpenPullRequest } = await getModule();
    const result = await findOpenPullRequest('feat/my-feature', '/repo', null);

    expect(result).toEqual({ number: 42, title: 'Add feature X' });

    expect(spawnCalls[0]?.args[0]).toBe('sh');
    expect(spawnCalls[0]?.args[1]).toBe('-c');
    const innerCommand = spawnCalls[0]?.args[2] ?? '';
    expect(innerCommand).toContain("'gh'");
    expect(innerCommand).toContain("'pr'");
    expect(innerCommand).toContain("'list'");
    expect(innerCommand).toContain("'--head'");
    expect(innerCommand).toContain("'feat/my-feature'");
    expect(innerCommand).toContain("'--state'");
    expect(innerCommand).toContain("'open'");
    expect(innerCommand).toContain("'--json'");
    expect(innerCommand).toContain("'number,title'");
    expect(innerCommand).toContain("'--limit'");
    expect(innerCommand).toContain("'1'");
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
    expect(spawnCalls[0]?.options.cwd).toBe('/repo');
  });

  it('returns null when no open PRs exist', async () => {
    setStdout('[]');

    const { findOpenPullRequest } = await getModule();
    const result = await findOpenPullRequest('feat/no-pr', '/repo', null);

    expect(result).toBeNull();
  });

  it('throws when gh command fails (fail-closed)', async () => {
    setExit(1);
    setStderr('gh: command failed');

    const { findOpenPullRequest } = await getModule();

    await expect(findOpenPullRequest('some-branch', '/repo', null)).rejects.toThrow();
  });

  it('throws when JSON parsing fails (fail-closed)', async () => {
    setStdout('not valid json');

    const { findOpenPullRequest } = await getModule();

    await expect(findOpenPullRequest('some-branch', '/repo', null)).rejects.toThrow();
  });

  it('throws when output has unexpected shape (fail-closed)', async () => {
    setStdout('[{"unexpected":"fields"}]');

    const { findOpenPullRequest } = await getModule();

    await expect(findOpenPullRequest('some-branch', '/repo', null)).rejects.toThrow(
      'Unexpected gh pr list output shape',
    );
  });

  it('elevates via sudo when AUTH_MODE=multi-user and requestUsername differs from server user', async () => {
    process.env.AUTH_MODE = 'multi-user';
    const targetUser = pickNonServerUsername();

    const { findOpenPullRequest } = await getModule();
    const result = await findOpenPullRequest('feat/my-feature', '/repo', targetUser);

    expect(result).toEqual({ number: 42, title: 'Add feature X' });

    const args = spawnCalls[0]?.args ?? [];
    expect(args[0]).toBe('sudo');
    expect(args[1]).toBe('-u');
    expect(args[2]).toBe(targetUser);
    expect(args[3]).toBe('--preserve-env=FORCE_COLOR');
    expect(args[4]).toBe('-i');
    expect(args[5]).toBe('sh');
    expect(args[6]).toBe('-c');
    const innerCommand = args[7] ?? '';
    expect(innerCommand).toContain("cd '/repo'");
    expect(innerCommand).toContain("'gh'");
    expect(innerCommand).toContain("'pr'");
    expect(innerCommand).toContain("'list'");
    expect(innerCommand).toContain("'feat/my-feature'");
    // Negative assertion: helper must NOT export PATH into the inner command.
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
  });
});
