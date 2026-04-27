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

type MockSpawnResult = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
};

let mockSpawnResult: MockSpawnResult;
let spawnResponseQueue: MockSpawnResult[] = [];

function makeSpawnResult(stdout: string, exitCode = 0, stderr = ''): MockSpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: createReadableStream(stdout),
    stderr: createReadableStream(stderr),
    kill: () => {},
  };
}

function setSpawnResponse(stdout: string, exitCode = 0, stderr = '') {
  mockSpawnResult = makeSpawnResult(stdout, exitCode, stderr);
}

function enqueueSpawnResponse(stdout: string, exitCode = 0, stderr = '') {
  spawnResponseQueue.push(makeSpawnResult(stdout, exitCode, stderr));
}

function makeWorkflowRunsResponse(runs: Array<{
  workflow_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
}>): string {
  return JSON.stringify([{
    total_count: runs.length,
    workflow_runs: runs,
  }]);
}

describe('ci-completion-checker', () => {
  beforeEach(() => {
    spawnCalls = [];
    spawnResponseQueue = [];
    setSpawnResponse('[{}]');

    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      // Prefer queued responses (one per call) when present; otherwise fall back
      // to the singleton mockSpawnResult (preserves backwards-compatibility with
      // existing single-response tests).
      return spawnResponseQueue.shift() ?? mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  async function getModule() {
    return import(`../ci-completion-checker.js?v=${++importCounter}`);
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
    setSpawnResponse(JSON.stringify([{ total_count: 0, workflow_runs: [] }]));

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
    expect(spawnCalls[0].args).toEqual(['gh', 'api', '--paginate', '--slurp', 'repos/owner/repo/actions/runs?head_sha=abc123']);
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
    setSpawnResponse(JSON.stringify([{ total_count: 0 }]));

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

  describe('PR statusCheckRollup mode', () => {
    type RollupCheckRun = {
      __typename: 'CheckRun';
      name: string;
      status: string;
      conclusion: string | null;
    };
    type RollupStatusContext = {
      __typename: 'StatusContext';
      context: string;
      state: string;
    };
    type RollupEntry = RollupCheckRun | RollupStatusContext;

    function makePRListResponse(prs: Array<{
      number: number;
      headRefOid: string;
      statusCheckRollup: RollupEntry[];
    }>): string {
      return JSON.stringify(prs);
    }

    it('reports allCompleted false when latest commit on PR has a failing CheckRun', async () => {
      // MAIN BUG TEST — webhook fires for the PR HEAD commit, but the rollup
      // for that commit contains a failure. Event must NOT report all-passed.
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 1247,
          headRefOid: 'newSha',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'preview', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'newSha', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(false);
    });

    it('suppresses event when webhook commit SHA differs from PR head (older commit)', async () => {
      // Same PR, but webhook fired for an older commit. Suppress regardless of
      // rollup contents — the rollup belongs to a different commit now.
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 1247,
          headRefOid: 'newSha',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'oldSha', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(false);
    });

    it('reports allCompleted true with workflowNames when all rollup entries succeed', async () => {
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 100,
          headRefOid: 'sha-head',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(true);
      expect(result!.totalWorkflows).toBe(3);
      expect(result!.successCount).toBe(3);
      expect(result!.workflowNames).toEqual(['lint', 'test', 'build']);
    });

    it('handles mixed CheckRun + StatusContext rollup, all success', async () => {
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 100,
          headRefOid: 'sha-head',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'gha-test', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(true);
      expect(result!.workflowNames).toEqual(['gha-test', 'ci/legacy']);
    });

    it('suppresses when any rollup entry is still pending (CheckRun without conclusion)', async () => {
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 100,
          headRefOid: 'sha-head',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(false);
    });

    it('suppresses when StatusContext is PENDING', async () => {
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 100,
          headRefOid: 'sha-head',
          statusCheckRollup: [
            { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(false);
    });

    it('treats SKIPPED and NEUTRAL CheckRun conclusions as success', async () => {
      enqueueSpawnResponse(makePRListResponse([
        {
          number: 100,
          headRefOid: 'sha-head',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
            { __typename: 'CheckRun', name: 'advisory', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          ],
        },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(true);
      expect(result!.workflowNames).toEqual(['lint', 'optional', 'advisory']);
    });

    it('falls back to workflow-runs path when no PR is found for the branch', async () => {
      // First call: gh pr list returns []
      enqueueSpawnResponse(makePRListResponse([]));
      // Second call: gh api workflow runs returns all-success
      enqueueSpawnResponse(makeWorkflowRunsResponse([
        { workflow_id: 1, name: 'lint', status: 'completed', conclusion: 'success', run_number: 1 },
        { workflow_id: 2, name: 'test', status: 'completed', conclusion: 'success', run_number: 1 },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-orphan', 'no-pr-branch');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(true);
      expect(result!.totalWorkflows).toBe(2);
      // Verify both spawn calls were made in the right order
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0].args[0]).toBe('gh');
      expect(spawnCalls[0].args[1]).toBe('pr');
      expect(spawnCalls[0].args[2]).toBe('list');
      expect(spawnCalls[1].args[0]).toBe('gh');
      expect(spawnCalls[1].args[1]).toBe('api');
    });

    it('returns null (fail-open) when gh pr list fails with non-zero exit', async () => {
      enqueueSpawnResponse('', 1, 'gh: not authenticated');

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).toBeNull();
    });

    it('returns null (fail-open) when gh pr list output is malformed', async () => {
      enqueueSpawnResponse('not valid json');

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head', 'feature-x');

      expect(result).toBeNull();
    });

    it('uses workflow-runs path only when branch argument is omitted (legacy path)', async () => {
      setSpawnResponse(makeWorkflowRunsResponse([
        { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success', run_number: 1 },
      ]));

      const { createCICompletionChecker } = await getModule();
      const checker = createCICompletionChecker();
      const result = await checker('owner/repo', 'sha-head');

      expect(result).not.toBeNull();
      expect(result!.allCompleted).toBe(true);
      // Only the workflow-runs call was made; no PR-list call
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].args[1]).toBe('api');
    });
  });
});
