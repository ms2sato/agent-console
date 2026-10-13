import { describe, it, expect } from 'bun:test';
import { computeCapabilities } from '../agent-capabilities.js';
import type { AgentDefinition } from '../../schemas/agent.js';

type AgentBase = Omit<AgentDefinition, 'capabilities'>;

function agent(overrides: Partial<AgentBase> = {}): AgentBase {
  return {
    id: 'a1',
    name: 'Agent',
    isBuiltIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    commandTemplate: 'run {{prompt}}',
    ...overrides,
  };
}

describe('computeCapabilities', () => {
  it('reports every capability false for an agent with only the required command template', () => {
    expect(computeCapabilities(agent())).toEqual({
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    });
  });

  describe.each([
    ['continueTemplate', 'supportsContinue'],
    ['headlessTemplate', 'supportsHeadlessMode'],
  ] as const)('%s -> %s', (field, flag) => {
    it('is false for an empty template', () => {
      expect(computeCapabilities(agent({ [field]: '' }))[flag]).toBe(false);
    });

    it('is false for a whitespace-only template', () => {
      expect(computeCapabilities(agent({ [field]: '   \t\n ' }))[flag]).toBe(false);
    });

    it('is true for a non-empty template, including one with surrounding whitespace', () => {
      expect(computeCapabilities(agent({ [field]: 'claude -c' }))[flag]).toBe(true);
      expect(computeCapabilities(agent({ [field]: '  claude -c  ' }))[flag]).toBe(true);
    });

    it('does not move the other flags', () => {
      const result = computeCapabilities(agent({ [field]: 'x' }));
      const others = Object.entries(result).filter(([key]) => key !== flag);
      expect(others.every(([, value]) => value === false)).toBe(true);
    });
  });

  describe('activityPatterns.askingPatterns -> supportsActivityDetection', () => {
    it('is false when activityPatterns is absent', () => {
      expect(computeCapabilities(agent()).supportsActivityDetection).toBe(false);
    });

    it('is false for an empty pattern list (no element: the vacuous some() case)', () => {
      expect(computeCapabilities(agent({ activityPatterns: { askingPatterns: [] } })).supportsActivityDetection).toBe(false);
    });

    it('is false when every pattern is empty or whitespace-only', () => {
      expect(computeCapabilities(agent({ activityPatterns: { askingPatterns: [' '] } })).supportsActivityDetection).toBe(false);
      expect(computeCapabilities(agent({ activityPatterns: { askingPatterns: ['', '  '] } })).supportsActivityDetection).toBe(false);
    });

    it('is true as soon as one pattern is non-empty (mixed list)', () => {
      expect(computeCapabilities(agent({ activityPatterns: { askingPatterns: ['x'] } })).supportsActivityDetection).toBe(true);
      expect(computeCapabilities(agent({ activityPatterns: { askingPatterns: [' ', 'x'] } })).supportsActivityDetection).toBe(true);
    });
  });

  it('computes all three flags independently from one agent', () => {
    expect(
      computeCapabilities(
        agent({
          continueTemplate: 'claude -c',
          headlessTemplate: ' ',
          activityPatterns: { askingPatterns: ['Do you want'] },
        })
      )
    ).toEqual({ supportsContinue: true, supportsHeadlessMode: false, supportsActivityDetection: true });
  });
});
