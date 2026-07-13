/**
 * Builtin `Glob` tool: matches files by glob pattern, confined to the
 * session's locationPath, sorted most-recently-modified first.
 */

import { Glob } from 'bun';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';

interface GlobArgs {
  pattern: string;
  path?: string;
}

function parseArgs(args: unknown): { ok: true; value: GlobArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.pattern !== 'string') {
    return { ok: false, message: 'pattern is required and must be a string' };
  }
  if (a.path !== undefined && typeof a.path !== 'string') {
    return { ok: false, message: 'path must be a string' };
  }
  return { ok: true, value: { pattern: a.pattern, path: a.path as string | undefined } };
}

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { pattern, path: rawPath } = parsed.value;

  const rootConfinement = await resolveConfinedPath(rawPath ?? ctx.locationPath, ctx.locationPath);
  if (!rootConfinement.ok) {
    return { ok: false, result: rootConfinement.message };
  }
  const root = rootConfinement.resolvedPath;

  const glob = new Glob(pattern);
  const candidates: string[] = [];
  for await (const match of glob.scan({ cwd: root, absolute: false })) {
    if (signal?.aborted) {
      return { ok: false, result: 'aborted' };
    }
    const absoluteMatch = path.join(root, match);
    // Defense against a matched symlink pointing outside locationPath: confine
    // every match too and drop it silently if it escapes.
    const matchConfinement = await resolveConfinedPath(absoluteMatch, ctx.locationPath);
    if (matchConfinement.ok) {
      candidates.push(matchConfinement.resolvedPath);
    }
  }

  const withMtime: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of candidates) {
    if (signal?.aborted) {
      return { ok: false, result: 'aborted' };
    }
    try {
      const stat = await fsPromises.stat(file);
      withMtime.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // TOCTOU edge case (e.g. dangling symlink resolved after confinement but
      // gone by stat time): drop rather than crash.
    }
  }

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { ok: true, result: withMtime.map((m) => m.file).join('\n') };
}

export const globTool: BuiltinTool = {
  name: 'Glob',
  definition: {
    name: 'Glob',
    description:
      'Find files matching a glob pattern, confined to the session working directory. ' +
      'Results are sorted by modification time, most recent first.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files against, e.g. "**/*.ts"',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (defaults to the session working directory)',
        },
      },
      required: ['pattern'],
    },
  },
  execute,
};
