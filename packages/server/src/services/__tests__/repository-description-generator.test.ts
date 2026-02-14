import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { AgentDefinition } from '@agent-console/shared';

// Mock Bun.spawn for agent command execution
let mockSpawnResult = {
  exited: Promise.resolve(0),
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('A test repository description.'));
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

// Mock Bun.file for README reading
// We must preserve the original Bun.file for internal usage (e.g., Pino/sonic-boom)
// and only intercept calls for paths under our mock repository.
const originalBunFile = Bun.file.bind(Bun);
let mockFileContents: Map<string, string> = new Map();

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

describe('repository-description-generator', () => {
  beforeEach(() => {
    spawnCalls = [];
    mockFileContents = new Map();

    // Reset mock spawn result
    mockSpawnResult = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('A test repository description.'));
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

    // Mock Bun.file - only intercept calls for mock repository paths,
    // delegate all other calls to the original to avoid breaking Pino/sonic-boom
    (Bun as { file: typeof Bun.file }).file = ((...args: unknown[]) => {
      const filePath = args[0] as string;
      if (typeof filePath === 'string' && mockFileContents.has(filePath)) {
        return {
          text: () => Promise.resolve(mockFileContents.get(filePath)!),
        } as ReturnType<typeof Bun.file>;
      }
      if (typeof filePath === 'string' && filePath.startsWith('/repo/')) {
        return {
          text: () => Promise.reject(new Error(`File not found: ${filePath}`)),
        } as ReturnType<typeof Bun.file>;
      }
      return originalBunFile(...(args as Parameters<typeof Bun.file>));
    }) as typeof Bun.file;
  });

  // Restore originals after all tests
  afterAll(() => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalBunSpawn;
    (Bun as { file: typeof Bun.file }).file = originalBunFile;
  });

  // Helper to get fresh module instance
  async function getModule() {
    return import(`../repository-description-generator.js?v=${++importCounter}`);
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

  describe('generateRepositoryDescription', () => {
    it('should return description from plain text response', async () => {
      mockFileContents.set('/repo/README.md', '# My Project\n\nA great project.');
      setMockSpawnResult('A web application for managing AI agents.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBe('A web application for managing AI agents.');
      expect(result.error).toBeUndefined();

      // Verify spawn was called with shell command
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].args[0]).toBe('sh');
      expect(spawnCalls[0].args[1]).toBe('-c');
      expect(spawnCalls[0].args[2]).toContain('test-cli -p --format text');
    });

    it('should return error if agent does not support headless mode', async () => {
      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgentWithoutHeadless,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toContain('does not support headless mode');
    });

    it('should return error when no README is found', async () => {
      // No files mocked - all README candidates will fail
      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toBe('No README file found in repository');
    });

    it('should try README candidates in order', async () => {
      // Only README.txt exists (not README.md or README)
      mockFileContents.set('/repo/README.txt', 'Plain text readme.');
      setMockSpawnResult('A plain text project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBe('A plain text project.');
      expect(result.error).toBeUndefined();
    });

    it('should prefer README.md over other candidates', async () => {
      mockFileContents.set('/repo/README.md', '# Markdown README');
      mockFileContents.set('/repo/README', 'Plain README');
      setMockSpawnResult('A markdown project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      // Verify the prompt uses the README.md content
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).toContain('# Markdown README');
      expect(prompt).not.toContain('Plain README');
    });

    it('should truncate long README content', async () => {
      const longContent = 'x'.repeat(10000);
      mockFileContents.set('/repo/README.md', longContent);
      setMockSpawnResult('A large project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).toContain('...(truncated)');
      // The truncated content should be ~8000 chars, not 10000
      expect(prompt.length).toBeLessThan(10000);
    });

    it('should not truncate short README content', async () => {
      const shortContent = '# Short\n\nA short README.';
      mockFileContents.set('/repo/README.md', shortContent);
      setMockSpawnResult('A short project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).not.toContain('...(truncated)');
      expect(prompt).toContain(shortContent);
    });

    it('should return error when agent command fails', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('', 1, 'command not found');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toContain('Agent command failed');
    });

    it('should return error when agent returns empty response', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('   ');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toBe('Agent returned empty response');
    });

    it('should trim whitespace from response', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('  A project description.  \n');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBe('A project description.');
    });

    it('should pass prompt via environment variable', async () => {
      mockFileContents.set('/repo/README.md', '# My Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      // Verify env contains the prompt
      expect(spawnCalls.length).toBe(1);
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      expect(options.env).toBeDefined();
      expect(options.env!.__AGENT_PROMPT__).toContain('repository description generator');
      expect(options.env!.__AGENT_PROMPT__).toContain('# My Project');
    });

    it('should include language instruction in prompt', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).toContain('same language as the README');
    });

    it('should include output format instruction in prompt', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      const options = spawnCalls[0].options as { env?: Record<string, string> };
      const prompt = options.env!.__AGENT_PROMPT__;
      expect(prompt).toContain('ONLY the description text');
    });

    it('should read README.rst as fallback', async () => {
      mockFileContents.set('/repo/README.rst', 'reStructuredText README');
      setMockSpawnResult('An rst project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
      });

      expect(result.description).toBe('An rst project.');
    });
  });
});
