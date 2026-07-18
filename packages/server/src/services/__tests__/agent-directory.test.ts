import { describe, it, expect, beforeEach } from 'bun:test';
import type { AgentDefinition, AgentDirectoryEntry, AgentSurface, EmbeddedAgentDefinition } from '@agent-console/shared';
import { AgentDirectory } from '../agent-directory.js';

/**
 * Hand-built fake AgentSurface<K> implementations. AgentDirectory's actual
 * dependency contract is the AgentSurface interface (not AgentManager /
 * EmbeddedAgentManager instances), so these are the correct lowest-level
 * test doubles per .claude/rules/testing.md.
 */
function makeTerminalAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'terminal-1',
    name: 'Terminal Agent',
    isBuiltIn: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    commandTemplate: 'agent {{prompt}}',
    capabilities: {
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    },
    ...overrides,
  };
}

function makeEmbeddedAgent(overrides: Partial<EmbeddedAgentDefinition> = {}): EmbeddedAgentDefinition {
  return {
    id: 'embedded-1',
    name: 'Embedded Agent',
    provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
    createdBy: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFakeTerminalSurface(agents: AgentDefinition[]): AgentSurface<'terminal'> {
  return {
    kind: 'terminal',
    list: () => agents.map((agent) => ({ kind: 'terminal' as const, agent })),
    get: (id) => {
      const agent = agents.find((a) => a.id === id);
      return agent ? { kind: 'terminal', agent } : undefined;
    },
    findByName: (name) =>
      agents.filter((a) => a.name === name).map((agent) => ({ kind: 'terminal' as const, agent })),
  };
}

function makeFakeEmbeddedSurface(agents: EmbeddedAgentDefinition[]): AgentSurface<'embedded'> {
  return {
    kind: 'embedded',
    list: () => agents.map((agent) => ({ kind: 'embedded' as const, agent })),
    get: (id) => {
      const agent = agents.find((a) => a.id === id);
      return agent ? { kind: 'embedded', agent } : undefined;
    },
    findByName: (name) =>
      agents.filter((a) => a.name === name).map((agent) => ({ kind: 'embedded' as const, agent })),
  };
}

describe('AgentDirectory', () => {
  describe('listAll', () => {
    it('returns an empty array when both registries are empty', () => {
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      expect(directory.listAll()).toEqual([]);
    });

    it('lists terminal entries before embedded entries', () => {
      const terminal = makeTerminalAgent({ id: 't1' });
      const embedded = makeEmbeddedAgent({ id: 'e1' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });

      const entries = directory.listAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ kind: 'terminal', agent: terminal });
      expect(entries[1]).toEqual({ kind: 'embedded', agent: embedded });
    });
  });

  describe('get', () => {
    let directory: AgentDirectory;
    const terminal = makeTerminalAgent({ id: 't1' });
    const embedded = makeEmbeddedAgent({ id: 'e1' });

    beforeEach(() => {
      directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });
    });

    it('returns the entry when found in the terminal registry', () => {
      expect(directory.get('terminal', 't1')).toEqual({ kind: 'terminal', agent: terminal });
    });

    it('returns undefined when not found in the terminal registry', () => {
      expect(directory.get('terminal', 'missing')).toBeUndefined();
    });

    it('returns the entry when found in the embedded registry', () => {
      expect(directory.get('embedded', 'e1')).toEqual({ kind: 'embedded', agent: embedded });
    });

    it('returns undefined when not found in the embedded registry', () => {
      expect(directory.get('embedded', 'missing')).toBeUndefined();
    });
  });

  describe('resolve by agentId', () => {
    it('resolves an id found in the terminal registry', () => {
      const terminal = makeTerminalAgent({ id: 'shared-id' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({ agentId: 'shared-id' });
      expect(result).toEqual({ ok: true, entry: { kind: 'terminal', agent: terminal } });
    });

    it('resolves an id found only in the embedded registry', () => {
      const embedded = makeEmbeddedAgent({ id: 'e1' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });

      const result = directory.resolve({ agentId: 'e1' });
      expect(result).toEqual({ ok: true, entry: { kind: 'embedded', agent: embedded } });
    });

    it('returns not-found when the id matches neither registry', () => {
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({ agentId: 'missing-id' });
      expect(result).toEqual({
        ok: false,
        reason: 'not-found',
        message: 'Agent not found: missing-id',
      });
    });

    it('prefers the terminal entry when the same id exists in both registries', () => {
      const terminal = makeTerminalAgent({ id: 'shared-id' });
      const embedded = makeEmbeddedAgent({ id: 'shared-id' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });

      const result = directory.resolve({ agentId: 'shared-id' });
      expect(result).toEqual({ ok: true, entry: { kind: 'terminal', agent: terminal } });
    });
  });

  describe('resolve by agentName', () => {
    it('returns not-found when there are zero matches', () => {
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({ agentName: 'Nonexistent' });
      expect(result).toEqual({
        ok: false,
        reason: 'not-found',
        message: 'No agent found with name: Nonexistent',
      });
    });

    it('resolves exactly one terminal match', () => {
      const terminal = makeTerminalAgent({ id: 't1', name: 'Solo' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({ agentName: 'Solo' });
      expect(result).toEqual({ ok: true, entry: { kind: 'terminal', agent: terminal } });
    });

    it('resolves exactly one embedded match', () => {
      const embedded = makeEmbeddedAgent({ id: 'e1', name: 'Solo' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });

      const result = directory.resolve({ agentName: 'Solo' });
      expect(result).toEqual({ ok: true, entry: { kind: 'embedded', agent: embedded } });
    });

    it('returns ambiguous when two matches exist within the same registry', () => {
      const t1 = makeTerminalAgent({ id: 't1', name: 'Dup' });
      const t2 = makeTerminalAgent({ id: 't2', name: 'Dup' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([t1, t2]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({ agentName: 'Dup' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('ambiguous');
      if (result.reason !== 'ambiguous') throw new Error('unreachable');
      expect(result.message).toBe(
        `Multiple agents match name "Dup": Dup (t1), Dup (t2). Use agentId to specify.`,
      );
      expect(result.candidates).toEqual([
        { kind: 'terminal', agent: t1 },
        { kind: 'terminal', agent: t2 },
      ]);
    });

    it('returns ambiguous when matches are split across both registries, terminal listed first', () => {
      const terminal = makeTerminalAgent({ id: 't1', name: 'Cross' });
      const embedded = makeEmbeddedAgent({ id: 'e1', name: 'Cross' });
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([terminal]),
        embedded: makeFakeEmbeddedSurface([embedded]),
      });

      const result = directory.resolve({ agentName: 'Cross' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('ambiguous');
      if (result.reason !== 'ambiguous') throw new Error('unreachable');
      expect(result.message).toBe(
        `Multiple agents match name "Cross": Cross (t1), Cross (e1). Use agentId to specify.`,
      );
      const candidates: AgentDirectoryEntry[] = [
        { kind: 'terminal', agent: terminal },
        { kind: 'embedded', agent: embedded },
      ];
      expect(result.candidates).toEqual(candidates);
    });
  });

  describe('resolve with neither agentId nor agentName', () => {
    it('returns the defensive not-found fallback', () => {
      const directory = new AgentDirectory({
        terminal: makeFakeTerminalSurface([]),
        embedded: makeFakeEmbeddedSurface([]),
      });

      const result = directory.resolve({});
      expect(result).toEqual({
        ok: false,
        reason: 'not-found',
        message: 'No agent reference provided (agentId or agentName required)',
      });
    });
  });
});
