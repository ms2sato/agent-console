/**
 * Handoff prompt loader for Context Handoff (Phase A).
 *
 * A narrower cousin of the AGENTS.md loader (system-prompt.ts) -- the
 * semantics differ (override, not concatenation): the first layer whose file
 * exists and is readable wins outright, the other layers are never read.
 *
 * See docs/design/embedded-agent-worker.md "Handoff prompt loader" for the
 * normative spec (layer order, cap, precedence).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { truncateToBytes } from './truncate.js';

/** Same cap/behavior as INSTRUCTION_PER_FILE_CAP_BYTES in system-prompt.ts. */
const HANDOFF_PROMPT_CAP_BYTES = 16 * 1024;

const encoder = new TextEncoder();

export interface LoadHandoffPromptParams {
  cwd: string;
  /** Test override; defaults to node:os homedir(). */
  homeDir?: string;
  /** Test override; defaults to process.env.XDG_CONFIG_HOME. */
  xdgConfigHome?: string;
}

export interface LoadHandoffPromptResult {
  content: string;
  /** Logging-only, not part of the wire protocol. */
  origin: 'repo' | 'global' | 'bundled-default';
}

/** Bundled default (Layer 3), the canonical text ship verbatim. */
export const DEFAULT_HANDOFF_PROMPT = `This conversation is approaching its context window limit. Produce a concise
but complete distillation of the conversation so far: the task, key
decisions made, the current state of any in-progress work, and the concrete
next steps. Write only the distillation text, with no preamble or
meta-commentary -- it will directly seed a fresh conversation that continues
this work.`;

type ReadTextResult =
  | { ok: true; content: string }
  | { ok: false; code: string; message: string };

/** Bun.file().text() wrapper that normalizes the error shape for callers. */
async function tryReadTextFile(filePath: string): Promise<ReadTextResult> {
  try {
    const content = await Bun.file(filePath).text();
    return { ok: true, content };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code, message };
  }
}

/** Apply the 16 KiB cap, warn-logging on truncation. No in-prompt marker. */
function capContent(origin: string, content: string): string {
  const { text, truncated } = truncateToBytes(content, HANDOFF_PROMPT_CAP_BYTES);
  if (truncated) {
    const originalBytes = encoder.encode(content).length;
    console.warn(
      `Truncated handoff prompt ${origin} from ${originalBytes} bytes to ${HANDOFF_PROMPT_CAP_BYTES} bytes (per-file cap)`,
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
): Promise<LoadHandoffPromptResult | null> {
  const result = await tryReadTextFile(filePath);
  if (result.ok) {
    return { content: capContent(filePath, result.content), origin };
  }
  if (result.code !== 'ENOENT') {
    console.warn(`Failed to read handoff prompt ${filePath}: ${result.message}`);
  }
  return null;
}

export async function loadHandoffPrompt(
  params: LoadHandoffPromptParams,
): Promise<LoadHandoffPromptResult> {
  const cwd = path.resolve(params.cwd);

  // Layer 1: repo. Single literal path, not a chain walk -- cwd already IS
  // the session's locationPath.
  const repoPath = path.join(cwd, '.agent-console', 'handoff-prompt.md');
  const repoResult = await tryLayer(repoPath, 'repo');
  if (repoResult !== null) return repoResult;

  // Layer 2: global.
  const configHome =
    params.xdgConfigHome ??
    process.env.XDG_CONFIG_HOME ??
    path.join(params.homeDir ?? os.homedir(), '.config');
  const globalPath = path.join(configHome, 'agent-console', 'handoff-prompt.md');
  const globalResult = await tryLayer(globalPath, 'global');
  if (globalResult !== null) return globalResult;

  // Layer 3: bundled default.
  return { content: DEFAULT_HANDOFF_PROMPT, origin: 'bundled-default' };
}
