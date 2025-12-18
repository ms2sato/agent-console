/**
 * Template expansion utilities for agent commands
 */

const PROMPT_ENV_VAR = '__AGENT_PROMPT__';

export type ExpandTemplateOptions = {
  template: string;
  prompt?: string;
  cwd: string;
};

export type ExpandTemplateResult = {
  command: string;
  env: Record<string, string>;
};

/**
 * Error thrown when template expansion fails
 */
export class TemplateExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateExpansionError';
  }
}

/**
 * Expand a command template by replacing placeholders
 *
 * Placeholders:
 * - {{prompt}} - Replaced with environment variable reference (safe from injection)
 * - {{cwd}} - Replaced with the working directory path (direct substitution)
 *
 * @param options - Template expansion options
 * @returns The expanded command and environment variables
 * @throws {TemplateExpansionError} If template is empty or expansion fails
 */
export function expandTemplate(options: ExpandTemplateOptions): ExpandTemplateResult {
  const { template, prompt, cwd } = options;

  if (!template || template.trim().length === 0) {
    throw new TemplateExpansionError('Template is empty');
  }

  let command = template;
  const env: Record<string, string> = {};

  // Expand {{cwd}} - direct substitution (safe, not user input)
  if (command.includes('{{cwd}}')) {
    command = command.replace(/\{\{cwd\}\}/g, cwd);
  }

  // Expand {{prompt}} - via environment variable (user input, must be protected)
  // When no prompt is provided, the placeholder is replaced with an empty string
  // This allows starting agents interactively without a pre-filled prompt
  if (command.includes('{{prompt}}')) {
    command = command.replace(/\{\{prompt\}\}/g, `"$${PROMPT_ENV_VAR}"`);
    env[PROMPT_ENV_VAR] = prompt ?? '';
  }

  // Validate result is non-empty
  if (!command.trim()) {
    throw new TemplateExpansionError('Template expansion resulted in empty command');
  }

  return { command, env };
}

/**
 * Get the environment variable name used for prompt injection
 */
export function getPromptEnvVar(): string {
  return PROMPT_ENV_VAR;
}
