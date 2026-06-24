import { describe, it, expect, beforeEach, afterAll, afterEach } from 'bun:test';
import * as os from 'node:os';
import type { AgentDefinition } from '@agent-console/shared';
import { extractPromptFromSpawnCommand } from '../../__tests__/utils/extract-prompt-from-command.js';

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

const originalAuthMode = process.env.AUTH_MODE;

describe('repository-description-generator', () => {
  beforeEach(() => {
    spawnCalls = [];
    mockFileContents = new Map();
    // Default to single-user mode for the existing test set; the
    // multi-user tests below set AUTH_MODE explicitly and rely on
    // afterEach to restore the original value.
    delete process.env.AUTH_MODE;

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

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
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
        requestUser: null,
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
        requestUser: null,
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
        requestUser: null,
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
        requestUser: null,
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
        requestUser: null,
      });

      // Verify the prompt uses the README.md content. After Issue #851, the
      // prompt is embedded directly in the spawn command via shellEscape
      // (no longer indirected through env.__AGENT_PROMPT__).
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
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
        requestUser: null,
      });

      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
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
        requestUser: null,
      });

      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
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
        requestUser: null,
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
        requestUser: null,
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
        requestUser: null,
      });

      expect(result.description).toBe('A project description.');
    });

    it('should pass prompt embedded in the spawn command (Issue #851)', async () => {
      mockFileContents.set('/repo/README.md', '# My Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      // Verify the prompt is embedded in the spawn command (no longer via env).
      expect(spawnCalls.length).toBe(1);
      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('repository description generator');
      expect(prompt).toContain('# My Project');
      // env must NOT carry the prompt anymore.
      const options = spawnCalls[0].options as { env?: Record<string, string> };
      expect(options.env?.__AGENT_PROMPT__).toBeUndefined();
    });

    it('should include language instruction in prompt', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('same language as the README');
    });

    it('should include output format instruction in prompt', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      const prompt = extractPromptFromSpawnCommand(spawnCalls[0].args[2]);
      expect(prompt).toContain('ONLY the description text');
    });

    it('should return error when agent has supportsHeadlessMode but no headlessTemplate', async () => {
      mockFileContents.set('/repo/README.md', '# Project');
      const agentMissingTemplate: AgentDefinition = {
        ...mockAgent,
        id: 'missing-template-agent',
        name: 'Missing Template Agent',
        headlessTemplate: undefined,
        capabilities: {
          ...mockAgent.capabilities,
          supportsHeadlessMode: true,
        },
      };

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: agentMissingTemplate,
        requestUser: null,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toContain('has no headless template configured');
    });

    it('should return timeout error when agent command times out', async () => {
      mockFileContents.set('/repo/README.md', '# Project');

      // Simulate a process that is killed by timeout (exit code != 0)
      // We capture the kill call and set up exited to resolve after kill
      let killCalled = false;
      let resolveExited: (value: number) => void;
      const exitedPromise = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });

      mockSpawnResult = {
        exited: exitedPromise,
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
        kill: () => {
          killCalled = true;
          // Simulate the process exiting with non-zero after being killed
          resolveExited!(137);
        },
      };

      // Override setTimeout to fire the timeout callback immediately (with 0ms delay)
      // This avoids waiting 30 seconds in test while still exercising the timeout code path
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, _delay?: number) => {
        return originalSetTimeout(callback, 0);
      }) as typeof globalThis.setTimeout;

      try {
        const { generateRepositoryDescription } = await getModule();

        const result = await generateRepositoryDescription({
          repositoryPath: '/repo',
          agent: mockAgent,
          requestUser: null,
        });

        expect(killCalled).toBe(true);
        expect(result.description).toBeUndefined();
        expect(result.error).toContain('timed out');
        expect(result.error).toContain('30 seconds');
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it('should read README.rst as fallback', async () => {
      mockFileContents.set('/repo/README.rst', 'reStructuredText README');
      setMockSpawnResult('An rst project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: null,
      });

      expect(result.description).toBe('An rst project.');
    });

    // -- Privilege-elevation branch (Issue #835) --
    //
    // The runAsUser helper inspects AUTH_MODE + requestUser to decide whether
    // to elevate via sudo. These assertions exercise the resulting spawn argv
    // shape so a regression in routing back to the elevated branch fails the
    // test rather than only manifesting at runtime in multi-user deployments.

    it('AUTH_MODE=none: bypasses elevation even when requestUser is set', async () => {
      process.env.AUTH_MODE = 'none';
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
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
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
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
      // (single-quoted literal), not exported as __AGENT_PROMPT__. The
      // env-var indirection is incompatible with `sudo -u <user> -i`'s
      // double-quote wrapping of the inner command, which would expand
      // "$__AGENT_PROMPT__" against the empty login-shell environment
      // before the inner shell sees it.
      const inner = args[7];
      expect(inner).toContain("cd '/repo'");
      expect(inner).toMatch(/export\b[^;]*\bTERM='dumb'/);
      expect(inner).not.toContain('__AGENT_PROMPT__');
      expect(inner).toContain('test-cli -p --format text');
      // The prompt is now embedded as the last single-quoted segment of
      // the inner command (after the headless template's trailing
      // {{prompt}} placeholder).
      const prompt = extractPromptFromSpawnCommand(inner);
      expect(prompt).toContain('repository description generator');
      expect(prompt).toContain('# Project');
    });

    it('AUTH_MODE=multi-user with requestUser == server user: bypasses elevation', async () => {
      process.env.AUTH_MODE = 'multi-user';
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('A project.');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
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
      // description generator surfaces it via the error path.
      process.env.AUTH_MODE = 'multi-user';
      mockFileContents.set('/repo/README.md', '# Project');
      setMockSpawnResult('', 127, 'sh: 1: claude: not found');

      const { generateRepositoryDescription } = await getModule();

      const result = await generateRepositoryDescription({
        repositoryPath: '/repo',
        agent: mockAgent,
        requestUser: `${os.userInfo().username}-someone-else`,
      });

      expect(result.description).toBeUndefined();
      expect(result.error).toContain('Agent command failed');
      expect(result.error).toContain('claude: not found');
    });
  });
});
