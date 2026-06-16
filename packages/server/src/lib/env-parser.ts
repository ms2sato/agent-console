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
