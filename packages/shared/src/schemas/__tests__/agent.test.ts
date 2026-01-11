import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  AgentActivityPatternsSchema,
  AgentCapabilitiesSchema,
  AgentDefinitionSchema,
  isSafeRegex,
  isValidRegex,
} from '../agent';

describe('AgentCapabilitiesSchema', () => {
  it('should accept valid capabilities', () => {
    const result = v.safeParse(AgentCapabilitiesSchema, {
      supportsContinue: true,
      supportsHeadlessMode: false,
      supportsActivityDetection: true,
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing fields', () => {
    const result = v.safeParse(AgentCapabilitiesSchema, {
      supportsContinue: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-boolean values', () => {
    const result = v.safeParse(AgentCapabilitiesSchema, {
      supportsContinue: 'yes',
      supportsHeadlessMode: false,
      supportsActivityDetection: true,
    });
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

  it('should reject askingPatterns with invalid regex pattern', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['[invalid regex'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0].message).toContain('valid regular expressions');
    }
  });

  it('should reject if any pattern in askingPatterns is invalid', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['valid.*pattern', '[invalid', '^another$'],
    });
    expect(result.success).toBe(false);
  });

  it('should reject askingPatterns with unclosed parenthesis', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: ['(unclosed parenthesis'],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all valid regex patterns', () => {
    const result = v.safeParse(AgentActivityPatternsSchema, {
      askingPatterns: [
        'Do you want to.*\\?',
        '\\[y\\].*\\[n\\]',
        '^Please confirm:',
        'Enter to select.*to navigate.*Esc to cancel',
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateAgentRequestSchema', () => {
  describe('valid requests', () => {
    it('should validate valid request with required fields only', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.name).toBe('Test Agent');
        expect(result.output.commandTemplate).toBe('test-cli {{prompt}}');
      }
    });

    it('should validate valid request with all fields', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: 'test-cli --continue',
        headlessTemplate: 'test-cli -p {{prompt}}',
        description: 'A test agent',
        activityPatterns: { askingPatterns: ['pattern'] },
      });
      expect(result.success).toBe(true);
    });

    it('should accept commandTemplate with {{cwd}} placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'cd {{cwd}} && test-cli {{prompt}}',
      });
      expect(result.success).toBe(true);
    });

    it('should accept continueTemplate with {{cwd}} placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: 'cd {{cwd}} && test-cli --continue',
      });
      expect(result.success).toBe(true);
    });

    it('should trim whitespace from name', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: '  Test Agent  ',
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.name).toBe('Test Agent');
      }
    });

    it('should trim whitespace from commandTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: '  test-cli {{prompt}}  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.commandTemplate).toBe('test-cli {{prompt}}');
      }
    });
  });

  describe('name validation', () => {
    it('should reject empty name', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: '',
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only name', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: '   ',
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing name', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject number for name field', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 123,
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject null for name field', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: null,
        commandTemplate: 'test-cli {{prompt}}',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('commandTemplate validation', () => {
    it('should reject empty commandTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only commandTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: '   ',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing commandTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate without {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli --interactive',
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate with quoted {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli "{{prompt}}"',
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate with single-quoted {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: "test-cli '{{prompt}}'",
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate with malformed placeholder (spaces inside)', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{ prompt }}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate with leading space in placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{ prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject commandTemplate with trailing space in placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt }}',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('continueTemplate validation', () => {
    it('should reject continueTemplate with {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: 'test-cli --continue {{prompt}}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty continueTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject whitespace-only continueTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: '   ',
      });
      expect(result.success).toBe(false);
    });

    it('should reject continueTemplate with malformed placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        continueTemplate: 'test-cli {{ cwd }}',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('headlessTemplate validation', () => {
    it('should accept headlessTemplate with {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        headlessTemplate: 'test-cli -p {{prompt}}',
      });
      expect(result.success).toBe(true);
    });

    it('should reject headlessTemplate without {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        headlessTemplate: 'test-cli -p',
      });
      expect(result.success).toBe(false);
    });

    it('should reject headlessTemplate with quoted {{prompt}}', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        headlessTemplate: 'test-cli -p "{{prompt}}"',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty headlessTemplate', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        headlessTemplate: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject headlessTemplate with malformed placeholder', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        headlessTemplate: 'test-cli -p {{ prompt }}',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('activityPatterns validation', () => {
    it('should accept valid askingPatterns', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        activityPatterns: {
          askingPatterns: ['Do you want.*\\?', '\\[y\\].*\\[n\\]'],
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.activityPatterns?.askingPatterns).toEqual([
          'Do you want.*\\?',
          '\\[y\\].*\\[n\\]',
        ]);
      }
    });

    it('should reject invalid regex in askingPatterns', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        activityPatterns: {
          askingPatterns: ['[invalid regex'],
        },
      });
      expect(result.success).toBe(false);
    });

    it('should reject if any pattern is invalid', () => {
      const result = v.safeParse(CreateAgentRequestSchema, {
        name: 'Test Agent',
        commandTemplate: 'test-cli {{prompt}}',
        activityPatterns: {
          askingPatterns: ['valid.*', '(unclosed', 'also-valid'],
        },
      });
      expect(result.success).toBe(false);
    });
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

  it('should validate update with commandTemplate only', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      commandTemplate: 'updated-cli {{prompt}}',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.commandTemplate).toBe('updated-cli {{prompt}}');
    }
  });

  it('should validate update with all fields', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: 'Updated Agent',
      commandTemplate: 'updated-cli {{prompt}}',
      continueTemplate: 'updated-cli --continue',
      headlessTemplate: 'updated-cli -p {{prompt}}',
      description: 'Updated description',
      activityPatterns: { askingPatterns: ['new-pattern'] },
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

  it('should reject whitespace-only name', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      name: '   ',
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

  it('should reject empty commandTemplate', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      commandTemplate: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject commandTemplate without {{prompt}}', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      commandTemplate: 'updated-cli',
    });
    expect(result.success).toBe(false);
  });

  it('should allow null for continueTemplate (to clear it)', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      continueTemplate: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.continueTemplate).toBeNull();
    }
  });

  it('should allow null for headlessTemplate (to clear it)', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      headlessTemplate: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.headlessTemplate).toBeNull();
    }
  });

  it('should accept valid askingPatterns in update', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      activityPatterns: {
        askingPatterns: ['Do you want.*\\?', '\\[y\\].*\\[n\\]'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid regex in askingPatterns on update', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      activityPatterns: {
        askingPatterns: ['[invalid regex'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject if any pattern is invalid on update', () => {
    const result = v.safeParse(UpdateAgentRequestSchema, {
      activityPatterns: {
        askingPatterns: ['valid.*', '(unclosed', 'also-valid'],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('isSafeRegex', () => {
  it('should accept normal patterns', () => {
    expect(isSafeRegex('simple')).toEqual({ safe: true });
    expect(isSafeRegex('Do you want.*\\?')).toEqual({ safe: true });
    expect(isSafeRegex('^start.*end$')).toEqual({ safe: true });
    expect(isSafeRegex('\\[y\\].*\\[n\\]')).toEqual({ safe: true });
  });

  it('should reject patterns that are too long', () => {
    const longPattern = 'a'.repeat(501);
    const result = isSafeRegex(longPattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('too long');
  });

  it('should accept patterns at exactly max length', () => {
    const maxLengthPattern = 'a'.repeat(500);
    expect(isSafeRegex(maxLengthPattern)).toEqual({ safe: true });
  });

  it('should reject nested quantifiers like (a+)+', () => {
    const result = isSafeRegex('(a+)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject nested quantifiers like (a*)*', () => {
    const result = isSafeRegex('(a*)*');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject nested quantifiers like (a+)*', () => {
    const result = isSafeRegex('(a+)*');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject nested quantifiers with more complex patterns', () => {
    const result = isSafeRegex('(foo.*bar+)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject alternation with quantifiers like (a|b)+', () => {
    const result = isSafeRegex('(a|b)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject alternation with quantifiers like (foo|bar)*', () => {
    const result = isSafeRegex('(foo|bar)*');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should accept non-capturing groups without nested quantifiers', () => {
    expect(isSafeRegex('(?:abc)+')).toEqual({ safe: true });
    expect(isSafeRegex('(?:a|b|c)')).toEqual({ safe: true });
  });

  it('should accept simple alternation without quantifiers', () => {
    expect(isSafeRegex('a|b|c')).toEqual({ safe: true });
    expect(isSafeRegex('(foo|bar)')).toEqual({ safe: true });
  });

  it('should reject non-capturing groups with nested quantifiers', () => {
    const result1 = isSafeRegex('(?:a+)+');
    expect(result1.safe).toBe(false);
    expect(result1.reason).toContain('dangerous nested quantifiers');

    const result2 = isSafeRegex('(?:a*)*');
    expect(result2.safe).toBe(false);
    expect(result2.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject non-capturing groups with alternation and outer quantifier', () => {
    const result = isSafeRegex('(?:a|b)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject ECMAScript named groups with nested quantifiers', () => {
    const result = isSafeRegex('(?<name>a+)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });

  it('should reject ECMAScript named groups with alternation', () => {
    const result = isSafeRegex('(?<n>a|b)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('dangerous nested quantifiers');
  });
});

describe('isValidRegex', () => {
  it('should return valid for valid safe patterns', () => {
    expect(isValidRegex('simple')).toEqual({ valid: true });
    expect(isValidRegex('^start.*end$')).toEqual({ valid: true });
  });

  it('should return invalid for syntactically invalid patterns', () => {
    const result = isValidRegex('[invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return invalid for unsafe patterns (ReDoS)', () => {
    const result = isValidRegex('(a+)+');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('dangerous');
  });

  it('should return invalid for patterns that are too long', () => {
    const longPattern = 'a'.repeat(501);
    const result = isValidRegex(longPattern);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too long');
  });
});

describe('AgentDefinitionSchema', () => {
  const validAgent = {
    id: 'agent-123',
    name: 'Test Agent',
    commandTemplate: 'test-cli {{prompt}}',
    isBuiltIn: false,
    createdAt: '2024-01-01T00:00:00Z',
    capabilities: {
      supportsContinue: false,
      supportsHeadlessMode: false,
      supportsActivityDetection: false,
    },
  };

  it('should validate valid agent definition', () => {
    const result = v.safeParse(AgentDefinitionSchema, validAgent);
    expect(result.success).toBe(true);
  });

  it('should validate agent with all optional fields', () => {
    const fullAgent = {
      ...validAgent,
      continueTemplate: 'test-cli --continue',
      headlessTemplate: 'test-cli -p {{prompt}}',
      description: 'A test agent',
      activityPatterns: {
        askingPatterns: ['Do you want.*\\?'],
      },
    };
    const result = v.safeParse(AgentDefinitionSchema, fullAgent);
    expect(result.success).toBe(true);
  });

  it('should reject agent with empty id', () => {
    const result = v.safeParse(AgentDefinitionSchema, { ...validAgent, id: '' });
    expect(result.success).toBe(false);
  });

  it('should reject agent with empty name', () => {
    const result = v.safeParse(AgentDefinitionSchema, { ...validAgent, name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject agent with commandTemplate missing {{prompt}}', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      commandTemplate: 'test-cli --interactive',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with quoted {{prompt}} in commandTemplate', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      commandTemplate: 'test-cli "{{prompt}}"',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with malformed placeholder in commandTemplate', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      commandTemplate: 'test-cli {{ prompt }}',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with headlessTemplate missing {{prompt}}', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      headlessTemplate: 'test-cli --headless',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with continueTemplate containing {{prompt}}', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      continueTemplate: 'test-cli {{prompt}} --continue',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with invalid regex in askingPatterns', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      activityPatterns: {
        askingPatterns: ['[invalid regex'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with ReDoS vulnerable pattern in askingPatterns', () => {
    const result = v.safeParse(AgentDefinitionSchema, {
      ...validAgent,
      activityPatterns: {
        askingPatterns: ['(a+)+'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent with missing capabilities', () => {
    const { capabilities, ...agentWithoutCapabilities } = validAgent;
    const result = v.safeParse(AgentDefinitionSchema, agentWithoutCapabilities);
    expect(result.success).toBe(false);
  });

  it('should reject agent with missing isBuiltIn', () => {
    const { isBuiltIn, ...agentWithoutIsBuiltIn } = validAgent;
    const result = v.safeParse(AgentDefinitionSchema, agentWithoutIsBuiltIn);
    expect(result.success).toBe(false);
  });

  it('should reject agent with missing createdAt', () => {
    const { createdAt, ...agentWithoutCreatedAt } = validAgent;
    const result = v.safeParse(AgentDefinitionSchema, agentWithoutCreatedAt);
    expect(result.success).toBe(false);
  });
});
