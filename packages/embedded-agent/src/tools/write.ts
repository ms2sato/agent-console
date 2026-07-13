/**
 * Builtin `Write` tool: creates or overwrites a text file, confined to the
 * session's locationPath, via an atomic temp-file-then-rename sequence so a
 * crash mid-write never leaves a partially-written file at the target path.
 */

import * as fsPromises from 'node:fs/promises';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';
import { resolveConfinedPath } from './path-confinement.js';
import { atomicWrite } from './atomic-write.js';

interface WriteArgs {
  filePath: string;
  content: string;
}

function parseArgs(args: unknown): { ok: true; value: WriteArgs } | { ok: false; message: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.file_path !== 'string') {
    return { ok: false, message: 'file_path is required and must be a string' };
  }
  if (typeof a.content !== 'string') {
    return { ok: false, message: 'content is required and must be a string' };
  }
  return { ok: true, value: { filePath: a.file_path, content: a.content } };
}

async function fileExists(candidatePath: string): Promise<boolean> {
  try {
    await fsPromises.stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { ok: false, result: parsed.message };
  }
  const { filePath, content } = parsed.value;

  const confinement = await resolveConfinedPath(filePath, ctx.locationPath);
  if (!confinement.ok) {
    return { ok: false, result: confinement.message };
  }

  // Small win, not a real interruption: the write below is a single atomic
  // operation that cannot be cancelled mid-flight, but checking right before
  // starting it avoids racing an already-aborted turn's result into the
  // conversation.
  if (signal?.aborted) {
    return { ok: false, result: 'aborted' };
  }

  const wasCreated = !(await fileExists(confinement.resolvedPath));

  try {
    const { bytesWritten } = await atomicWrite(confinement.resolvedPath, content);
    const verb = wasCreated ? 'File created' : 'File overwritten';
    return { ok: true, result: `${verb}: ${confinement.resolvedPath} (${bytesWritten} bytes)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `Failed to write file: ${message}` };
  }
}

export const writeTool: BuiltinTool = {
  name: 'Write',
  definition: {
    name: 'Write',
    description:
      'Write a file to the local filesystem, confined to the session working directory. ' +
      'Creates the file if it does not exist, or overwrites it entirely if it does.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute or relative path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  execute,
};
