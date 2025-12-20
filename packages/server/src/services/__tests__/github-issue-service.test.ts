import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';

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

describe('github-issue-service', () => {
  beforeEach(() => {
    spawnCalls = [];
    mockGit.getRemoteUrl.mockReset();
    mockGit.parseOrgRepo.mockReset();
    mockGit.getRemoteUrl.mockImplementation(() => Promise.resolve('git@github.com:owner/repo.git'));
    mockGit.parseOrgRepo.mockImplementation(() => 'owner/repo');

    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"title":"Add docs","body":"Details","html_url":"https://github.com/owner/repo/issues/123"}'));
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
    return import(`../github-issue-service.js?v=${++importCounter}`);
  }

  it('parses URL references', async () => {
    const { parseIssueReference } = await getModule();
    const result = parseIssueReference('https://github.com/owner/repo/issues/123');
    expect(result).toEqual({ org: 'owner', repo: 'repo', number: 123 });
  });

  it('parses owner/repo references', async () => {
    const { parseIssueReference } = await getModule();
    const result = parseIssueReference('owner/repo#456');
    expect(result).toEqual({ org: 'owner', repo: 'repo', number: 456 });
  });

  it('fetches issue details for short references', async () => {
    const { fetchGitHubIssue } = await getModule();
    const issue = await fetchGitHubIssue('#123', '/repo');

    expect(issue.title).toBe('Add docs');
    expect(issue.body).toBe('Details');
    expect(issue.url).toBe('https://github.com/owner/repo/issues/123');
    expect(issue.suggestedBranch).toBe('add-docs');
    expect(spawnCalls[0]?.args).toEqual(['gh', 'api', 'repos/owner/repo/issues/123']);
  });
});
