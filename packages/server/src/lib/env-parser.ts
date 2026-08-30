/**
 * Parse .env format string into key-value pairs.
 *
 * Supports:
 * - KEY=value format
 * - Comments starting with #
 * - Empty lines (skipped)
 * - Quoted values (single or double quotes)
 * - Inline comments after unquoted values
 * - Values with = in them
 *
 * @param envVarsText - Environment variables in .env format
 * @returns Record of key-value pairs
 */
export function parseEnvVars(envVarsText: string | null | undefined): Record<string, string> {
  if (!envVarsText) {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = envVarsText.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    // Find the first = to split key and value
    const equalIndex = trimmedLine.indexOf('=');
    if (equalIndex === -1) {
      // No = found, skip this line
      continue;
    }

    const key = trimmedLine.substring(0, equalIndex).trim();
    if (key === '') {
      // Empty key, skip this line
      continue;
    }

    let value = trimmedLine.substring(equalIndex + 1);

    // Handle quoted values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      // Remove surrounding quotes
      value = value.slice(1, -1);
    } else {
      // For unquoted values, trim whitespace and remove inline comments
      value = value.trim();
      const commentIndex = value.indexOf('#');
      if (commentIndex !== -1) {
        value = value.substring(0, commentIndex).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Parse an optional boolean environment variable value.
 * - undefined or '' -> undefined (unset)
 * - 'true' -> true
 * - 'false' -> false
 * - anything else -> throws (fail-fast) with a generic, variable-name-agnostic message
 *
 * Callers that know the variable name should catch and re-throw with that context.
 */
export function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`Expected 'true', 'false', or unset, got: '${raw}'`);
}

/**
 * Parse an integer environment variable value, falling back to `defaultValue`
 * when it is unset, empty, or not a number.
 *
 * The NaN fallback is the point: `parseInt('thirty')` is `NaN`, and a `NaN`
 * threshold compares false against every bound, so a typo would silently
 * behave like the feature's disabled value rather than like a mistake. Callers
 * that DO want a disabled state must express it with a real value (e.g. `0`),
 * not by mistyping one.
 */
export function parseIntWithDefault(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Like `parseIntWithDefault`, but also rejects zero and negatives.
 *
 * Sits here rather than beside its one caller because `parseIntWithDefault` is
 * already this file's answer to "read an integer from the environment", and a
 * second reader elsewhere would be a second writer of the same rule.
 *
 * The stricter form exists for values used as CEILINGS. `NaN` is the loud
 * case only in name: every comparison with it is false, so a bound written as
 * `total + next > cap` stops firing rather than failing, and nothing reports
 * it. A non-positive value survives a finiteness check and then makes the
 * first candidate exceed the bound, which fails in the other direction just as
 * quietly.
 */
export function parsePositiveIntWithDefault(raw: string | undefined, defaultValue: number): number {
  const parsed = parseIntWithDefault(raw, defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
