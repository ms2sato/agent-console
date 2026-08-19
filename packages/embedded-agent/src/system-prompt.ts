/**
 * System-prompt assembly for the embedded-agent loop.
 *
 * The prompt is assembled once per activation. `loadInstructions` discovers
 * instruction files across three layers -- global (`~/.config/agent-console`),
 * chain (git root down to cwd), and cwd (the chain's tail) -- plus an opt-in
 * `EmbeddedAgentDefinition.instructions` file list, then `assembleSystemPrompt`
 * concatenates: (1) context preamble -> (2) discovered/opt-in instruction
 * segments, in discovery order -> (3) the operator-configured definition
 * system prompt (last, so it wins on conflict).
 *
 * See docs/design/embedded-agent-worker.md "AGENTS.md loader" for the
 * normative spec (discovery order, caps, overflow-drop policy).
 */

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { truncateToBytes } from './truncate.js';
import { resolveConfinedPath } from './tools/path-confinement.js';
import { isErrnoException } from './type-guards.js';

export const INSTRUCTION_PER_FILE_CAP_BYTES = 16 * 1024;
export const INSTRUCTION_AGGREGATE_CAP_BYTES = 48 * 1024;

const encoder = new TextEncoder();

export interface SystemPromptContext {
  sessionId: string;
  workerId: string;
  cwd: string;
  repositoryId?: string;
}

export interface InstructionSegment {
  /** Absolute resolved path of the source file. */
  origin: string;
  /** Per-file-capped content (may equal the raw content if under the cap). */
  content: string;
}

export interface LoadInstructionsParams {
  /** Also serves as the confinement root (locationPath) for instructions[]. */
  cwd: string;
  /** EmbeddedAgentDefinition.instructions, resolved relative to cwd. */
  instructionsList?: string[];
  /** Test override; defaults to node:os homedir(). */
  homeDir?: string;
  /** Test override; defaults to process.env.XDG_CONFIG_HOME. */
  xdgConfigHome?: string;
}

export interface LoadInstructionsResult {
  /** Final, capped, overflow-trimmed segments, in concatenation order. */
  segments: InstructionSegment[];
}

export interface AssembleSystemPromptParams {
  context: SystemPromptContext;
  instructions: LoadInstructionsResult;
  definitionSystemPrompt?: string;
}

function buildPreamble(context: SystemPromptContext): string {
  const lines = [
    'You are an embedded agent running inside agent-console.',
    `Session ID: ${context.sessionId}`,
    `Worker ID: ${context.workerId}`,
    `Working directory: ${context.cwd}`,
  ];
  if (context.repositoryId !== undefined) {
    lines.push(`Repository ID: ${context.repositoryId}`);
  }
  lines.push(
    'When an MCP tool accepts a sessionId or fromSessionId argument, use the Session ID above.',
  );
  lines.push(
    'HTML/SVG code blocks you write may be rendered in a sandboxed preview; keep them static only -- no <script> tags and no inline event handler attributes (onclick, onload, etc.), since these are stripped before rendering and will not run.',
  );
  return lines.join('\n');
}

/**
 * Formats instruction segments the way `assembleSystemPrompt` renders them --
 * `--- Instructions: <origin> ---\n<content>` per segment, in given order.
 * Extracted so the SDK engine's `systemPrompt.append` composition (see
 * `composeSdkSystemPromptAppend` below) can reuse the exact same rendering
 * instead of reinventing it.
 */
export function formatInstructionSegments(segments: InstructionSegment[]): string[] {
  return segments.map((segment) => `--- Instructions: ${segment.origin} ---\n${segment.content}`);
}

export function assembleSystemPrompt(params: AssembleSystemPromptParams): string {
  const sections: string[] = [buildPreamble(params.context)];

  sections.push(...formatInstructionSegments(params.instructions.segments));

  if (params.definitionSystemPrompt !== undefined && params.definitionSystemPrompt.length > 0) {
    sections.push(params.definitionSystemPrompt);
  }

  return sections.join('\n\n');
}

/**
 * Composes the SDK engine's `systemPrompt.append` string (main.ts's
 * `claude-sdk` init arm): opt-in instruction segments, formatted the same way
 * `assembleSystemPrompt` renders them, followed by the definition system
 * prompt if present -- mirroring `assembleSystemPrompt`'s section-join
 * convention (including the aggregate-cap-with-warn behavior below), minus
 * the preamble (the SDK engine uses the SDK's own `claude_code` preset
 * preamble instead of ours, so `buildPreamble` must not run here). Returns
 * `undefined` when there is nothing to append, so callers can omit
 * `Options.systemPrompt` entirely rather than passing an empty string (see
 * docs/design/embedded-agent-sdk-engine.md §4's "Instruction loader" row
 * correction).
 */
export function composeSdkSystemPromptAppend(
  segments: InstructionSegment[],
  definitionSystemPrompt: string | undefined,
): string | undefined {
  // Aggregate cap governs the instruction segments only, mirroring
  // assembleSystemPrompt/loadInstructions -- definitionSystemPrompt is never
  // subject to it, below or here.
  const cappedSegments = capAggregateInstructions(segments);
  const sections = formatInstructionSegments(cappedSegments);
  if (definitionSystemPrompt !== undefined && definitionSystemPrompt.length > 0) {
    sections.push(definitionSystemPrompt);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/**
 * Applies `INSTRUCTION_AGGREGATE_CAP_BYTES` to a single flat list of
 * instruction segments, dropping from the end (last-to-first) until the
 * total is under the cap -- the same drop policy `loadInstructions` applies
 * to its own `instructionsList` layer. Used by `composeSdkSystemPromptAppend`
 * for the SDK engine's opt-in-only instruction path, which (unlike
 * `loadInstructions`) has no global/chain layers to weigh against, so a
 * single last-to-first pass over the whole list is the complete policy here.
 */
function capAggregateInstructions(segments: InstructionSegment[]): InstructionSegment[] {
  const surviving = [...segments];
  const total = (): number => surviving.reduce((sum, s) => sum + segmentByteLength(s), 0);
  while (total() > INSTRUCTION_AGGREGATE_CAP_BYTES && surviving.length > 0) {
    const dropped = surviving.pop();
    if (dropped !== undefined) logAggregateDrop(dropped);
  }
  return surviving;
}

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

/**
 * Walk up from `startDir` looking for the nearest ancestor where `.git`
 * exists as either a file (worktree gitfile) or a directory. Returns null
 * when the filesystem root is reached without finding one.
 */
async function findGitRoot(startDir: string): Promise<string | null> {
  let current = startDir;
  while (true) {
    try {
      const stat = await fsPromises.stat(path.join(current, '.git'));
      if (stat.isFile() || stat.isDirectory()) {
        return current;
      }
    } catch (err) {
      if (!(isErrnoException(err) && err.code === 'ENOENT')) {
        // Unexpected error (e.g. EACCES) inspecting this ancestor's .git --
        // treat as "not the root here" and keep climbing rather than failing
        // discovery entirely.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Directories to check for instruction files, in root-to-cwd order. Reduces
 * to `[cwd]` when cwd is outside any git repository.
 */
async function buildChainDirs(cwd: string): Promise<string[]> {
  const root = await findGitRoot(cwd);
  if (root === null) {
    return [cwd];
  }

  const rel = path.relative(root, cwd);
  if (rel === '' || rel === '.') {
    return [root];
  }

  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

/**
 * Resolve one directory's instruction file: AGENTS.md canonical, CLAUDE.md
 * fallback. Both present -> debug log (normal, e.g. a symlinked pair), pick
 * AGENTS.md. Neither present -> null, no log (routine, would be noisy across
 * a deep chain). A candidate that exists but fails to read (EACCES, EISDIR,
 * ...) -> warn log, null (skip, non-fatal).
 */
async function resolveDirectoryInstructionFile(dir: string): Promise<InstructionSegment | null> {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const claudePath = path.join(dir, 'CLAUDE.md');

  const agentsResult = await tryReadTextFile(agentsPath);
  if (agentsResult.ok) {
    if (await Bun.file(claudePath).exists()) {
      console.debug(`Both AGENTS.md and CLAUDE.md present in ${dir}; using AGENTS.md`);
    }
    return { origin: agentsPath, content: agentsResult.content };
  }
  if (agentsResult.code !== 'ENOENT') {
    console.warn(`Failed to read ${agentsPath}: ${agentsResult.message}`);
    return null;
  }

  const claudeResult = await tryReadTextFile(claudePath);
  if (claudeResult.ok) {
    return { origin: claudePath, content: claudeResult.content };
  }
  if (claudeResult.code !== 'ENOENT') {
    console.warn(`Failed to read ${claudePath}: ${claudeResult.message}`);
    return null;
  }

  // Neither AGENTS.md nor CLAUDE.md exists -- the normal case for most
  // directories in the chain. Intentionally silent.
  return null;
}

/** Apply the per-file 16 KiB cap, warn-logging on truncation. No in-prompt marker. */
function capSegment(segment: InstructionSegment): InstructionSegment {
  const { text, truncated } = truncateToBytes(segment.content, INSTRUCTION_PER_FILE_CAP_BYTES);
  if (truncated) {
    const originalBytes = encoder.encode(segment.content).length;
    console.warn(
      `Truncated instruction file ${segment.origin} from ${originalBytes} bytes to ${INSTRUCTION_PER_FILE_CAP_BYTES} bytes (per-file cap)`,
    );
  }
  return { origin: segment.origin, content: text };
}

/**
 * Reads the opt-in `instructions[]` layer only -- confined-path-resolved
 * against `cwd`, capped per-file. No global (~/.config/agent-console) or
 * chain (AGENTS.md/CLAUDE.md auto-discovery) layers. Shared by
 * `loadInstructions` (which composes this with the other two layers for the
 * openai-api engine) and the SDK engine (which uses ONLY this layer --
 * AGENTS.md auto-discovery is deliberately out of scope for that engine, see
 * docs/design/embedded-agent-sdk-engine.md §4).
 */
export async function loadOptInInstructions(
  cwd: string,
  instructionsList: string[] | undefined,
): Promise<InstructionSegment[]> {
  const instructionsRaw: InstructionSegment[] = [];
  for (const rawEntry of instructionsList ?? []) {
    const confinement = await resolveConfinedPath(rawEntry, cwd);
    if (!confinement.ok) {
      console.warn(`Skipping instructions[] entry "${rawEntry}": ${confinement.message}`);
      continue;
    }
    const read = await tryReadTextFile(confinement.resolvedPath);
    if (!read.ok) {
      console.warn(
        `Skipping instructions[] entry "${rawEntry}" (resolved ${confinement.resolvedPath}): ${read.message}`,
      );
      continue;
    }
    instructionsRaw.push({ origin: confinement.resolvedPath, content: read.content });
  }
  return instructionsRaw.map(capSegment);
}

function segmentByteLength(segment: InstructionSegment): number {
  return encoder.encode(segment.content).length;
}

function logAggregateDrop(segment: InstructionSegment): void {
  console.warn(
    `Dropped instruction segment ${segment.origin} (${segmentByteLength(segment)} bytes) to satisfy the ${INSTRUCTION_AGGREGATE_CAP_BYTES}-byte aggregate cap`,
  );
}

export async function loadInstructions(
  params: LoadInstructionsParams,
): Promise<LoadInstructionsResult> {
  const cwd = path.resolve(params.cwd);

  // Global layer.
  const configHome =
    params.xdgConfigHome ??
    process.env.XDG_CONFIG_HOME ??
    path.join(params.homeDir ?? os.homedir(), '.config');
  const globalDir = path.join(configHome, 'agent-console');
  const globalRaw = await resolveDirectoryInstructionFile(globalDir);

  // Chain layer (root -> cwd, or [cwd] outside a git repo).
  const chainDirs = await buildChainDirs(cwd);
  const chainResults = await Promise.all(
    chainDirs.map((dir) => resolveDirectoryInstructionFile(dir)),
  );
  const chainRaw = chainResults.filter((s): s is InstructionSegment => s !== null);

  // instructions[] layer (opt-in, confined to cwd, capped per-file) --
  // delegated to loadOptInInstructions, the single confined reader shared
  // with the SDK engine (main.ts's claude-sdk arm).
  const instructionSegments = await loadOptInInstructions(cwd, params.instructionsList);

  // Per-file cap (global/chain only -- instructionSegments is already capped
  // by loadOptInInstructions above).
  const globalSegment = globalRaw !== null ? capSegment(globalRaw) : null;
  const chainSegments = chainRaw.map(capSegment);

  // Aggregate cap + overflow drop: general side first (global, then chain
  // root-to-leaf, then instructions[] last-to-first), preserving the
  // relative order of survivors.
  let survivingGlobal = globalSegment;
  const survivingChain = [...chainSegments];
  const survivingInstructions = [...instructionSegments];

  const total = (): number => {
    let sum = survivingGlobal !== null ? segmentByteLength(survivingGlobal) : 0;
    for (const s of survivingChain) sum += segmentByteLength(s);
    for (const s of survivingInstructions) sum += segmentByteLength(s);
    return sum;
  };

  if (total() > INSTRUCTION_AGGREGATE_CAP_BYTES) {
    if (survivingGlobal !== null) {
      logAggregateDrop(survivingGlobal);
      survivingGlobal = null;
    }
    while (total() > INSTRUCTION_AGGREGATE_CAP_BYTES && survivingChain.length > 0) {
      const dropped = survivingChain.shift();
      if (dropped !== undefined) logAggregateDrop(dropped);
    }
    while (total() > INSTRUCTION_AGGREGATE_CAP_BYTES && survivingInstructions.length > 0) {
      const dropped = survivingInstructions.pop();
      if (dropped !== undefined) logAggregateDrop(dropped);
    }
  }

  const segments: InstructionSegment[] = [
    ...(survivingGlobal !== null ? [survivingGlobal] : []),
    ...survivingChain,
    ...survivingInstructions,
  ];

  return { segments };
}
