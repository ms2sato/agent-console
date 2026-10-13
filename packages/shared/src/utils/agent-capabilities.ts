import type { AgentCapabilities, AgentDefinition } from '../schemas/agent.js';

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
