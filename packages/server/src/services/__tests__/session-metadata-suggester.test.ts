import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as childProcess from 'child_process';
import type { AgentDefinition } from '@agent-console/shared';

// Mock child_process module (built-in module - acceptable per testing guidelines)
mock.module('child_process', () => ({
  execSync: mock(() => ''),
}));

const mockAgent: AgentDefinition = {
  id: 'test-agent',
  name: 'Test Agent',
  command: 'test-cli',
  isBuiltIn: false,
  registeredAt: new Date().toISOString(),
  printModeArgs: ['-p', '--format', 'text'],
};

const mockAgentWithoutPrintMode: AgentDefinition = {
  id: 'no-print-agent',
  name: 'No Print Agent',
  command: 'no-print-cli',
  isBuiltIn: false,
  registeredAt: new Date().toISOString(),
};

// Get reference to mock function for configuration
const mockExecSync = childProcess.execSync as ReturnType<typeof mock>;
let importCounter = 0;

describe('session-metadata-suggester', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  // Helper to get fresh module instance
  async function getModule() {
    return import(`../session-metadata-suggester.js?v=${++importCounter}`);
  }

  describe('getBranches', () => {
    it('should parse git branch output', async () => {
      mockExecSync.mockReturnValue(
        '  main\n* feat/current-branch\n  fix/some-bug\n  remotes/origin/main\n'
      );

      const { getBranches } = await getModule();

      const branches = getBranches('/repo');

      expect(branches).toContain('main');
      expect(branches).toContain('feat/current-branch');
      expect(branches).toContain('fix/some-bug');
      // Should not duplicate main from remotes
      expect(branches.filter((b: string) => b === 'main').length).toBe(1);
    });

    it('should return empty array on error', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const { getBranches } = await getModule();

      const branches = getBranches('/not-a-repo');

      expect(branches).toEqual([]);
    });
  });

  describe('suggestSessionMetadata', () => {
    it('should return branch and title from JSON response', async () => {
      // First call for git branch, second for agent
      mockExecSync
        .mockReturnValueOnce('  main\n  feat/existing\n')
        .mockReturnValueOnce('{"branch": "feat/add-dark-mode", "title": "Add dark mode toggle"}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Add a dark mode toggle',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBe('feat/add-dark-mode');
      expect(result.title).toBe('Add dark mode toggle');
      expect(result.error).toBeUndefined();

      // Verify command was built correctly
      const calls = mockExecSync.mock.calls;
      const agentCall = calls[1][0] as string;
      expect(agentCall).toContain('test-cli');
      expect(agentCall).toContain('-p');
      expect(agentCall).toContain('--format');
      expect(agentCall).toContain('text');
    });

    it('should return error if agent does not support print mode', async () => {
      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgentWithoutPrintMode,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('does not support non-interactive mode');
    });

    it('should sanitize branch names with invalid characters', async () => {
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('{"branch": "feat/Add Dark Mode!", "title": "Add dark mode"}');

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
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockImplementationOnce(() => {
          throw new Error('command not found');
        });

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some task',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBeUndefined();
      expect(result.error).toContain('Failed to suggest branch name');
    });

    it('should return error when response has no JSON', async () => {
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('plain text response without JSON');

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
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('{invalid json}');

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
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('{"title": "Some title"}');

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
      mockExecSync.mockReturnValue(
        '{"branch": "fix/auth-bug", "title": "Fix authentication bug"}'
      );

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Fix authentication',
        repositoryPath: '/repo',
        agent: mockAgent,
        existingBranches: ['feat/login', 'feat/signup'],
      });

      // Should only call execSync once (for agent), not for git branch
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(result.branch).toBe('fix/auth-bug');
      expect(result.title).toBe('Fix authentication bug');
    });

    it('should extract JSON even with extra text', async () => {
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('Here is the response:\n{"branch": "feat/feature", "title": "New feature"}\nDone.');

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
      mockExecSync
        .mockReturnValueOnce('')  // No branches
        .mockReturnValueOnce('{"branch": "feat/new-feature", "title": "New feature"}');

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
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('{"branch": "feat/dark-mode", "title": "ダークモードの追加"}');

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
      mockExecSync
        .mockReturnValueOnce('  main\n')
        .mockReturnValueOnce('{"branch": "feat/feature", "title": "  Some title  "}');

      const { suggestSessionMetadata } = await getModule();

      const result = await suggestSessionMetadata({
        prompt: 'Some feature',
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.branch).toBe('feat/feature');
      expect(result.title).toBe('Some title');
    });
  });
});
