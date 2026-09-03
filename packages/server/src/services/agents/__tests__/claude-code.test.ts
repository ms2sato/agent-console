import { describe, it, expect } from 'bun:test';
import { expandTemplate } from '../../../lib/template.js';
import { claudeCodeAgent } from '../claude-code.js';

describe('claudeCodeAgent.commandTemplate', () => {
  it('should use the {{model:+--model}}{{prompt}} optional-argument form', () => {
    expect(claudeCodeAgent.commandTemplate).toBe('claude {{model:+--model}}{{prompt}}');
  });

  it('should leave headlessTemplate unaffected by the model optional-argument change', () => {
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

// Issue #1299 PR-2: continueTemplate gained the same {{model:+--model}}
// optional-argument form commandTemplate already had, so a worker-level
// model override (agent-surface.md Ruling 3) survives on the continue path
// too, not only on fresh/deliver activations. Mirrors the commandTemplate
// byte-identity + model-substitution pair above, against
// claudeCodeAgent.continueTemplate specifically via expandTemplate -- an
// executable pin, not only the literal-string assertion below.
describe('claudeCodeAgent.continueTemplate', () => {
  it('should use the {{model:+--model}}-c optional-argument form', () => {
    expect(claudeCodeAgent.continueTemplate).toBe('claude {{model:+--model}}-c');
  });

  it('should expand to exactly "claude -c" when templateVars has no model', () => {
    const result = expandTemplate({
      // continueTemplate is optional on AgentDefinition in general, but the
      // builtin Claude Code agent always declares one (claude-code.ts).
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
    });

    expect(result.command).toBe('claude -c');
  });

  it('should include --model <value> ahead of -c when templateVars provides a model', () => {
    const result = expandTemplate({
      // continueTemplate is optional on AgentDefinition in general, but the
      // builtin Claude Code agent always declares one (claude-code.ts).
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
      templateVars: { model: 'claude-sonnet-5' },
    });

    expect(result.command).toBe("claude --model 'claude-sonnet-5' -c");
  });
});
