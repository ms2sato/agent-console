/**
 * Template expansion utilities for agent commands
 */

/**
 * Escape a string for safe use in shell commands (single-quoted context).
 * This handles paths with special characters safely.
 */
function shellEscape(str: string): string {
  // Escape single quotes by ending the string, adding escaped quote, and restarting
  // e.g., "it's" becomes 'it'\''s'
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

export type ExpandTemplateOptions = {
  template: string;
  prompt?: string;
  cwd: string;
  templateVars?: Record<string, string>;
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
 * - {{prompt}} - Replaced with the shell-escaped prompt string (direct substitution)
 * - {{cwd}} - Replaced with the shell-escaped working directory path (direct substitution)
 *
 * @param options - Template expansion options
 * @returns The expanded command and environment variables
 * @throws {TemplateExpansionError} If template is empty or expansion fails
 */
export function expandTemplate(options: ExpandTemplateOptions): ExpandTemplateResult {
  const { template, prompt, cwd, templateVars } = options;

  if (!template || template.trim().length === 0) {
    throw new TemplateExpansionError('Template is empty');
  }

  let command = template;
  const env: Record<string, string> = {};

  // Expand {{cwd}} - shell-escaped to handle paths with special characters safely
  // Although cwd is validated by validateSessionPath before reaching here,
  // we still escape it as defense-in-depth against shell metacharacter issues
  if (command.includes('{{cwd}}')) {
    command = command.replace(/\{\{cwd\}\}/g, shellEscape(cwd));
  }

  // Expand {{prompt}} - shell-escaped and embedded directly into the command,
  // matching how {{cwd}} and custom {{varName}} placeholders are handled.
  // The historical env-var indirection (via "$__AGENT_PROMPT__") is incompatible
  // with the `sudo -u <user> -i` privilege-elevation path used by runAsUser:
  // sudo wraps the inner command in double quotes when forwarding it to the
  // login shell, which then expands `"$VAR"` against its own (empty)
  // environment before the inner shell sees the command. Direct shell-escaped
  // embedding is injection-safe (single-quote enclosed, embedded single quotes
  // escaped) and works uniformly under elevation. When no prompt is provided,
  // the placeholder is replaced with an empty shell-escaped string, which
  // allows starting agents interactively without a pre-filled prompt.
  // See Issue #851.
  if (command.includes('{{prompt}}')) {
    command = command.replace(/\{\{prompt\}\}/g, shellEscape(prompt ?? ''));
  }

  // Expand custom template variables (after reserved variables are already expanded)
  const RESERVED_VARS = new Set(['prompt', 'cwd']);
  command = command.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (match, varName: string, defaultValue: string | undefined) => {
    if (RESERVED_VARS.has(varName)) {
      return match; // Safety guard: reserved variables should already be expanded
    }
    if (templateVars && Object.prototype.hasOwnProperty.call(templateVars, varName)) {
      return shellEscape(templateVars[varName]);
    }
    if (defaultValue !== undefined) {
      return shellEscape(defaultValue);
    }
    return '';
  });

  // Validate result is non-empty
  if (!command.trim()) {
    throw new TemplateExpansionError('Template expansion resulted in empty command');
  }

  return { command, env };
}
