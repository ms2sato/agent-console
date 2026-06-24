import { describe, it, expect, beforeEach, afterAll, afterEach } from 'bun:test';
import * as os from 'node:os';
import type { AgentDefinition } from '@agent-console/shared';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';
import { extractPromptFromSpawnCommand } from '../../__tests__/utils/extract-prompt-from-command.js';

// Mock Bun.spawn for agent command execution
let mockSpawnResult = {
  exited: Promise.resolve(0),
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"branch": "feat/test", "title": "Test"}'));
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

const mockAgent: AgentDefinition = {
  id: 'test-agent',
  name: 'Test Agent',
  commandTemplate: 'test-cli {{prompt}}',
  headlessTemplate: 'test-cli -p --format text {{prompt}}',
  isBuiltIn: false,
  createdAt: new Date().toISOString(),
  capabilities: {
    supportsContinue: false,
    supportsHeadlessMode: true,
    supportsActivityDetection: false,
  },
};

const mockAgentWithoutHeadless: AgentDefinition = {
  id: 'no-headless-agent',
  name: 'No Headless Agent',
  commandTemplate: 'no-headless-cli {{prompt}}',
  isBuiltIn: false,
  createdAt: new Date().toISOString(),
  capabilities: {
    supportsContinue: false,
    supportsHeadlessMode: false,
    supportsActivityDetection: false,
  },
};

let importCounter = 0;

const originalAuthMode = process.env.AUTH_MODE;

describe('session-metadata-suggester', () => {
  beforeEach(() => {
    mockGit.listAllBranches.mockReset();
    mockGit.listAllBranches.mockImplementation(() => Promise.resolve(['main', 'feat/existing']));

    // Default to single-user mode for the existing test set; the
    // multi-user tests below set AUTH_MODE explicitly and rely on
    // afterEach to restore the original value.
    delete process.env.AUTH_MODE;

    spawnCalls = [];
    // Reset mock spawn result
    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"branch": "feat/test", "title": "Test"}'));
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

    // Mock Bun.spawn
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ args, options: options || {} });
      return mockSpawnResult;
    }) as typeof Bun.spawn;
  });

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  // Restore original Bun.spawn after all tests
  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
  });

  // Helper to get fresh module instance
  async function getModule() {
    return import(`../session-metadata-suggester.js?v=${++importCounter}`);
  }

  // Helper to set mock spawn result
  function setMockSpawnResult(stdout: string, exitCode = 0, stderr = '') {
    mockSpawnResult = {
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderr));
          controller.close();
        },
      }),
      kill: () => {},
    };
  }

  describe('getBranches', () => {
    it('should return branches from git module', async () => {
      mockGit.listAllBranches.mockImplementation(() =>
        Promise.resolve(['main', 'feat/current-branch', 'fix/some-bug'])
      );

      const { getBranches } = await getModule();

      const branches = await getBranches('/repo');

      expect(branches).toContain('main');
      expect(branches).toContain('feat/current-branch');
      expect(branches).toContain('fix/some-bug');
    });

    it('should return empty array on error', async () => {
      mockGit.listAllBranches.mockImplementation(() => Promise.resolve([]));

      const { getBranches } = await getModule();

      const branches = await getBranches('/not-a-repo');

      expect(branches).toEqual([]);
    });
  });

  describe('suggestSessionMetadata', () => {
    it('should return branch and title from JSON response', async () => {
      setMockSpawnResult('{"branch": "feat/add-dark-mode", "title": "Add dark mode toggle"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add a dark mode toggle',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBe('feat/add-dark-mode');
      expect(result.title).toBe('Add dark mode toggle');
      expect(result.error).toBeUndefined();

      // Verify spawn was called with shell command
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args[0]).toBe('sh');
      expect(spawnCalls[0].args[1]).toBe('-c');
      // The command should be expanded from headlessTemplate
      expect(spawnCalls[0].args[2]).toContain('test-cli -p --format text');
    });

    it('should return error if agent does not support headless mode', async () => {
      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgentWithoutHeadless,
        requestUser: null,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('does not support headless mode');
    });

    it('should sanitize branch names with invalid characters', async () => {
      setMockSpawnResult('{"branch": "feat/Add Dark Mode!", "title": "Add dark mode"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add dark mode',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      // Should be sanitized to lowercase with hyphens
      expect(result.branch).toBe('feat/add-dark-mode');
      expect(result.title).toBe('Add dark mode');
    });

    it('should return error when agent fails', async () => {
      setMockSpawnResult('', 1, 'command not found');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Agent command failed');
    });

    it('should return error when response has no JSON', async () => {
      setMockSpawnResult('plain text response without JSON');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Failed to extract JSON');
    });

    it('should return error when JSON is invalid', async () => {
      setMockSpawnResult('{invalid json}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Failed to parse JSON');
    });

    it('should return error when branch is missing from JSON', async () => {
      setMockSpawnResult('{"title": "Some title"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('missing branch');
    });

    it('should use provided existingBranches instead of fetching', async () => {
      setMockSpawnResult('{"branch": "fix/auth-bug", "title": "Fix authentication bug"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Fix authentication',
        repositoryPath: '/repo',
        agent: mockAgent,
        existingBranches: ['feat/login', 'feat/signup'],
        requestUser: null,
      });

      // Should not call listAllBranches
      expect(mockGit.listAllBranches).not.toHaveBeenCalled();
      expect(result.branch).toBe('fix/auth-bug');
      expect(result.title).toBe('Fix authentication bug');
    });

    it('should extract JSON even with extra text', async () => {
      setMockSpawnResult('Here is the response:\n{"branch": "feat/feature", "title": "New feature"}\nDone.');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBe('feat/feature');
      expect(result.title).toBe('New feature');
    });

    it('should work with no existing branches', async () => {
      mockGit.listAllBranches.mockImplementation(() => Promise.resolve([]));
      setMockSpawnResult('{"branch": "feat/new-feature", "title": "New feature"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'New feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBe('feat/new-feature');
      expect(result.title).toBe('New feature');
    });

    it('should handle title in same language as input (Japanese)', async () => {
      setMockSpawnResult('{"branch": "feat/dark-mode", "title": "ダークモードの追加"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'ダークモードを追加する',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBe('feat/dark-mode');
      expect(result.title).toBe('ダークモードの追加');
    });

    it('should handle title with trailing whitespace', async () => {
      setMockSpawnResult('{"branch": "feat/feature", "title": "  Some title  "}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.branch).toBe('feat/feature');
      expect(result.title).toBe('Some title');
    });

    it('should pass prompt embedded in the spawn command (Issue #851)', async () => {
      setMockSpawnResult('{"branch": "feat/new-feature", "title": "New feature"}');

      const { suggestSessionMetadata } = await getModule();

      await suggestSessionMetadata({
        prompt: 'Add new feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      // Verify the prompt is embedded in the spawn command (no longer via env).
      expect(spawnCalls.length).toBe(1);
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('Add new feature');
      // env must NOT carry the prompt anymore.
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      expect(options.env?.__AGENT_PROMPT__).toBeUndefined();
    });

    it('should include existing branches in prompt to avoid duplicates', async () => {
      mockGit.listAllBranches.mockImplementation(() =>
        Promise.resolve(['main', 'feat/existing-feature', 'fix/old-bug'])
      );
      setMockSpawnResult('{"branch": "feat/new-feature", "title": "New feature"}');

      const { suggestSessionMetadata } = await getModule();

      await suggestSessionMetadata({
        prompt: 'Add new feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      // Verify the embedded prompt includes instruction to avoid existing branches
      expect(spawnCalls.length).toBe(1);
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('Do NOT use any of these existing branch names');
      expect(prompt).toContain('main');
      expect(prompt).toContain('feat/existing-feature');
      expect(prompt).toContain('fix/old-bug');
    });

    it('should include provided existingBranches in prompt to avoid duplicates', async () => {
      setMockSpawnResult('{"branch": "feat/unique-name", "title": "Unique feature"}');

      const { suggestSessionMetadata } = await getModule();

      await suggestSessionMetadata({
        prompt: 'Add feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        existingBranches: ['feat/conflicting-name', 'fix/another-branch'],
        requestUser: null,
      });

      // Verify the embedded prompt includes instruction to avoid provided branches
      expect(spawnCalls.length).toBe(1);
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('Do NOT use any of these existing branch names');
      expect(prompt).toContain('feat/conflicting-name');
      expect(prompt).toContain('fix/another-branch');
    });

    it('should not include duplicate avoidance instruction when no branches exist', async () => {
      mockGit.listAllBranches.mockImplementation(() => Promise.resolve([]));
      setMockSpawnResult('{"branch": "feat/first-feature", "title": "First feature"}');

      const { suggestSessionMetadata } = await getModule();

      await suggestSessionMetadata({
        prompt: 'Add first feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      // Verify the embedded prompt does NOT include duplicate avoidance instruction
      expect(spawnCalls.length).toBe(1);
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).not.toContain('Do NOT use any of these existing branch names');
    });

    // -- Privilege-elevation branch (Issue #856) --
    //
    // The runAsUser helper inspects AUTH_MODE + requestUser to decide whether
    // to elevate via sudo. These assertions exercise the resulting spawn argv
    // shape so a regression in routing back to the elevated branch fails the
    // test rather than only manifesting at runtime in multi-user deployments.
    // Mirrors the Issue #835 / PR #842 pattern in
    // repository-description-generator.test.ts.

    it('AUTH_MODE=none: bypasses elevation even when requestUser is set', async () => {
      process.env.AUTH_MODE = 'none';
      setMockSpawnResult('{"branch": "feat/feature", "title": "Feature"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: 'alice',
      });

      expect(result.error).toBeUndefined();
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args[0]).toBe('sh');
      expect(spawnCalls[0].args[1]).toBe('-c');
      expect(spawnCalls[0].args[2]).toContain('test-cli -p --format text');
    });

    it('AUTH_MODE=multi-user with non-server requestUser: elevates via sudo as that user', async () => {
      process.env.AUTH_MODE = 'multi-user';
      const targetUser = `${os.userInfo().username}-someone-else`;
      setMockSpawnResult('{"branch": "feat/feature", "title": "Feature"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: targetUser,
      });

      expect(result.error).toBeUndefined();
      expect(spawnCalls.length).toBe(1);
      // Elevated argv: ['sudo', '-u', <user>, '--preserve-env=FORCE_COLOR', '-i', 'sh', '-c', <inner>]
      const args = spawnCalls[0].args;
      expect(args[0]).toBe('sudo');
      expect(args[1]).toBe('-u');
      expect(args[2]).toBe(targetUser);
      expect(args[3]).toBe('--preserve-env=FORCE_COLOR');
      expect(args[4]).toBe('-i');
      expect(args[5]).toBe('sh');
      expect(args[6]).toBe('-c');
      // `sudo -i` resets env + chdirs to target HOME, so cwd / env MUST be
      // interpolated into the inner command. The inner shell should contain
      // the cd to the repo path, the env exports (`export K=v; <command>`
      // carrying TERM=dumb), and the agent command. After Issue #851, the
      // prompt is embedded directly into the agent command via shellEscape
      // (single-quoted literal), not exported as __AGENT_PROMPT__.
      const inner = args[7];
      expect(inner).toContain("cd '/repo'");
      expect(inner).toMatch(/export\b[^;]*\bTERM='dumb'/);
      expect(inner).not.toContain('__AGENT_PROMPT__');
      expect(inner).toContain('test-cli -p --format text');
      // The prompt is now embedded as the last single-quoted segment of the
      // inner command (after the headless template's trailing {{prompt}}
      // placeholder). Verify the suggestion prompt content reached the spawn.
      const prompt = extractPromptFromSpawnCommand(inner);
      expect(prompt).toContain('session metadata generator');
      expect(prompt).toContain('Add feature');
    });

    it('AUTH_MODE=multi-user with requestUser == server user: bypasses elevation', async () => {
      process.env.AUTH_MODE = 'multi-user';
      setMockSpawnResult('{"branch": "feat/feature", "title": "Feature"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: os.userInfo().username,
      });

      expect(result.error).toBeUndefined();
      expect(spawnCalls.length).toBe(1);
      // Direct spawn, no sudo prefix.
      expect(spawnCalls[0].args[0]).toBe('sh');
      expect(spawnCalls[0].args[1]).toBe('-c');
      expect(spawnCalls[0].args[2]).toContain('test-cli -p --format text');
    });

    it('AUTH_MODE=multi-user with non-server requestUser: surfaces stderr when sudo exits non-zero', async () => {
      // Real-world failure shape: `claude` not on the elevated user's PATH.
      // The helper returns a non-zero exitCode and captured stderr; the
      // suggester surfaces it via the error path.
      process.env.AUTH_MODE = 'multi-user';
      setMockSpawnResult('', 127, 'sh: 1: claude: not found');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add feature',
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: `${os.userInfo().username}-someone-else`,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Agent command failed');
      expect(result.error).toContain('claude: not found');
    });
  });
});
