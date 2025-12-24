import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { AgentDefinition } from '@agent-console/shared';
import { mockGit } from '../../__tests__/utils/mock-git-helper.js';

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

describe('session-metadata-suggester', () => {
  beforeEach(() => {
    mockGit.listAllBranches.mockReset();
    mockGit.listAllBranches.mockImplementation(() => Promise.resolve(['main', 'feat/existing']));

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
      });

      expect(result.branch).toBe('feat/feature');
      expect(result.title).toBe('Some title');
    });

    it('should pass prompt via environment variable', async () => {
      setMockSpawnResult('{"branch": "feat/new-feature", "title": "New feature"}');

      const { suggestSessionMetadata } = await getModule();

      await suggestSessionMetadata({
        prompt: 'Add new feature',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      // Verify env contains the prompt
      expect(spawnCalls.length).toBe(1);
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      expect(options.env).toBeDefined();
      expect(options.env!.__AGENT_PROMPT__).toContain('Add new feature');
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
      });

      // Verify the env prompt includes instruction to avoid existing branches
      expect(spawnCalls.length).toBe(1);
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
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
      });

      // Verify the env prompt includes instruction to avoid provided branches
      expect(spawnCalls.length).toBe(1);
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
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
      });

      // Verify the env prompt does NOT include duplicate avoidance instruction
      expect(spawnCalls.length).toBe(1);
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).not.toContain('Do NOT use any of these existing branch names');
    });
  });
});
