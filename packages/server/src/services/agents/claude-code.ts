/**
 * Claude Code built-in agent definition
 *
 * All Claude Code specific configuration is centralized here.
 */
import { type AgentDefinition, computeCapabilities } from '@agent-console/shared';

export const CLAUDE_CODE_AGENT_ID = 'claude-code-builtin';

/**
 * Claude Code specific asking patterns for activity detection
 * These patterns indicate when Claude is waiting for user input
 */
const ASKING_PATTERNS: string[] = [
  // Selection menu footer (most reliable - appears on all permission prompts)
  // Matches both "Enter to select · ↑/↓ to navigate" and "Enter to select, Tab to navigate"
  'Enter to select.*to navigate.*Esc to cancel',

  // Bash command confirmation footer (different format from general prompts)
  // Matches "Esc to cancel · Tab to add additional instructions"
  'Esc to cancel.*Tab to add',

  // Permission prompts - Claude Code style
  'Do you want to.*\\?', // "Do you want to create/edit/run..." prompts
  '\\[y\\].*\\[n\\]', // Yes/No selection
  '\\[a\\].*always', // Always allow option
  'Allow.*\\?', // "Allow X?" prompts

  // AskUserQuestion patterns
  '\\[A\\].*\\[B\\]', // A/B selection
  '\\[1\\].*\\[2\\]', // Numbered selection

  // Numbered selection menu with cursor indicator (permission prompts)
  '❯\\s+\\d+\\.\\s', // "❯ 1. Yes" style selection menu

  // Selection box with prompt
  '╰─+╯\\s*>\\s*$', // Box bottom + prompt
];

/**
 * Claude Code agent definition (without computed capabilities)
 */
const claudeCodeAgentBase = {
  id: CLAUDE_CODE_AGENT_ID,
  name: 'Claude Code',
  commandTemplate: 'claude {{model:+--model}}{{conversationId:+--session-id}}{{prompt}}',
  // {{model:+--model}} expands to '--model <value> ' (trailing space) when a
  // worker-level model override is set, and to the empty string when unset
  // (see agent-surface.md Ruling 3 and worker-manager.ts's per-activation
  // gate at the effectiveTemplateVars merge, which is what makes the
  // continue path honour the override).
  //
  // {{conversationId:+--session-id}} expands to '--session-id <id> '
  // (trailing space) once the worker has a console-minted conversation id
  // (worker-manager.ts mints one on the worker's first fresh activation),
  // giving `claude` an explicit, worker-scoped conversation id instead of
  // letting it infer one from the cwd.
  //
  // {{conversationId:+--resume}} / {{continueFallback}} below are the
  // continue-path twins: once a worker has an id, continuing resumes that
  // exact conversation via `--resume <id>` rather than `claude`'s
  // directory-scoped `-c`, which can attach to a DIFFERENT worker's
  // conversation when two workers share a cwd. A worker that has never had
  // a fresh activation (no id yet) falls back to the old bare `-c` via
  // {{continueFallback}} -- the plain (always-shell-escaped) substitution
  // form, so this renders as `claude '-c'` (quoted), not an unescaped
  // `claude -c`.
  continueTemplate: 'claude {{model:+--model}}{{conversationId:+--resume}}{{continueFallback}}',
  headlessTemplate: 'claude -p --output-format text {{prompt}}',
  description: 'Anthropic Claude Code - Interactive AI coding assistant',
  isBuiltIn: true,
  createdAt: new Date(0).toISOString(), // Epoch time for built-in
  stripScrollbackClear: true,
  activityPatterns: {
    askingPatterns: ASKING_PATTERNS,
  },
} as const;

/**
 * Claude Code agent definition with computed capabilities
 */
export const claudeCodeAgent: AgentDefinition = {
  ...claudeCodeAgentBase,
  capabilities: computeCapabilities(claudeCodeAgentBase),
};
