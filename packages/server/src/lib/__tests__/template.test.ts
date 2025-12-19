import { describe, it, expect } from 'bun:test';
import {
  expandTemplate,
  getPromptEnvVar,
  TemplateExpansionError,
} from '../template.js';

describe('expandTemplate', () => {
  describe('basic expansion', () => {
    it('should expand {{prompt}} placeholder with environment variable reference', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Hello World',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('Hello World');
    });

    it('should expand {{cwd}} placeholder with shell-escaped path', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/path/to/repo',
      });

      // cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/path/to/repo' && run \"$__AGENT_PROMPT__\"");
      expect(result.env.__AGENT_PROMPT__).toBe('test');
    });

    it('should expand both {{prompt}} and {{cwd}} placeholders', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && test-cli {{prompt}}',
        prompt: 'my task',
        cwd: '/workspace',
      });

      // cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/workspace' && test-cli \"$__AGENT_PROMPT__\"");
      expect(result.env.__AGENT_PROMPT__).toBe('my task');
    });

    it('should handle multiple {{prompt}} placeholders', () => {
      const result = expandTemplate({
        template: 'cmd {{prompt}} --extra {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).toBe('cmd "$__AGENT_PROMPT__" --extra "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('test');
    });

    it('should handle multiple {{cwd}} placeholders', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && ls {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      // Each cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/repo' && ls '/repo' && run \"$__AGENT_PROMPT__\"");
      expect(result.env.__AGENT_PROMPT__).toBe('test');
    });
  });

  describe('templates without {{prompt}}', () => {
    it('should work without {{prompt}} placeholder when no prompt provided', () => {
      const result = expandTemplate({
        template: 'test-cli --continue',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli --continue');
      expect(result.env).toEqual({});
    });

    it('should expand {{cwd}} even without {{prompt}}', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && test-cli --continue',
        cwd: '/path/to/repo',
      });

      // cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/path/to/repo' && test-cli --continue");
      expect(result.env).toEqual({});
    });
  });

  describe('error handling', () => {
    it('should throw error for empty template', () => {
      expect(() =>
        expandTemplate({
          template: '',
          prompt: 'test',
          cwd: '/repo',
        })
      ).toThrow(TemplateExpansionError);
    });

    it('should throw error for whitespace-only template', () => {
      expect(() =>
        expandTemplate({
          template: '   ',
          prompt: 'test',
          cwd: '/repo',
        })
      ).toThrow(TemplateExpansionError);
    });
  });

  describe('no prompt provided', () => {
    it('should expand {{prompt}} with empty string when no prompt provided', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('');
    });

    it('should allow starting agents interactively without initial prompt', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: undefined,
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('');
    });
  });

  describe('special characters in prompt', () => {
    it('should safely handle prompts with shell metacharacters', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'test; rm -rf /',
        cwd: '/repo',
      });

      // The prompt is passed via environment variable, so special characters are safe
      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('test; rm -rf /');
    });

    it('should safely handle prompts with quotes', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Say "hello" and \'goodbye\'',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('Say "hello" and \'goodbye\'');
    });

    it('should safely handle prompts with newlines', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Line 1\nLine 2\nLine 3',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should safely handle prompts with dollar signs', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: '$HOME and $(whoami)',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli "$__AGENT_PROMPT__"');
      expect(result.env.__AGENT_PROMPT__).toBe('$HOME and $(whoami)');
    });
  });

  describe('path handling', () => {
    it('should handle paths with spaces in {{cwd}}', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/path/with spaces/repo',
      });

      // Paths with spaces are safely handled by single-quoting
      expect(result.command).toBe("cd '/path/with spaces/repo' && run \"$__AGENT_PROMPT__\"");
      expect(result.env.__AGENT_PROMPT__).toBe('test');
    });

    it('should handle paths with special characters', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: "/path/with'quote/repo",
      });

      // Single quotes in paths are escaped using the '\'' technique
      expect(result.command).toBe("cd '/path/with'\\''quote/repo' && run \"$__AGENT_PROMPT__\"");
      expect(result.env.__AGENT_PROMPT__).toBe('test');
    });
  });
});

describe('getPromptEnvVar', () => {
  it('should return the environment variable name used for prompts', () => {
    expect(getPromptEnvVar()).toBe('__AGENT_PROMPT__');
  });
});

describe('TemplateExpansionError', () => {
  it('should be instance of Error', () => {
    const error = new TemplateExpansionError('test message');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct name', () => {
    const error = new TemplateExpansionError('test message');
    expect(error.name).toBe('TemplateExpansionError');
  });

  it('should have correct message', () => {
    const error = new TemplateExpansionError('test message');
    expect(error.message).toBe('test message');
  });
});
