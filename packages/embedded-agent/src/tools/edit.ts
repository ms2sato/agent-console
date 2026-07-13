/**
 * Builtin `Edit` tool: replaces an exact substring match within an existing
 * file, confined to the session's locationPath. Matching is byte-exact
 * (literal substring search, no regex, no whitespace/line-ending
 * normalization) and the write-back reuses the same atomic
 * temp-file-then-rename sequence as `Write`.
 */

import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';
import { atomicWrite } from './atomic-write.js';

const PREVIEW_MAX_CHARS = 200;

interface EditArgs {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function parseArgs(args: unknown): { ok: true; value: EditArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.file_path !== 'string') {
    return { ok: false, message: 'file_path is required and must be a string' };
  }
  if (typeof a.old_string !== 'string') {
    return { ok: false, message: 'old_string is required and must be a string' };
  }
  if (typeof a.new_string !== 'string') {
    return { ok: false, message: 'new_string is required and must be a string' };
  }
  if (a.replace_all !== undefined && typeof a.replace_all !== 'boolean') {
    return { ok: false, message: 'replace_all must be a boolean' };
  }
  return {
    ok: true,
    value: {
      filePath: a.file_path,
      oldString: a.old_string,
      newString: a.new_string,
      replaceAll: a.replace_all === true,
    },
  };
}

/**
 * Counts non-overlapping literal occurrences of `needle` in `haystack` via a
 * manual `indexOf` loop, advancing past each match by `needle.length`.
 * Deliberately not regex-based: constructing a regex from an arbitrary
 * `old_string` would require escaping every special character, and would risk
 * subtle mismatches (e.g. `.` matching any character) if escaping were
 * incomplete.
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function preview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}...` : text;
}

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { filePath, oldString, newString, replaceAll } = parsed.value;

  const confinement = await resolveConfinedPath(filePath, ctx.locationPath);
  if (!confinement.ok) {
    return { ok: false, result: confinement.message };
  }

  // Small win, not a real interruption: the read-then-write below cannot be
  // cancelled mid-flight, but checking right before starting it avoids
  // racing an already-aborted turn's result into the conversation.
  if (signal?.aborted) {
    return { ok: false, result: 'aborted' };
  }

  if (oldString === newString) {
    return { ok: false, result: 'no-op: old_string and new_string are identical' };
  }

  let content: string;
  try {
    content = await Bun.file(confinement.resolvedPath).text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `Failed to read file: ${message}` };
  }

  const matchCount = countOccurrences(content, oldString);
  if (matchCount === 0) {
    return { ok: false, result: 'not-found: old_string does not match any content in the file' };
  }
  if (!replaceAll && matchCount > 1) {
    return {
      ok: false,
      result: `ambiguous: old_string matches ${matchCount} locations; pass replace_all: true to replace all of them, or narrow old_string to a single match`,
    };
  }

  const newContent = content.split(oldString).join(newString);

  try {
    await atomicWrite(confinement.resolvedPath, newContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `Failed to write file: ${message}` };
  }

  const replacedCount = replaceAll ? matchCount : 1;
  return {
    ok: true,
    result:
      `Edited ${confinement.resolvedPath} (${replacedCount} replacement${replacedCount === 1 ? '' : 's'})\n` +
      `- ${preview(oldString)}\n` +
      `+ ${preview(newString)}`,
  };
}

export const editTool: BuiltinTool = {
  name: 'Edit',
  definition: {
    name: 'Edit',
    description:
      'Replace an exact substring match within an existing file, confined to the session ' +
      'working directory. old_string must match the file content byte-for-byte (no whitespace ' +
      'normalization). By default old_string must match exactly once; set replace_all to true ' +
      'to replace every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute or relative path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to replace',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  execute,
};
