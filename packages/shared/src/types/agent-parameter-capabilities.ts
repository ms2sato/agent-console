import type { AgentDefinition } from './agent.js';

/**
 * Whether a terminal agent's commandTemplate consumes the {{model...}} /
 * {{effort...}} template variables. SINGLE derivation site (Ruling 1,
 * docs/design/agent-surface.md "Model & Reasoning-Effort Parameters") --
 * every consumer (UI, tool validation) calls this; nothing else scans
 * commandTemplate for these substrings.
 *
 * Terminal-only. A kind-dispatching consumer that needs to handle both
 * terminal and embedded entries uniformly should call
 * `getAgentParameterCapabilitiesFor` (agent-surface.ts) instead, which
 * spreads this function's result for the terminal branch rather than
 * duplicating it.
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

/**
 * Raw-string primitives behind the two capability checks. Exported so a
 * caller that has already resolved a SPECIFIC template string (e.g. the
 * template actually selected for an activation -- commandTemplate vs
 * continueTemplate) can test that string directly, without re-deriving it
 * from an AgentDefinition. `getAgentParameterCapabilities` below delegates
 * to these so the `{{model` / `{{effort` regex patterns keep exactly one
 * home in the file (see the sibling sweep test).
 */
export function templateSupportsModel(template: string): boolean {
  return MODEL_VAR_PATTERN.test(template);
}

export function templateSupportsReasoningEffort(template: string): boolean {
  return REASONING_EFFORT_VAR_PATTERN.test(template);
}

export function getAgentParameterCapabilities(agent: AgentDefinition): AgentParameterCapabilities {
  return {
    model: templateSupportsModel(agent.commandTemplate),
    reasoningEffort: templateSupportsReasoningEffort(agent.commandTemplate),
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
