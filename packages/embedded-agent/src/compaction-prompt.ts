/**
 * Compaction prompt loader.
 *
 * A narrower cousin of the AGENTS.md loader (system-prompt.ts) -- the
 * semantics differ (override, not concatenation): the first layer whose file
 * exists and is readable wins outright, the other layers are never read.
 *
 * The retired `handoff-prompt.md` filename is deliberately NOT honored as a
 * fallback: an override written under the old name says "hand over to a new
 * session", which describes something the system no longer does, and an
 * override that keeps quietly working while describing the wrong behavior is
 * worse than one that visibly stops.
 *
 * See docs/design/embedded-agent-worker.md "Compaction prompt loader" for
 * the normative spec (layer order, cap, precedence).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { truncateToBytes } from './truncate.js';
import { isErrnoException } from './type-guards.js';

/** Same cap/behavior as INSTRUCTION_PER_FILE_CAP_BYTES in system-prompt.ts. */
const COMPACTION_PROMPT_CAP_BYTES = 16 * 1024;

const encoder = new TextEncoder();

export interface LoadCompactionPromptParams {
  cwd: string;
  /** Test override; defaults to node:os homedir(). */
  homeDir?: string;
  /** Test override; defaults to process.env.XDG_CONFIG_HOME. */
  xdgConfigHome?: string;
}

export interface LoadCompactionPromptResult {
  content: string;
  /** Logging-only, not part of the wire protocol. */
  origin: 'repo' | 'global' | 'bundled-default';
}

/** Bundled default (Layer 3), the canonical text ship verbatim. */
export const DEFAULT_COMPACTION_PROMPT = `This conversation is approaching its context window limit. Produce a concise
but complete distillation of the conversation so far: the task, key
decisions made, the current state of any in-progress work, and the concrete
next steps. Write only the distillation text, with no preamble or
meta-commentary -- it replaces the earlier messages of THIS conversation,
which continues from it.`;

type ReadTextResult =
  | { ok: true; content: string }
  | { ok: false; code: string; message: string };

/** Bun.file().text() wrapper that normalizes the error shape for callers. */
async function tryReadTextFile(filePath: string): Promise<ReadTextResult> {
  try {
    const content = await Bun.file(filePath).text();
    return { ok: true, content };
  } catch (err) {
    const code = (isErrnoException(err) ? err.code : undefined) ?? 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code, message };
  }
}

/** Apply the 16 KiB cap, warn-logging on truncation. No in-prompt marker. */
function capContent(origin: string, content: string): string {
  const { text, truncated } = truncateToBytes(content, COMPACTION_PROMPT_CAP_BYTES);
  if (truncated) {
    const originalBytes = encoder.encode(content).length;
    console.warn(
      `Truncated compaction prompt ${origin} from ${originalBytes} bytes to ${COMPACTION_PROMPT_CAP_BYTES} bytes (per-file cap)`,
    );
  }
  return text;
}

/**
 * Try one candidate layer. Returns null when the file does not exist (silent,
 * routine) or fails to read (warn-logged, non-fatal) -- both cases fall
 * through to the next layer.
 */
async function tryLayer(
  filePath: string,
  origin: 'repo' | 'global',
): Promise<LoadCompactionPromptResult | null> {
  const result = await tryReadTextFile(filePath);
  if (result.ok) {
    return { content: capContent(filePath, result.content), origin };
  }
  if (result.code !== 'ENOENT') {
    console.warn(`Failed to read compaction prompt ${filePath}: ${result.message}`);
  }
  return null;
}

export async function loadCompactionPrompt(
  params: LoadCompactionPromptParams,
): Promise<LoadCompactionPromptResult> {
  const cwd = path.resolve(params.cwd);

  // Layer 1: repo. Single literal path, not a chain walk -- cwd already IS
  // the session's locationPath.
  const repoPath = path.join(cwd, '.agent-console', 'compaction-prompt.md');
  const repoResult = await tryLayer(repoPath, 'repo');
  if (repoResult !== null) return repoResult;

  // Layer 2: global.
  const configHome =
    params.xdgConfigHome ??
    process.env.XDG_CONFIG_HOME ??
    path.join(params.homeDir ?? os.homedir(), '.config');
  const globalPath = path.join(configHome, 'agent-console', 'compaction-prompt.md');
  const globalResult = await tryLayer(globalPath, 'global');
  if (globalResult !== null) return globalResult;

  // Layer 3: bundled default.
  return { content: DEFAULT_COMPACTION_PROMPT, origin: 'bundled-default' };
}
