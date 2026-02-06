// Import types for local use
import type { AgentActivityPatterns, AgentCapabilities } from '../schemas/agent.js';

// Re-export schema-derived types
export type {
  AgentActivityPatterns,
  AgentCapabilities,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '../schemas/agent.js';

// === AgentType Definition ===

/**
 * Single Source of Truth for agent types.
 * Maps agent type identifiers to their human-readable labels.
 * Add new agent types here - the type and array are derived from this object.
 */
export const AGENT_TYPE_LABELS = {
  'claude-code': 'Claude Code',
  'gemini': 'Gemini CLI',
  'codex': 'Codex CLI',
  'unknown': 'Unknown',
} as const;

/**
 * Agent type identifier - identifies the underlying CLI tool.
 * Used to enable agent-specific features (e.g., SDK mode for Claude Code).
 */
export type AgentType = keyof typeof AGENT_TYPE_LABELS;

/**
 * Array of all valid agent types. Derived from AGENT_TYPE_LABELS.
 */
export const AGENT_TYPES = Object.keys(AGENT_TYPE_LABELS) as AgentType[];

/**
 * Default agent type for custom agents when not specified.
 */
export const DEFAULT_AGENT_TYPE: AgentType = 'unknown';

/**
 * Agent definition - stored and managed by AgentManager
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  isBuiltIn: boolean;
  createdAt: string;

  /**
   * Agent type identifier - identifies the underlying CLI tool.
   * Used to enable agent-specific features (e.g., SDK mode for Claude Code).
   * Optional for backward compatibility - defaults to 'unknown' at persistence layer.
   */
  agentType?: AgentType;

  // === Templates ===

  /**
   * Command template for starting a new session with initial prompt.
   * REQUIRED.
   *
   * Placeholders:
   *   {{prompt}} - Insert the initial prompt (passed via environment variable)
   *   {{cwd}} - Insert the working directory path
   *
   * Examples:
   *   "claude {{prompt}}"
   *   "aider --yes -m {{prompt}}"
   */
  commandTemplate: string;

  /**
   * Command template for continuing an existing conversation.
   * OPTIONAL. If not set, "Continue" button is disabled for this agent.
   *
   * Placeholders:
   *   {{cwd}} - Insert the working directory path (if needed)
   *
   * Examples:
   *   "claude -c"
   *   "aider --yes --restore-chat-history"
   */
  continueTemplate?: string;

  /**
   * Command template for headless (non-interactive) execution.
   * Used for metadata generation (branch name, title suggestion).
   * OPTIONAL. If not set, automatic metadata generation is skipped.
   *
   * Placeholders:
   *   {{prompt}} - Insert the prompt (passed via environment variable)
   *   {{cwd}} - Insert the working directory path (if needed)
   *
   * Examples:
   *   "claude -p --output-format text {{prompt}}"
   *   "aider --yes -m {{prompt}} --exit"
   */
  headlessTemplate?: string;

  // === Activity Detection (Optional) ===

  /**
   * Patterns to detect when agent is waiting for user input.
   * OPTIONAL. If not set, agent state is limited to idle/working only.
   */
  activityPatterns?: AgentActivityPatterns;

  // === Computed (read-only, set by server) ===

  /**
   * Capability flags computed from templates.
   * Clients use these to enable/disable UI features.
   */
  capabilities: AgentCapabilities;
}

/**
 * Compute capability flags from agent templates
 */
export function computeCapabilities(
  agent: Omit<AgentDefinition, 'capabilities'>
): AgentCapabilities {
  return {
    // Template must be non-empty string after trim
    supportsContinue: Boolean(agent.continueTemplate?.trim()),
    supportsHeadlessMode: Boolean(agent.headlessTemplate?.trim()),
    // Must have at least one non-empty pattern
    supportsActivityDetection: Boolean(
      agent.activityPatterns?.askingPatterns?.some((p) => p.trim().length > 0)
    ),
  };
}
