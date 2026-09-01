import type { AgentDefinition } from './agent.js';

/**
 * Whether a terminal agent's commandTemplate consumes the {{model...}} /
 * {{effort...}} template variables. SINGLE derivation site (Ruling 1,
 * docs/design/agent-surface.md "Model & Reasoning-Effort Parameters") --
 * every consumer (UI, tool validation) calls this; nothing else scans
 * commandTemplate for these substrings.
 *
 * Terminal-only for Phase 1. Phase 2 (embedded agents) widens this to a
 * kind-discriminated union input (AgentDirectoryEntry) with a per-engine
 * capability table for the 'embedded' branch -- do not invent that branch
 * now.
 */
export interface AgentParameterCapabilities {
  model: boolean;
  reasoningEffort: boolean;
}

// Boundary-precise: matches {{model}}, {{model:default}}, {{model:+prefix}}
// but NOT {{modelFoo...}} (a differently-named variable that happens to
// start with the same substring). Mirrors template.ts's \w+ variable-name
// grammar.
const MODEL_VAR_PATTERN = /\{\{model(?::|\})/;
const REASONING_EFFORT_VAR_PATTERN = /\{\{effort(?::|\})/;

export function getAgentParameterCapabilities(agent: AgentDefinition): AgentParameterCapabilities {
  return {
    model: MODEL_VAR_PATTERN.test(agent.commandTemplate),
    reasoningEffort: REASONING_EFFORT_VAR_PATTERN.test(agent.commandTemplate),
  };
}

/**
 * Wire-name -> template-var-key mapping (Ruling 2's "reasoningEffort" wire
 * field populates the {{effort...}} template var, not {{reasoningEffort...}}).
 * Single writer for that mapping fact -- server code must use this, not
 * hardcode the 'effort' key inline.
 */
export function buildAgentParameterTemplateVars(params: {
  model?: string | null;
  reasoningEffort?: string | null;
}): Record<string, string> {
  const vars: Record<string, string> = {};
  if (params.model) vars.model = params.model;
  if (params.reasoningEffort) vars.effort = params.reasoningEffort;
  return vars;
}
