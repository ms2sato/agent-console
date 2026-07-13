/**
 * Builtin `Grep` tool: a deliberately small subset of ripgrep-style content
 * search, confined to the session's locationPath. Implemented in pure TS (no
 * `rg` binary dependency) — this is a v1 subset, not a full reimplementation.
 */

import { Glob } from 'bun';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';

/** Pragmatic v1 limit to bound worst-case latency/memory; not a spec requirement. */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

type OutputMode = 'content' | 'files_with_matches' | 'count';
const OUTPUT_MODES: readonly OutputMode[] = ['content', 'files_with_matches', 'count'];

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  outputMode: OutputMode;
}

function parseArgs(args: unknown): { ok: true; value: GrepArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.pattern !== 'string') {
    return { ok: false, message: 'pattern is required and must be a string' };
  }
  if (a.path !== undefined && typeof a.path !== 'string') {
    return { ok: false, message: 'path must be a string' };
  }
  if (a.glob !== undefined && typeof a.glob !== 'string') {
    return { ok: false, message: 'glob must be a string' };
  }
  if (a.caseInsensitive !== undefined && typeof a.caseInsensitive !== 'boolean') {
    return { ok: false, message: 'caseInsensitive must be a boolean' };
  }
  if (a.outputMode !== undefined && !OUTPUT_MODES.includes(a.outputMode as OutputMode)) {
    return { ok: false, message: `outputMode must be one of ${OUTPUT_MODES.join(', ')}` };
  }
  return {
    ok: true,
    value: {
      pattern: a.pattern,
      path: a.path as string | undefined,
      glob: a.glob as string | undefined,
      caseInsensitive: a.caseInsensitive as boolean | undefined,
      outputMode: (a.outputMode as OutputMode | undefined) ?? 'files_with_matches',
    },
  };
}

/** Best-effort binary sniff: NUL byte anywhere in the read content. */
function looksBinary(text: string): boolean {
  return text.includes('\0');
}

async function collectSearchableFiles(
  root: string,
  globPattern: string,
  ctx: BuiltinToolContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const glob = new Glob(globPattern);
  const files: string[] = [];
  for await (const match of glob.scan({ cwd: root, absolute: false })) {
    if (signal?.aborted) {
      break;
    }
    const absoluteMatch = path.join(root, match);
    const confinement = await resolveConfinedPath(absoluteMatch, ctx.locationPath);
    if (!confinement.ok) continue;

    try {
      const stat = await fsPromises.stat(confinement.resolvedPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      files.push(confinement.resolvedPath);
    } catch {
      // TOCTOU: matched then disappeared/inaccessible before stat. Drop.
    }
  }
  return files;
}

function formatResult(
  outputMode: OutputMode,
  matches: Array<{ file: string; lineNumber: number; lineContent: string }>,
): string {
  if (outputMode === 'content') {
    return matches.map((m) => `${m.file}:${m.lineNumber}:${m.lineContent}`).join('\n');
  }

  const byFile = new Map<string, number>();
  for (const m of matches) {
    byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
  }

  if (outputMode === 'count') {
    return Array.from(byFile.entries())
      .map(([file, count]) => `${file}:${count}`)
      .join('\n');
  }

  // files_with_matches
  return Array.from(byFile.keys()).join('\n');
}

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { pattern, path: rawPath, glob: globPattern, caseInsensitive, outputMode } = parsed.value;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'i' : undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `Invalid regex pattern: ${message}` };
  }

  const rootConfinement = await resolveConfinedPath(rawPath ?? ctx.locationPath, ctx.locationPath);
  if (!rootConfinement.ok) {
    return { ok: false, result: rootConfinement.message };
  }

  const files = await collectSearchableFiles(rootConfinement.resolvedPath, globPattern ?? '**/*', ctx, signal);
  if (signal?.aborted) {
    return { ok: false, result: 'aborted' };
  }

  const matches: Array<{ file: string; lineNumber: number; lineContent: string }> = [];
  for (const file of files) {
    if (signal?.aborted) {
      return { ok: false, result: 'aborted' };
    }
    let text: string;
    try {
      text = await Bun.file(file).text();
    } catch {
      continue;
    }
    if (looksBinary(text)) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ file, lineNumber: i + 1, lineContent: lines[i] });
      }
    }
  }

  return { ok: true, result: formatResult(outputMode, matches) };
}

export const grepTool: BuiltinTool = {
  name: 'Grep',
  definition: {
    name: 'Grep',
    description:
      'Search file contents for a regex pattern, confined to the session working directory. ' +
      'Supports filtering by glob and choosing between content/files_with_matches/count output.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JS-flavored regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in (defaults to the session working directory)',
        },
        glob: {
          type: 'string',
          description: "glob to filter which files are searched, e.g. '*.ts'",
        },
        caseInsensitive: { type: 'boolean', description: 'Case-insensitive matching' },
        outputMode: {
          type: 'string',
          enum: OUTPUT_MODES,
          description: 'Output shape: content (matching lines), files_with_matches, or count',
        },
      },
      required: ['pattern'],
    },
  },
  execute,
};
