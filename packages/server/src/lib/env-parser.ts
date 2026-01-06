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
