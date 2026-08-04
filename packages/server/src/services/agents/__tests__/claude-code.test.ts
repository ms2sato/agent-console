import { describe, it, expect } from 'bun:test';
import { expandTemplate } from '../../../lib/template.js';
import { claudeCodeAgent } from '../claude-code.js';

describe('claudeCodeAgent.commandTemplate', () => {
  it('should use the {{model:+--model}}{{prompt}} optional-argument form', () => {
    expect(claudeCodeAgent.commandTemplate).toBe('claude {{model:+--model}}{{prompt}}');
  });

  it('should leave continueTemplate and headlessTemplate unaffected by the model optional-argument change', () => {
    expect(claudeCodeAgent.continueTemplate).toBe('claude -c');
    expect(claudeCodeAgent.headlessTemplate).toBe('claude -p --output-format text {{prompt}}');
  });

  it('should expand to a command byte-identical to the pre-#1281 template when templateVars has no model', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.commandTemplate,
      prompt: 'do the task',
      cwd: '/repo',
    });

    // Pre-#1281 the template was 'claude {{prompt}}'; its expansion is the
    // byte-identity contract this delegate_to_worktree callers without
    // templateVars.model must keep getting.
    expect(result.command).toBe("claude 'do the task'");
  });

  it('should include --model <value> in the expanded command when templateVars provides a model', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.commandTemplate,
      prompt: 'do the task',
      cwd: '/repo',
      templateVars: { model: 'claude-sonnet-5' },
    });

    expect(result.command).toBe("claude --model 'claude-sonnet-5' 'do the task'");
  });
});
