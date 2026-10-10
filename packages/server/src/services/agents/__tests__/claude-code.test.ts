import { describe, it, expect } from 'bun:test';
import { expandTemplate } from '../../../lib/template.js';
import { claudeCodeAgent } from '../claude-code.js';

describe('claudeCodeAgent.commandTemplate', () => {
  it('should use the {{model:+--model}}{{conversationId:+--session-id}}{{prompt}} optional-argument form', () => {
    expect(claudeCodeAgent.commandTemplate).toBe(
      'claude {{model:+--model}}{{conversationId:+--session-id}}{{prompt}}',
    );
  });

  it('should leave headlessTemplate unaffected by the model optional-argument change', () => {
    expect(claudeCodeAgent.headlessTemplate).toBe('claude -p --output-format text {{prompt}}');
  });

  it('should expand to a command byte-identical to the pre-#1281 template when templateVars has neither model nor conversationId', () => {
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

  it('should include --session-id <id> in the expanded command when templateVars provides a conversationId', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.commandTemplate,
      prompt: 'do the task',
      cwd: '/repo',
      templateVars: { conversationId: 'some-uuid' },
    });

    expect(result.command).toBe("claude --session-id 'some-uuid' 'do the task'");
  });

  it('should include both --model and --session-id, in that order, when both templateVars are provided', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.commandTemplate,
      prompt: 'do the task',
      cwd: '/repo',
      templateVars: { model: 'claude-sonnet-5', conversationId: 'some-uuid' },
    });

    expect(result.command).toBe("claude --model 'claude-sonnet-5' --session-id 'some-uuid' 'do the task'");
  });
});

// Issue #1299 PR-2: continueTemplate gained the same {{model:+--model}}
// optional-argument form commandTemplate already had, so a worker-level
// model override (agent-surface.md Ruling 3) survives on the continue path
// too, not only on fresh/deliver activations. Mirrors the commandTemplate
// byte-identity + model-substitution pair above, against
// claudeCodeAgent.continueTemplate specifically via expandTemplate -- an
// executable pin, not only the literal-string assertion below.
//
// A worker's console-minted conversation id lets `claude --resume <id>`
// continue that worker's own conversation deterministically instead of
// `claude`'s directory-scoped `-c`. A worker that has never had a fresh
// (non-continue) activation has no id yet and falls back to the literal
// `-c` via the always-shell-escaped {{continueFallback}} form -- the
// template renders it as `claude '-c'` (quoted), not an unescaped
// `claude -c`.
describe('claudeCodeAgent.continueTemplate', () => {
  it('should use the {{model:+--model}}{{conversationId:+--resume}}{{continueFallback}} optional-argument form', () => {
    expect(claudeCodeAgent.continueTemplate).toBe(
      'claude {{model:+--model}}{{conversationId:+--resume}}{{continueFallback}}',
    );
  });

  it('should expand to exactly "claude \'-c\'" when templateVars has no model, no conversationId, and a continueFallback (legacy worker with no minted id)', () => {
    const result = expandTemplate({
      // continueTemplate is optional on AgentDefinition in general, but the
      // builtin Claude Code agent always declares one (claude-code.ts).
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
      templateVars: { continueFallback: '-c' },
    });

    expect(result.command).toBe("claude '-c'");
  });

  it('should expand to exactly "claude " (no -c, no --resume) when neither conversationId nor continueFallback is provided', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
    });

    expect(result.command).toBe('claude ');
  });

  it('should include --model <value> ahead of the fallback when templateVars provides a model and continueFallback', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
      templateVars: { model: 'claude-sonnet-5', continueFallback: '-c' },
    });

    expect(result.command).toBe("claude --model 'claude-sonnet-5' '-c'");
  });

  it('should expand to exactly "claude --resume <id>" when templateVars provides a conversationId', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
      templateVars: { conversationId: 'some-uuid' },
    });

    // {{conversationId:+--resume}} expands with its own trailing space (the
    // optional-argument form's contract); {{continueFallback}} then
    // collapses to the empty string since it has no value, leaving that
    // trailing space in place.
    expect(result.command).toBe("claude --resume 'some-uuid' ");
  });

  it('should include --model <value> ahead of --resume when templateVars provides both model and conversationId', () => {
    const result = expandTemplate({
      template: claudeCodeAgent.continueTemplate!,
      cwd: '/repo',
      templateVars: { model: 'claude-sonnet-5', conversationId: 'some-uuid' },
    });

    expect(result.command).toBe("claude --model 'claude-sonnet-5' --resume 'some-uuid' ");
  });
});
