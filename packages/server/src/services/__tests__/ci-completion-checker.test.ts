import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

const originalBunSpawn = Bun.spawn;
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
let importCounter = 0;

function createReadableStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (content) {
        controller.enqueue(new TextEncoder().encode(content));
      }
      controller.close();
    },
  });
}

function createEmptyStream(): ReadableStream<Uint8Array> {
  return createReadableStream('');
}

let mockSpawnResult: {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
};

function setSpawnResponse(stdout: string, exitCode = 0, stderr = '') {
  mockSpawnResult = {
    exited: Promise.resolve(exitCode),
    stdout: createReadableStream(stdout),
    stderr: createReadableStream(stderr),
    kill: () => {},
  };
}

function makeWorkflowRunsResponse(runs: Array<{
  workflow_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
}>): string {
  return JSON.stringify({
    total_count: runs.length,
    workflow_runs: runs,
  });
}

describe('ci-completion-checker', () => {
  beforeEach(() => {
    spawnCalls = [];
    setSpawnResponse('{}');

    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      return mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  async function getModule() {
    return import(`../inbound/ci-completion-checker.js?v=${++importCounter}`);
  }

  it('returns allCompleted true when all workflows completed successfully', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'lint', status: 'completed', conclusion: 'success', run_number: 1 },
      { workflow_id: 2, name: 'test', status: 'completed', conclusion: 'success', run_number: 1 },
      { workflow_id: 3, name: 'build', status: 'completed', conclusion: 'success', run_number: 1 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toEqual({
      allCompleted: true,
      totalWorkflows: 3,
      successCount: 3,
      workflowNames: expect.arrayContaining(['lint', 'test', 'build']),
    });
    expect(result!.workflowNames).toHaveLength(3);
  });

  it('returns allCompleted false when some workflows are still running', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'lint', status: 'completed', conclusion: 'success', run_number: 1 },
      { workflow_id: 2, name: 'test', status: 'in_progress', conclusion: null, run_number: 1 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).not.toBeNull();
    expect(result!.allCompleted).toBe(false);
    expect(result!.totalWorkflows).toBe(2);
    expect(result!.successCount).toBe(1);
  });

  it('returns allCompleted false when one workflow failed', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'lint', status: 'completed', conclusion: 'success', run_number: 1 },
      { workflow_id: 2, name: 'test', status: 'completed', conclusion: 'failure', run_number: 1 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).not.toBeNull();
    expect(result!.allCompleted).toBe(false);
    expect(result!.totalWorkflows).toBe(2);
    expect(result!.successCount).toBe(1);
  });

  it('deduplicates reruns and uses the latest run per workflow', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'lint', status: 'completed', conclusion: 'success', run_number: 5 },
      { workflow_id: 2, name: 'test', status: 'completed', conclusion: 'success', run_number: 3 },
      { workflow_id: 2, name: 'test', status: 'completed', conclusion: 'failure', run_number: 2 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toEqual({
      allCompleted: true,
      totalWorkflows: 2,
      successCount: 2,
      workflowNames: expect.arrayContaining(['lint', 'test']),
    });
    expect(result!.workflowNames).toHaveLength(2);
  });

  it('returns null when gh command fails with non-zero exit code', async () => {
    setSpawnResponse('', 1, 'gh: not found');

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toBeNull();
  });

  it('returns null when gh command times out', async () => {
    mockSpawnResult = {
      exited: new Promise(() => {}), // Never resolves
      stdout: createEmptyStream(),
      stderr: createEmptyStream(),
      kill: () => {},
    };

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    // The default 10s timeout is too long for tests, so we race with our own timeout.
    // In a real scenario the internal timeout fires and returns null.
    // Here we verify the behavior by racing.
    expect(result).toBeNull();
  }, 15000);

  it('returns null when response is invalid JSON', async () => {
    setSpawnResponse('this is not valid json');

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toBeNull();
  });

  it('returns null when workflow_runs array is empty', async () => {
    setSpawnResponse(JSON.stringify({ total_count: 0, workflow_runs: [] }));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toBeNull();
  });

  it('calls gh api with the correct endpoint', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success', run_number: 1 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    await checker('owner/repo', 'abc123');

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(['gh', 'api', '--paginate', 'repos/owner/repo/actions/runs?head_sha=abc123']);
  });

  it('does not pass cwd to Bun.spawn', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success', run_number: 1 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    await checker('owner/repo', 'abc123');

    expect(spawnCalls[0].options).not.toHaveProperty('cwd');
  });

  it('returns null when workflow_runs field is missing', async () => {
    setSpawnResponse(JSON.stringify({ total_count: 0 }));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'abc123');

    expect(result).toBeNull();
  });

  it('handles rerun where older run succeeded but latest failed', async () => {
    setSpawnResponse(makeWorkflowRunsResponse([
      { workflow_id: 1, name: 'test', status: 'completed', conclusion: 'success', run_number: 1 },
      { workflow_id: 1, name: 'test', status: 'completed', conclusion: 'failure', run_number: 2 },
    ]));

    const { createCICompletionChecker } = await getModule();
    const checker = createCICompletionChecker();
    const result = await checker('owner/repo', 'sha456');

    expect(result).not.toBeNull();
    expect(result!.allCompleted).toBe(false);
    expect(result!.totalWorkflows).toBe(1);
    expect(result!.successCount).toBe(0);
  });
});
