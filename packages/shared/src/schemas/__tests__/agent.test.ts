import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  AgentActivityPatternsSchema,
  InitialPromptModeSchema,
} from '../agent';

describe('InitialPromptModeSchema', () => {
  it('should accept "stdin"', () => {
    const result = v.safeParse(InitialPromptModeSchema, 'stdin');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe('stdin');
    }
  });

  it('should accept "arg"', () => {
    const result = v.safeParse(InitialPromptModeSchema, 'arg');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe('arg');
    }
  });

  it('should reject invalid value', () => {
    const result = v.safeParse(InitialPromptModeSchema, 'invalid');
    expect(result.success).toBe(false);
  });
});

describe('AgentActivityPatternsSchema', () => {
  it('should accept empty object', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {});
    expect(result.success).toBe(true);
  });

  it('should accept object with askingPatterns', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['pattern1', 'pattern2'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.askingPatterns).toEqual(['pattern1', 'pattern2']);
    }
  });

  it('should accept empty askingPatterns array', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-array askingPatterns', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });

  it('should reject askingPatterns array with non-string elements', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['valid', 123, 'also-valid'],
    });
    expect(result.success).toBe(false);
  });

  it('should reject askingPatterns array with null elements', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['valid', null],
    });
    expect(result.success).toBe(false);
  });

  it('should reject askingPatterns array with object elements', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['valid', { pattern: 'test' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateAgentRequestSchema', () => {
  it('should validate valid request with required fields only', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('Test Agent');
      expect(result.output.command).toBe('/bin/agent');
    }
  });

  it('should validate valid request with all fields', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      description: 'A test agent',
      icon: 'icon.png',
      activityPatterns: { askingPatterns: ['pattern'] },
      continueArgs: ['--continue'],
      initialPromptMode: 'stdin',
      initialPromptDelayMs: 100,
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: '',
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty command', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only name', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: '   ',
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only command', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should trim whitespace from name', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: '  Test Agent  ',
      command: '/bin/agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('Test Agent');
    }
  });

  it('should trim whitespace from command', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '  /bin/agent  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.command).toBe('/bin/agent');
    }
  });

  it('should reject missing name', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing command', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative initialPromptDelayMs', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      initialPromptDelayMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer initialPromptDelayMs', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      initialPromptDelayMs: 100.5,
    });
    expect(result.success).toBe(false);
  });

  it('should accept zero initialPromptDelayMs', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      initialPromptDelayMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid initialPromptMode', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      initialPromptMode: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  // Type mismatch tests
  it('should reject number for name field', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 123,
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for command field', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: 456,
    });
    expect(result.success).toBe(false);
  });

  it('should reject object for name field', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: { value: 'Test Agent' },
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject null for name field', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: null,
      command: '/bin/agent',
    });
    expect(result.success).toBe(false);
  });

  // continueArgs array validation
  it('should accept valid continueArgs array', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      continueArgs: ['--continue', '-y'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty continueArgs array', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      continueArgs: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject continueArgs with non-string elements', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      continueArgs: ['--continue', 123],
    });
    expect(result.success).toBe(false);
  });

  it('should reject continueArgs with null elements', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      continueArgs: ['--continue', null],
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-array continueArgs', () => {
    const result = v.safeParse(CreateAgentRequestSchema, {
      name: 'Test Agent',
      command: '/bin/agent',
      continueArgs: '--continue',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateAgentRequestSchema', () => {
  it('should validate update with name only', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: 'Updated Agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('Updated Agent');
    }
  });

  it('should validate update with command only', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      command: '/bin/updated-agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.command).toBe('/bin/updated-agent');
    }
  });

  it('should validate update with all fields', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: 'Updated Agent',
      command: '/bin/updated-agent',
      description: 'Updated description',
      icon: 'new-icon.png',
      activityPatterns: { askingPatterns: ['new-pattern'] },
      continueArgs: ['--new-continue'],
      initialPromptMode: 'arg',
      initialPromptDelayMs: 200,
    });
    expect(result.success).toBe(true);
  });

  it('should validate empty update object', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty command', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      command: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only name', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only command', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      command: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should trim whitespace from name', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: '  Updated Agent  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('Updated Agent');
    }
  });

  it('should trim whitespace from command', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      command: '  /bin/updated-agent  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.command).toBe('/bin/updated-agent');
    }
  });

  it('should reject negative initialPromptDelayMs', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      initialPromptDelayMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer initialPromptDelayMs', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      initialPromptDelayMs: 100.5,
    });
    expect(result.success).toBe(false);
  });
});
