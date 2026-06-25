import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
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
const originalAuthMode = process.env.AUTH_MODE;
let spawnCalls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
let importCounter = 0;

function installSpawnMock(): void {
  (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
    spawnCalls.push({ args, options: options || {} });
    return mockSpawnResult;
  }) as typeof Bun.spawn;
}

function pickNonServerUsername(): string {
  const serverUser = os.userInfo().username;
  return serverUser === 'alice' ? 'bob' : 'alice';
}

async function getModule() {
  return import(`../github-issue-service.js?v=${++importCounter}`);
}

describe('github-issue-service', () => {
  beforeEach(() => {
    spawnCalls = [];
    delete process.env.AUTH_MODE;
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

  it('fetches issue details for short references (requestUsername=null, non-elevated argv shape)', async () => {
    const { fetchGitHubIssue } = await getModule();
    const issue = await fetchGitHubIssue('#123', '/repo', null);

    expect(issue.title).toBe('Add docs');
    expect(issue.body).toBe('Details');
    expect(issue.url).toBe('https://github.com/owner/repo/issues/123');
    expect(issue.suggestedBranch).toBe('add-docs');

    // Non-elevated branch: ['sh','-c', <innerCommand>]
    expect(spawnCalls[0]?.args[0]).toBe('sh');
    expect(spawnCalls[0]?.args[1]).toBe('-c');
    const innerCommand = spawnCalls[0]?.args[2] ?? '';
    expect(innerCommand).toContain("'gh'");
    expect(innerCommand).toContain("'api'");
    expect(innerCommand).toContain("'repos/owner/repo/issues/123'");
    // Negative assertion (mirrors os-environment-coupling.md discipline):
    // helper must NOT export PATH into the inner command.
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
    expect(spawnCalls[0]?.options.cwd).toBe('/repo');
  });

  it('elevates via sudo when AUTH_MODE=multi-user and requestUsername differs from server user', async () => {
    process.env.AUTH_MODE = 'multi-user';
    const targetUser = pickNonServerUsername();

    const { fetchGitHubIssue } = await getModule();
    const issue = await fetchGitHubIssue('owner/repo#456', '/repo', targetUser);

    expect(issue.title).toBe('Add docs');

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
    expect(innerCommand).toContain("'api'");
    expect(innerCommand).toContain("'repos/owner/repo/issues/456'");
    // Negative assertion: helper must NOT export PATH into the inner command.
    expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/);
  });
});
