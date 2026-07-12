/**
 * Builtin `Read` tool: reads a text file, confined to the session's
 * locationPath, and returns `cat -n`-style line-numbered output.
 */

import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';

const DEFAULT_LIMIT = 2000;
const DEFAULT_OFFSET = 0;

interface ReadArgs {
  path: string;
  limit: number;
  offset: number;
}

function parseArgs(args: unknown): { ok: true; value: ReadArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.path !== 'string') {
    return { ok: false, message: 'path is required and must be a string' };
  }
  if (a.limit !== undefined && typeof a.limit !== 'number') {
    return { ok: false, message: 'limit must be a number' };
  }
  if (a.offset !== undefined && typeof a.offset !== 'number') {
    return { ok: false, message: 'offset must be a number' };
  }
  return {
    ok: true,
    value: {
      path: a.path,
      limit: typeof a.limit === 'number' ? a.limit : DEFAULT_LIMIT,
      offset: typeof a.offset === 'number' ? a.offset : DEFAULT_OFFSET,
    },
  };
}

async function execute(args: unknown, ctx: BuiltinToolContext): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { path: rawPath, limit, offset } = parsed.value;

  const confinement = await resolveConfinedPath(rawPath, ctx.locationPath);
  if (!confinement.ok) {
    return { ok: false, result: confinement.message };
  }

  try {
    const text = await Bun.file(confinement.resolvedPath).text();
    const lines = text.split('\n');
    const selected = lines.slice(offset, offset + limit);
    const formatted = selected
      .map((lineContent, index) => `${offset + index + 1}\t${lineContent}`)
      .join('\n');
    return { ok: true, result: formatted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `Failed to read file: ${message}` };
  }
}

export const readTool: BuiltinTool = {
  name: 'Read',
  definition: {
    name: 'Read',
    description:
      'Read a text file from the local filesystem and return its contents with cat -n style ' +
      'line numbers. Supports optional offset/limit to read a slice of large files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute or relative path to the file to read',
        },
        limit: {
          type: 'number',
          description: 'The number of lines to read',
        },
        offset: {
          type: 'number',
          description: 'The line number to start reading from (0-based)',
        },
      },
      required: ['path'],
    },
  },
  execute,
};
