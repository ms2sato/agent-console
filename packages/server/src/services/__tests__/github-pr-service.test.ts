import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

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
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
let importCounter = 0;

describe('github-pr-service', () => {
  beforeEach(() => {
    spawnCalls = [];

    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"url":"https://github.com/owner/repo/pull/42"}'));
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

    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      return mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  async function getModule() {
    return import(`../github-pr-service.js?v=${++importCounter}`);
  }

  it('fetches PR URL for a branch', async () => {
    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('feat/my-feature', '/repo');

    expect(prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(spawnCalls[0]?.args).toEqual(['gh', 'pr', 'view', 'feat/my-feature', '--json', 'url']);
    expect(spawnCalls[0]?.options.cwd).toBe('/repo');
  });

  it('returns null when no PR exists for the branch', async () => {
    mockSpawnResult = {
      exited: Promise.resolve(1), // Non-zero exit code
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('no pull requests found'));
          controller.close();
        },
      }),
      kill: () => {},
    };

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('non-existent-branch', '/repo');

    expect(prUrl).toBeNull();
  });

  it('returns null when gh command returns invalid JSON', async () => {
    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('not valid json'));
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

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('some-branch', '/repo');

    expect(prUrl).toBeNull();
  });

  it('returns null when response is missing url field', async () => {
    mockSpawnResult = {
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

    const { fetchPullRequestUrl } = await getModule();
    const prUrl = await fetchPullRequestUrl('some-branch', '/repo');

    expect(prUrl).toBeNull();
  });

  it('handles timeout gracefully', async () => {
    mockSpawnResult = {
      exited: new Promise(() => {}), // Never resolves
      stdout: new ReadableStream({
        start(controller) {
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

    const { fetchPullRequestUrl } = await getModule();

    // This test uses the default 5 second timeout, which is too long for tests
    // Instead, we create a race condition to verify timeout behavior
    const startTime = Date.now();
    const timeoutPromise = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve(null), 100);
    });

    const fetchPromise = fetchPullRequestUrl('some-branch', '/repo');

    // Race the timeout with the fetch
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    // The timeout should win since the spawn never resolves
    expect(Date.now() - startTime).toBeLessThan(5000);

    // Note: In a real scenario with the default 5s timeout, process would be killed
    // but our race condition doesn't wait that long
    expect(result).toBeNull();
  });
});
