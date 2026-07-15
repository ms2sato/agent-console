/**
 * Builtin `Read` tool: reads a text file, confined to the session's
 * locationPath, and returns `cat -n`-style line-numbered output.
 */

import * as fsPromises from 'node:fs/promises';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';
import { trimToUtf8Boundary } from '../truncate.js';

const DEFAULT_LIMIT = 2000;
const DEFAULT_OFFSET = 0;

/**
 * Per-file byte cap on how much of a file this tool loads into subprocess
 * memory, matching Grep's per-file size threshold (see `grep.ts`). A file
 * over the cap is not rejected outright (unlike Grep, which skips it) -- the
 * first READ_MAX_BYTES bytes are still useful to the model, so Read returns
 * that prefix plus an explicit truncation notice instead of loading the
 * entire file (which could be arbitrarily large) into memory first.
 */
export const READ_MAX_BYTES = 1024 * 1024;

/**
 * Extra bytes read past the cap so `trimToUtf8Boundary` can see the byte
 * immediately after the cut and back off if it would split a multibyte
 * character (UTF-8 code points are at most 4 bytes).
 */
const UTF8_BOUNDARY_LOOKAHEAD_BYTES = 4;

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

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { path: rawPath, limit, offset } = parsed.value;

  const confinement = await resolveConfinedPath(rawPath, ctx.locationPath);
  if (!confinement.ok) {
    return { ok: false, result: confinement.message };
  }

  // Small win, not a real interruption: a single `.text()` call below cannot
  // be cancelled mid-flight, but checking right before starting it avoids
  // racing an already-aborted turn's result into the conversation.
  if (signal?.aborted) {
    return { ok: false, result: 'aborted' };
  }

  try {
    const stat = await fsPromises.stat(confinement.resolvedPath);
    const bunFile = Bun.file(confinement.resolvedPath);
    let text: string;
    let truncated = false;
    if (stat.size > READ_MAX_BYTES) {
      const bytes = new Uint8Array(
        await bunFile.slice(0, READ_MAX_BYTES + UTF8_BOUNDARY_LOOKAHEAD_BYTES).arrayBuffer(),
      );
      text = new TextDecoder().decode(trimToUtf8Boundary(bytes, READ_MAX_BYTES));
      truncated = true;
    } else {
      text = await bunFile.text();
    }

    const lines = text.split('\n');
    const selected = lines.slice(offset, offset + limit);
    const formatted = selected
      .map((lineContent, index) => `${offset + index + 1}\t${lineContent}`)
      .join('\n');
    const notice = truncated
      ? `\n\n[Read truncated: file is ${stat.size} bytes, exceeding the ${READ_MAX_BYTES}-byte read cap. ` +
        `Showing content from the first ${READ_MAX_BYTES} bytes only.]`
      : '';
    return { ok: true, result: formatted + notice };
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
