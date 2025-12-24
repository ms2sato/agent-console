import * as v from 'valibot';

// === Regex Validation Utilities ===

/**
 * Maximum allowed length for regex patterns to prevent DoS
 */
const MAX_PATTERN_LENGTH = 500;

/**
 * Patterns that indicate potential ReDoS vulnerability
 * - Nested quantifiers: (a+)+, (a*)+, (a+)*, (?:a+)+, etc.
 * - Overlapping alternation with quantifiers
 *
 * Note: We detect groups via \( optionally followed by \?: or \?<name> for non-capturing/named groups
 */
const REDOS_PATTERNS = [
  // Nested quantifiers in any group type: (a+)+, (?:a+)+, (?<name>a+)+
  /\((?:\?[:<][^)]*)?[^)]*[+*][^)]*\)[+*]/,
  // Alternation with quantifier in any group type: (a|b)+, (?:a|b)+
  /\((?:\?[:<][^)]*)?[^)]*\|[^)]*\)[+*]/,
];

/**
 * Check if a regex pattern is potentially vulnerable to ReDoS
 * @param pattern - The regex pattern to check
 * @returns Object with safe boolean and optional reason
 */
export function isSafeRegex(pattern: string): { safe: boolean; reason?: string } {
  // Check length
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `Pattern too long (max ${MAX_PATTERN_LENGTH} chars)` };
  }

  // Check for dangerous patterns
  for (const dangerous of REDOS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return { safe: false, reason: 'Pattern contains potentially dangerous nested quantifiers' };
    }
  }

  return { safe: true };
}

/**
 * Validate if a string is a valid and safe JavaScript regex
 */
export function isValidRegex(pattern: string): { valid: boolean; error?: string } {
  // First check safety
  const safetyCheck = isSafeRegex(pattern);
  if (!safetyCheck.safe) {
    return { valid: false, error: safetyCheck.reason };
  }

  // Then check if it compiles
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid regex' };
  }
}

/**
 * Validate all patterns are valid JavaScript regex
 */
const askingPatternsValidation = v.pipe(
  v.array(v.string()),
  v.check(
    (patterns) => patterns.every((p) => isValidRegex(p).valid),
    'All asking patterns must be valid regular expressions'
  )
);

/**
 * Agent activity patterns for detection
 */
export const AgentActivityPatternsSchema = v.object({
  askingPatterns: v.optional(askingPatternsValidation),
});

/**
 * Agent capabilities - computed from templates
 */
export const AgentCapabilitiesSchema = v.object({
  supportsContinue: v.boolean(),
  supportsHeadlessMode: v.boolean(),
  supportsActivityDetection: v.boolean(),
});

// === Template Validation Helpers (exported for client reuse) ===

/**
 * Check if {{prompt}} is quoted (which is incorrect)
 */
export const isPromptQuoted = (val: string) =>
  val.includes('"{{prompt}}"') || val.includes("'{{prompt}}'");

/**
 * Detect malformed placeholders with spaces (e.g., {{ prompt }}, {{  cwd}})
 */
export const hasMalformedPlaceholder = (val: string) =>
  /\{\{\s+\w+\s*\}\}|\{\{\s*\w+\s+\}\}/.test(val);

/**
 * Validation for commandTemplate
 * - Must contain {{prompt}}
 * - {{prompt}} must not be quoted
 * - No malformed placeholders
 */
const commandTemplateValidation = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Command template is required'),
  v.custom(
    (val) => !hasMalformedPlaceholder(val as string),
    'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => (val as string).includes('{{prompt}}'),
    'Command template must contain {{prompt}} placeholder'
  ),
  v.custom(
    (val) => !isPromptQuoted(val as string),
    '{{prompt}} should not be quoted - it is automatically wrapped'
  )
);

/**
 * Validation for continueTemplate
 * - Must NOT contain {{prompt}}
 * - No malformed placeholders
 */
const continueTemplateValidation = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Continue template cannot be empty if provided'),
  v.custom(
    (val) => !hasMalformedPlaceholder(val as string),
    'Use exactly {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => !(val as string).includes('{{prompt}}'),
    'Continue template should not contain {{prompt}}'
  )
);

/**
 * Validation for headlessTemplate
 * - Must contain {{prompt}}
 * - {{prompt}} must not be quoted
 * - No malformed placeholders
 */
const headlessTemplateValidation = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Headless template cannot be empty if provided'),
  v.custom(
    (val) => !hasMalformedPlaceholder(val as string),
    'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => (val as string).includes('{{prompt}}'),
    'Headless template must contain {{prompt}} placeholder'
  ),
  v.custom(
    (val) => !isPromptQuoted(val as string),
    '{{prompt}} should not be quoted - it is automatically wrapped'
  )
);

// === Base Schema ===

/**
 * Base schema containing all common agent fields except activityPatterns.
 * This is shared between client form validation and server request validation.
 * Client uses this with string-based askingPatternsInput.
 * Server uses this with array-based activityPatterns.
 */
export const AgentFieldsBaseSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name is required')),
  commandTemplate: commandTemplateValidation,
  continueTemplate: v.optional(continueTemplateValidation),
  headlessTemplate: v.optional(headlessTemplateValidation),
  description: v.optional(v.pipe(v.string(), v.trim())),
});

// === Server Schemas ===

/**
 * Schema for creating a new agent
 */
export const CreateAgentRequestSchema = v.intersect([
  AgentFieldsBaseSchema,
  v.object({
    activityPatterns: v.optional(AgentActivityPatternsSchema),
  }),
]);

/**
 * Schema for updating an existing agent
 */
export const UpdateAgentRequestSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, 'Name cannot be empty'))),
  commandTemplate: v.optional(commandTemplateValidation),
  continueTemplate: v.optional(v.nullable(continueTemplateValidation)),
  headlessTemplate: v.optional(v.nullable(headlessTemplateValidation)),
  description: v.optional(v.pipe(v.string(), v.trim())),
  // Allow null to explicitly clear activityPatterns (PATCH semantics: null = clear, undefined = no change)
  activityPatterns: v.optional(v.nullable(AgentActivityPatternsSchema)),
});

/**
 * Schema for validating persisted AgentDefinition
 * Used to validate agents loaded from storage at startup
 * Uses same template validation as CreateAgentRequestSchema for consistency
 */
export const AgentDefinitionSchema = v.intersect([
  AgentFieldsBaseSchema,
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    isBuiltIn: v.boolean(),
    createdAt: v.string(),
    activityPatterns: v.optional(AgentActivityPatternsSchema),
    capabilities: AgentCapabilitiesSchema,
  }),
]);

// Inferred types from schemas
export type CreateAgentRequest = v.InferOutput<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = v.InferOutput<typeof UpdateAgentRequestSchema>;
export type AgentActivityPatterns = v.InferOutput<typeof AgentActivityPatternsSchema>;
export type AgentCapabilities = v.InferOutput<typeof AgentCapabilitiesSchema>;
