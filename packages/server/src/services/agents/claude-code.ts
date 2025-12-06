/**
 * Claude Code built-in agent definition
 *
 * All Claude Code specific configuration is centralized here.
 */
import type { AgentDefinition } from '@agent-console/shared';

export const CLAUDE_CODE_AGENT_ID = 'claude-code-builtin';

/**
 * Claude Code specific asking patterns for activity detection
 * These patterns indicate when Claude is waiting for user input
 */
const ASKING_PATTERNS: string[] = [
  // Selection menu footer (most reliable - appears on all permission prompts)
  'Enter to select.*Tab.*navigate.*Esc to cancel',

  // Permission prompts - Claude Code style
  'Do you want to.*\\?',              // "Do you want to create/edit/run..." prompts
  '\\[y\\].*\\[n\\]',                 // Yes/No selection
  '\\[a\\].*always',                  // Always allow option
  'Allow.*\\?',                       // "Allow X?" prompts

  // AskUserQuestion patterns
  '\\[A\\].*\\[B\\]',                 // A/B selection
  '\\[1\\].*\\[2\\]',                 // Numbered selection

  // Selection box with prompt
  '╰─+╯\\s*>\\s*$',                   // Box bottom + prompt
];

/**
 * Claude Code agent definition
 */
export const claudeCodeAgent: AgentDefinition = {
  id: CLAUDE_CODE_AGENT_ID,
  name: 'Claude Code',
  command: 'claude',
  description: 'Anthropic Claude Code - Interactive AI coding assistant',
  icon: 'terminal',
  isBuiltIn: true,
  registeredAt: new Date(0).toISOString(), // Epoch time for built-in
  activityPatterns: {
    askingPatterns: ASKING_PATTERNS,
  },
  continueArgs: ['-c'],
};
