/**
 * System-prompt assembly for the embedded-agent loop.
 *
 * The prompt is assembled once per activation. `loadInstructions` discovers
 * instruction files across SIX layers -- global (`~/.config/agent-console`),
 * chain (git root down to cwd), an opt-in `EmbeddedAgentDefinition.instructions`
 * file list, the `.claude/rules/*.md` rules layer (unscoped rules included,
 * scoped rules listed in an index line only -- see `loadRulesLayer` below),
 * the `.claude/skills/**\/SKILL.md` skills layer (every discovered skill
 * listed as a name + description index line only, so the model can discover
 * a skill's existence without paying its full body's token cost up front --
 * see `loadSkillsLayer` below), and the memory layer (the agent's own
 * `<memoryDir>/MEMORY.md` index under a verbatim header, topic files never
 * loaded eagerly -- see `loadMemoryLayer` below) -- then
 * `assembleSystemPrompt` concatenates: (1) context preamble -> (2)
 * discovered/opt-in instruction segments, in discovery order -> (3) the
 * rules layer -> (4) the skills layer -> (5) the memory layer -> (6) the
 * operator-configured definition system prompt (last, so it wins on
 * conflict). Used identically by both engines (claude-sdk composes the same
 * layers, preamble included, via `composeSdkSystemPromptAppend` -- see its
 * doc comment).
 *
 * See docs/design/embedded-agent-worker.md "Instruction loader" for the
 * normative spec (discovery order, caps, overflow-drop policy) and "Memory
 * layer (epic #1636 Phase 2)" for the sixth layer.
 */

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { truncateToBytes } from './truncate.js';
import { resolveConfinedPath } from './tools/path-confinement.js';
import { isErrnoException } from './type-guards.js';

export const INSTRUCTION_PER_FILE_CAP_BYTES = 16 * 1024;
export const INSTRUCTION_AGGREGATE_CAP_BYTES = 48 * 1024;
const RULES_LAYER_CAP_BYTES_DEFAULT = 160 * 1024;
const SKILLS_LAYER_CAP_BYTES_DEFAULT = 16 * 1024;
const MEMORY_LAYER_CAP_BYTES_DEFAULT = 16 * 1024;
const MEMORY_LAYER_MAX_ENTRIES_DEFAULT = 500;

/**
 * Non-positive or non-numeric env values fall back to `defaultValue` rather
 * than surviving as-is -- a bare `Number(env) || default` lets a NEGATIVE
 * override through unclamped (e.g. `Number('-5') === -5`, which is truthy,
 * so `-5 || default` evaluates to `-5`), and a negative budget drops every
 * entry on the very first over-budget check (Architect N1). Shared by the
 * rules-layer, skills-layer, and memory-layer cap parsers below -- all need
 * the identical clamping rule, just with a different default.
 */
function parseCapBytesEnv(raw: string | undefined, defaultValue: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** @internal Exported for testing -- takes the raw env value as a parameter
 * rather than reading `process.env` directly, so a test can exercise the
 * clamping logic without needing a module re-import per env value. */
export function parseRulesLayerCapBytes(raw: string | undefined): number {
  return parseCapBytesEnv(raw, RULES_LAYER_CAP_BYTES_DEFAULT);
}

/**
 * Separate from {@link INSTRUCTION_AGGREGATE_CAP_BYTES}: rules are never
 * truncated mid-file (R3, Phase A) -- a half rule is worse than
 * none -- so overflow is handled by dropping whole files largest-first
 * instead of shrinking survivors. Default sized for this repo's own
 * unscoped-rules total (121 KB as of 2026-09-03) plus headroom; env-overridable
 * for repos with a different rules footprint.
 */
export const RULES_LAYER_CAP_BYTES = parseRulesLayerCapBytes(process.env.RULES_LAYER_CAP_BYTES);

/** @internal Exported for testing -- see {@link parseRulesLayerCapBytes}'s doc comment. */
export function parseSkillsLayerCapBytes(raw: string | undefined): number {
  return parseCapBytesEnv(raw, SKILLS_LAYER_CAP_BYTES_DEFAULT);
}

/**
 * Same overflow shape as {@link RULES_LAYER_CAP_BYTES} (whole-entry drop,
 * largest-first, declared in-band -- never truncated), sized much smaller
 * because a skills-layer entry is a one-line name+description, not a whole
 * file's content. Uses the SAME env-override mechanism as
 * {@link RULES_LAYER_CAP_BYTES} (a separate variable, `SKILLS_LAYER_CAP_BYTES`,
 * through the identical {@link parseCapBytesEnv} clamp) rather than a new
 * kind of override surface.
 */
export const SKILLS_LAYER_CAP_BYTES = parseSkillsLayerCapBytes(process.env.SKILLS_LAYER_CAP_BYTES);

/** @internal Exported for testing -- see {@link parseRulesLayerCapBytes}'s doc comment. */
export function parseMemoryLayerCapBytes(raw: string | undefined): number {
  return parseCapBytesEnv(raw, MEMORY_LAYER_CAP_BYTES_DEFAULT);
}

/**
 * Memory layer (epic #1636 Phase 2): the budget for the `MEMORY.md` index
 * alone -- a fourth budget, independent of the three above. Sized like
 * {@link SKILLS_LAYER_CAP_BYTES}, not like the rules cap, because an index
 * line is one pointer, not a file's content (Claude Code's own auto-memory
 * instructions keep `MEMORY.md` under 200 lines). Overflow drops WHOLE index
 * lines largest-first and declares them in-band (`loadMemoryLayer`); a line
 * is the unit, never a truncation mid-line. Same env-override clamp as its
 * siblings, through {@link parseCapBytesEnv}.
 */
export const MEMORY_LAYER_CAP_BYTES = parseMemoryLayerCapBytes(process.env.MEMORY_LAYER_CAP_BYTES);

/**
 * Memory layer: how many bytes of `MEMORY.md` the loader READS -- distinct
 * from {@link MEMORY_LAYER_CAP_BYTES}, which is how many it KEEPS. Two
 * reasons for the 4x headroom: (1) the spec's overflow policy is "drop whole
 * index lines largest-first", and choosing the largest among lines requires
 * having read them -- an index up to 4x the budget is still trimmed by that
 * policy in full rather than by file position; (2) it bounds the drop loop:
 * `dropLargestUntilFits` is O(removals x survivors) with a UTF-8 encode per
 * line per iteration, so an unbounded read of a model- or group-member-
 * written file with many short lines is quadratic in its size (a 10 MB
 * index of 20-byte lines is ~1e11 encode operations at every activation and
 * compaction re-read); at 64 KiB the worst case is ~(READ_CAP / shortest
 * line)^2 ~ 1e7, trivial. Content past this cap is never read; it is
 * DECLARED in-band (`memory index truncated for size: ...`) and warn-logged.
 */
export const MEMORY_INDEX_READ_CAP_BYTES = 4 * MEMORY_LAYER_CAP_BYTES;

/** @internal Exported for testing -- see {@link parseRulesLayerCapBytes}'s doc comment. */
export function parseMemoryLayerMaxEntries(raw: string | undefined): number {
  return parseCapBytesEnv(raw, MEMORY_LAYER_MAX_ENTRIES_DEFAULT);
}

/**
 * Memory layer: how many `memoryDir` entries the activation-time listing
 * access-checks before it stops and declares the remainder unchecked, so an
 * activation's cost is O(min(entries, cap)) and a runaway directory degrades
 * to a declared partial view rather than an unbounded stat loop. Not a byte
 * budget, but clamped through the same {@link parseCapBytesEnv} rule (a
 * non-positive or non-numeric override falls back to the default) rather
 * than a second kind of override surface.
 */
export const MEMORY_LAYER_MAX_ENTRIES = parseMemoryLayerMaxEntries(process.env.MEMORY_LAYER_MAX_ENTRIES);

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
  /**
   * Memory layer (epic #1636 Phase 2): the worker's server-owned memory
   * directory (`init.context.memoryDir`). Absent = the layer is empty and
   * silent (the same treatment a missing `.claude/rules` directory gets).
   * Present = the header is ALWAYS rendered, even before `MEMORY.md` exists,
   * because the WRITE half depends on the model knowing the path and the
   * convention on its very first activation.
   */
  memoryDir?: string;
}

export interface LoadInstructionsResult {
  /** Final, capped, overflow-trimmed segments, in concatenation order. */
  segments: InstructionSegment[];
  /**
   * R2/R3: unscoped `.claude/rules/*.md` content (no `paths:`/`globs:`
   * frontmatter), included eagerly -- sorted by file name, never
   * per-file-truncated, whole-file-dropped largest-first under
   * {@link RULES_LAYER_CAP_BYTES} when over budget. Optional on this type
   * only so hand-built test fixtures that don't care about the rules layer
   * can omit it (treated as `[]`); the real `loadInstructions` always
   * populates it.
   */
  ruleSegments?: InstructionSegment[];
  /**
   * R3: declares, in-band, which unscoped rule files were dropped whole to
   * satisfy {@link RULES_LAYER_CAP_BYTES}. `undefined` when nothing was
   * dropped (including "no rules directory at all").
   */
  ruleOmissionLine?: string;
  /**
   * R2: one line listing path-scoped rules (name + globs) that exist but are
   * NOT included above -- Phase B activates them lazily on a matching tool
   * call. `undefined` when there are no scoped rules (no `.claude/rules`
   * directory, or every rule found is unscoped).
   */
  ruleIndexLine?: string;
  /**
   * Phase B (#1343 R1): the SAME scoped rules `ruleIndexLine` above
   * summarizes, exposed structurally instead of discarded after building that
   * one line -- `RuleActivator` (rule-activation.ts) reads each rule's own
   * content lazily, the first time a matching tool call arrives. Optional on
   * this type only so hand-built test fixtures that don't care about lazy
   * rule activation can omit it (treated as `[]`); the real `loadInstructions`
   * always populates it.
   */
  scopedRules?: ScopedRule[];
  /**
   * One line listing every discovered skill's `name` + one-line
   * `description`, in the same eager style as
   * {@link ruleIndexLine} -- except a skill has no lazy-activation moment to
   * defer to (see `loadSkillsLayer`'s doc comment), so this line IS the
   * skill's presence in the prompt, not a preview of content delivered later.
   * `undefined` when there are no discovered skills (no `.claude/skills`
   * directory, no git root, or every discovered entry was dropped for size).
   */
  skillIndexLine?: string;
  /**
   * Declares, in-band, which skill entries were dropped whole to satisfy
   * {@link SKILLS_LAYER_CAP_BYTES} -- the skills-layer analog of
   * {@link ruleOmissionLine}. `undefined` when nothing was dropped.
   */
  skillOmissionLine?: string;
  /**
   * Memory layer: the rendered header (verbatim from the spec, path
   * substituted) followed by the `MEMORY.md` index content -- or the
   * absent-index line when the file does not exist or cannot be read.
   * `undefined` only when `memoryDir` was not supplied.
   */
  memorySegment?: string;
  /**
   * Memory layer: declares, in-band, which index lines were dropped whole to
   * satisfy {@link MEMORY_LAYER_CAP_BYTES} -- the memory-layer analog of
   * {@link skillOmissionLine}. `undefined` when nothing was dropped.
   */
  memoryOmissionLine?: string;
  /**
   * Memory layer: the activation-time LISTING's declarations, rendered as
   * one block -- `memory files unreadable: <names>`, `memory files not in
   * the index: <names>`, and `memory directory has <N> files; <M> not
   * checked` -- one line each, newline-joined, in that order, only the ones
   * that apply. One field rather than three because they are three facts
   * from ONE `readdir` (see `loadMemoryLayer`) and they render at ONE
   * position in the layer order; "line" here is the sibling-field sense
   * (a declared-in-band block, not a segment). `undefined` when the listing
   * found nothing to declare.
   */
  memoryUnreadableLine?: string;
}

/**
 * Phase B (#1343 R1): a scoped `.claude/rules/*.md` file's identity and glob
 * list, carried outward from `loadRulesLayer` for `RuleActivator` to read
 * lazily -- deliberately WITHOUT `content`, unlike {@link InstructionSegment}.
 * Reading content eagerly here would defeat the point of lazy activation: the
 * whole reason this type exists separately is that a scoped rule's content is
 * NOT loaded until a matching tool call actually arrives.
 */
export interface ScopedRule {
  name: string;
  origin: string;
  globs: string[];
}

export interface AssembleSystemPromptParams {
  context: SystemPromptContext;
  instructions: LoadInstructionsResult;
  definitionSystemPrompt?: string;
}

/**
 * The identity preamble: the ONE place the model is told its own Session ID /
 * Worker ID / Repository ID. Rendered first by BOTH engines
 * (`assembleSystemPrompt` for openai-api, `composeSdkSystemPromptAppend` for
 * claude-sdk) -- a claude-sdk worker without Bash (the default
 * `enabledTools`) has no `AGENT_CONSOLE_*` environment to read, so this text
 * is its only identity source; the env vars the loop subprocess carries are
 * the same ids stated here, for workers that do have a shell.
 */
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
    // Kept short on purpose: this preamble's length feeds the restore-boundary
    // compaction estimate (see main.test.ts's calibrated ~433-char figure).
    'Arguments naming your OWN session or worker (fromSessionId, parentSessionId/parentWorkerId, your own ' +
      'sessionId/workerId) may be omitted: your bearer token supplies them. Other sessionId arguments use the Session ID above.',
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

/**
 * Formats rule segments the same way, under a distinct `--- Rule: ... ---`
 * header so the model can tell an unscoped project rule apart from an
 * instruction file.
 */
export function formatRuleSegments(segments: InstructionSegment[]): string[] {
  return segments.map((segment) => `--- Rule: ${segment.origin} ---\n${segment.content}`);
}

/**
 * The section list both `assembleSystemPrompt` and `composeSdkSystemPromptAppend`
 * concatenate for the instructions+rules body -- everything `loadInstructions`
 * produces except the preamble (rendered by each caller before this) and the
 * definition system prompt (appended by each caller after this, so it always
 * wins on conflict).
 * Single writer of this ordering: instruction segments, then unscoped rule
 * segments, then the scoped-rules index line if present, then the skills
 * index line if present, then the memory layer (its listing declarations,
 * its omission line, then the segment -- last among the discovered layers
 * because it is the agent's own, most specific and most recent knowledge;
 * the definition system prompt each caller appends after this still wins
 * on conflict). All capping already happened inside
 * `loadInstructions`/`loadRulesLayer`/`loadSkillsLayer`/`loadMemoryLayer`
 * -- nothing here re-caps.
 */
function renderInstructionsBody(instructions: LoadInstructionsResult): string[] {
  const sections = [
    ...formatInstructionSegments(instructions.segments),
    ...formatRuleSegments(instructions.ruleSegments ?? []),
  ];
  if (instructions.ruleOmissionLine !== undefined) {
    sections.push(instructions.ruleOmissionLine);
  }
  if (instructions.ruleIndexLine !== undefined) {
    sections.push(instructions.ruleIndexLine);
  }
  if (instructions.skillOmissionLine !== undefined) {
    sections.push(instructions.skillOmissionLine);
  }
  if (instructions.skillIndexLine !== undefined) {
    sections.push(instructions.skillIndexLine);
  }
  if (instructions.memoryUnreadableLine !== undefined) {
    sections.push(instructions.memoryUnreadableLine);
  }
  if (instructions.memoryOmissionLine !== undefined) {
    sections.push(instructions.memoryOmissionLine);
  }
  if (instructions.memorySegment !== undefined) {
    sections.push(instructions.memorySegment);
  }
  return sections;
}

export function assembleSystemPrompt(params: AssembleSystemPromptParams): string {
  const sections: string[] = [buildPreamble(params.context), ...renderInstructionsBody(params.instructions)];

  if (params.definitionSystemPrompt !== undefined && params.definitionSystemPrompt.length > 0) {
    sections.push(params.definitionSystemPrompt);
  }

  return sections.join('\n\n');
}

/**
 * Composes the SDK engine's `systemPrompt.append` string (main.ts's
 * `claude-sdk` init arm): the identity preamble (`buildPreamble`, the same
 * single writer `assembleSystemPrompt` uses -- it goes AFTER the SDK's own
 * `claude_code` preset preamble, which is where an `append`-shaped SDK
 * option composes, and that preset does not know this worker's ids), then
 * the SAME `loadInstructions` result the openai-api arm uses (Phase A, R1)
 * -- global/chain/opt-in segments plus the rules layer, formatted the same
 * way `assembleSystemPrompt` renders them -- followed by the definition
 * system prompt if present. Same parameter shape as `assembleSystemPrompt`
 * so the two callers cannot drift on what they feed in. All capping already
 * happened inside `loadInstructions`, so this does no capping of its own --
 * unlike its pre-Phase-A shape, which capped an opt-in-only list that had
 * never passed through `loadInstructions`. Because the preamble is always
 * present the result is never empty, so `Options.systemPrompt` is always
 * set on the SDK arm (see docs/design/embedded-agent-sdk-engine.md §4.2).
 */
export function composeSdkSystemPromptAppend(params: AssembleSystemPromptParams): string {
  const sections: string[] = [buildPreamble(params.context), ...renderInstructionsBody(params.instructions)];
  if (params.definitionSystemPrompt !== undefined && params.definitionSystemPrompt.length > 0) {
    sections.push(params.definitionSystemPrompt);
  }
  return sections.join('\n\n');
}

type ReadTextResult =
  | { ok: true; content: string }
  | { ok: false; code: string; message: string };

/**
 * Resolves symlinks in `p`, falling back to `p` unchanged if `realpath`
 * fails (e.g. a TOCTOU race where the file vanished between being
 * discovered and this call). Used to make the R1 dedupe comparison
 * symlink-transparent -- see its call site's comment for why comparing raw
 * `path.join` strings against an already-realpath'd `resolveConfinedPath`
 * result is wrong (Architect F1).
 */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsPromises.realpath(p);
  } catch {
    return p;
  }
}

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
 * How much of a `SKILL.md` file `tryReadTextPrefix` reads for the skills layer --
 * generous headroom for a `name:`/`description:` frontmatter block, well
 * under what any reasonable skill would need for just those two fields.
 */
const SKILL_FRONTMATTER_READ_CAP_BYTES = 4 * 1024;

/**
 * Bounded sibling of {@link tryReadTextFile}: reads at most `capBytes` of
 * the file. `Bun.file(...).slice(0, N)` maps a byte range without reading
 * the rest of the file, so a read stays O(cap) instead of O(file size) --
 * the property both callers need when the file's size is author- or
 * model-controlled and nothing downstream reads past the cap. Same
 * error-shape normalization as `tryReadTextFile`, so callers branch
 * identically on `ok`/`code`/`message`.
 *
 * Callers: `loadSkillsLayer`'s per-file loop (only a `SKILL.md`'s
 * `name:`/`description:` frontmatter is needed -- if the closing delimiter
 * falls beyond the cap, {@link FRONTMATTER_RE} simply fails to match and
 * `parseSkillFrontmatter`'s missing-frontmatter fallback runs), and
 * `loadMemoryLayer`'s index read ({@link MEMORY_INDEX_READ_CAP_BYTES}, which
 * detects and declares the remainder itself).
 */
async function tryReadTextPrefix(filePath: string, capBytes: number): Promise<ReadTextResult> {
  try {
    const content = await Bun.file(filePath).slice(0, capBytes).text();
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
export async function findGitRoot(startDir: string): Promise<string | null> {
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
 * fallback. Both present -> log (normal, e.g. a symlinked pair), pick
 * AGENTS.md. Neither present -> null, no log (routine, would be noisy across
 * a deep chain). A candidate that exists but fails to read (EACCES, EISDIR,
 * ...) -> warn log, null (skip, non-fatal).
 *
 * The both-present case uses `console.warn` (stderr), not `console.debug`.
 * In Bun, `console.debug`/`console.log` write to STDOUT, and stdout is the
 * embedded-agent subprocess's NDJSON protocol channel (see
 * docs/design/embedded-agent-worker.md's WebSocket & client protocol
 * section) -- nothing else is ever written there. An unparseable stdout
 * line counts as a protocol-corruption strike server-side
 * (`MAX_CONSECUTIVE_PARSE_FAILURES`, embedded-agent-worker-service.ts),
 * reset on every successfully parsed line, so one stray line here is latent
 * rather than fatal for any realistic tree -- but latent is still a defect,
 * not a feature, and this repo's own root holds both files, so this ran on
 * every openai-api activation here even before the SDK arm doubled its
 * reach (#1343). `console.warn` writes to stderr, which the loop's
 * own stdout-writing convention never touches.
 */
async function resolveDirectoryInstructionFile(dir: string): Promise<InstructionSegment | null> {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const claudePath = path.join(dir, 'CLAUDE.md');

  const agentsResult = await tryReadTextFile(agentsPath);
  if (agentsResult.ok) {
    if (await Bun.file(claudePath).exists()) {
      console.warn(`Both AGENTS.md and CLAUDE.md present in ${dir}; using AGENTS.md`);
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
 * chain (AGENTS.md/CLAUDE.md auto-discovery) layers. Used exclusively by
 * `loadInstructions`, which composes this with the global/chain/rules layers
 * for BOTH engines (Phase A, R1 -- the claude-sdk engine no
 * longer has a separate opt-in-only path; it calls `loadInstructions` the
 * same as openai-api). `settingSources: []` still disables the SDK's OWN
 * native settings-derived discovery (see docs/design/embedded-agent-sdk-engine.md
 * §4) -- this loader is what delivers the equivalent content instead, for
 * both engines, from outside that mechanism.
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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const RULE_SCOPE_KEY_RE = /^(paths|globs):\s*(.*)$/;

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Splits an inline array's inner content on top-level commas only -- commas
 * inside a quoted string or inside `{}`/`[]`/`()` nesting do not split.
 * Needed because a brace-expansion glob like `**\/*.{ts,tsx}` contains a
 * comma that is part of the pattern, not a list separator: a naive
 * `inner.split(',')` on `["**\/*.{ts,tsx}", "src/**"]` yields three broken
 * items instead of two (Architect F2).
 */
function splitInlineArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

/**
 * R2: parses a rule file's `paths:`/`globs:` frontmatter (either spelling;
 * whichever key appears first wins if a file has both). Returns the glob
 * list, or an empty list when the rule is unscoped -- no frontmatter at all
 * (the routine case: most rules in this repo, e.g. `workflow.md`, have none),
 * frontmatter present but no scoping key, `paths: []` (empty), or a value
 * this parser cannot make sense of. Only the last two warn -- absence of
 * scoping is not itself a defect, but a key that IS present and unparseable
 * is, so it is logged rather than silently swallowed.
 *
 * Accepted value shapes: an inline JSON-ish array (`["a", "b"]`), a single
 * scalar on the same line (`"a"` or bare `a`), or the multi-line YAML list
 * this repo's own rules actually use:
 *   paths:
 *     - "a"
 *     - "b"
 */
export function parseRuleFrontmatter(content: string, origin: string): string[] {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return [];

  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(RULE_SCOPE_KEY_RE);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    const inline = rest.trim();

    if (inline.length > 0) {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const inner = inline.slice(1, -1).trim();
        const items = inner.length === 0
          ? []
          : splitInlineArrayItems(inner).map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
        if (items.length === 0) {
          console.warn(`Malformed ${key} frontmatter in ${origin}: empty array; treating as unscoped`);
        }
        return items;
      }
      const scalar = stripQuotes(inline);
      if (scalar.length === 0) {
        console.warn(`Malformed ${key} frontmatter in ${origin}: empty value; treating as unscoped`);
        return [];
      }
      return [scalar];
    }

    // Nothing after the colon -- a multi-line YAML list is expected on the
    // following lines (`  - "glob"` / `  - glob`).
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const listMatch = lines[j].match(/^\s*-\s*(.+)$/);
      if (!listMatch) break;
      items.push(stripQuotes(listMatch[1].trim()));
    }
    if (items.length === 0) {
      console.warn(`Malformed ${key} frontmatter in ${origin}: no list items found; treating as unscoped`);
    }
    return items;
  }

  return [];
}

/**
 * Whole-item drop, largest-first, until `items` fits under `capBytes` (or
 * runs out of items) -- never shrinks a survivor, only removes whole ones.
 * Splice-based removal preserves the relative order of survivors. Shared by
 * `loadRulesLayer` (R3) and `loadSkillsLayer` below: both need the identical
 * "drop the biggest offender until it fits" loop, over different item shapes
 * -- consolidated here per `.claude/rules/workflow.md`'s duplication check
 * rather than reimplementing the loop a second time.
 */
function dropLargestUntilFits<T>(
  items: T[],
  capBytes: number,
  byteLength: (item: T) => number,
): { survivors: T[]; dropped: T[] } {
  const survivors = [...items];
  const dropped: T[] = [];
  const total = () => survivors.reduce((sum, item) => sum + byteLength(item), 0);
  while (total() > capBytes && survivors.length > 0) {
    let largestIdx = 0;
    for (let i = 1; i < survivors.length; i++) {
      if (byteLength(survivors[i]) > byteLength(survivors[largestIdx])) {
        largestIdx = i;
      }
    }
    const [removed] = survivors.splice(largestIdx, 1);
    if (removed !== undefined) dropped.push(removed);
  }
  return { survivors, dropped };
}

interface RuleFile {
  origin: string;
  name: string;
  content: string;
  globs: string[];
}

interface RulesLayerResult {
  ruleSegments: InstructionSegment[];
  ruleOmissionLine?: string;
  ruleIndexLine?: string;
  scopedRules: ScopedRule[];
}

/**
 * R2/R3: the rules layer. Reads every `<gitRoot>/.claude/rules/*.md`, sorted
 * by file name. Unscoped rules (no `paths:`/`globs:` frontmatter) are
 * returned as segments to include eagerly; scoped rules are summarized into
 * `ruleIndexLine` only -- Phase B (not implemented here) is what activates
 * them lazily on a matching tool call. No git root, or no `.claude/rules`
 * directory -- both routine -- produce an empty layer, silently.
 */
async function loadRulesLayer(cwd: string): Promise<RulesLayerResult> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot === null) return { ruleSegments: [], scopedRules: [] };

  const rulesDir = path.join(gitRoot, '.claude', 'rules');
  let entries: string[];
  try {
    entries = (await fsPromises.readdir(rulesDir)).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { ruleSegments: [], scopedRules: [] };
    console.warn(
      `Failed to list rules directory ${rulesDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ruleSegments: [], scopedRules: [] };
  }

  const ruleFiles: RuleFile[] = [];
  for (const name of entries) {
    const origin = path.join(rulesDir, name);
    const read = await tryReadTextFile(origin);
    if (!read.ok) {
      console.warn(`Skipping rule file ${origin}: ${read.message}`);
      continue;
    }
    ruleFiles.push({ origin, name, content: read.content, globs: parseRuleFrontmatter(read.content, origin) });
  }

  const unscoped = ruleFiles.filter((r) => r.globs.length === 0);
  const scoped = ruleFiles.filter((r) => r.globs.length > 0);

  // R3 budget: whole-file drop, largest-first, no per-file truncation.
  const { survivors, dropped } = dropLargestUntilFits(
    unscoped,
    RULES_LAYER_CAP_BYTES,
    (r) => encoder.encode(r.content).length,
  );

  const ruleSegments: InstructionSegment[] = survivors.map((r) => ({ origin: r.origin, content: r.content }));

  let ruleOmissionLine: string | undefined;
  if (dropped.length > 0) {
    const names = dropped.map((r) => r.name).sort().join(', ');
    console.warn(`Dropped rule file(s) to satisfy the ${RULES_LAYER_CAP_BYTES}-byte rules budget: ${names}`);
    ruleOmissionLine = `rules omitted for size: ${names}`;
  }

  let ruleIndexLine: string | undefined;
  if (scoped.length > 0) {
    const items = scoped.map((r) => `${r.name} (paths: ${r.globs.join(', ')})`).join('; ');
    ruleIndexLine = `Rules that apply when you touch matching paths: ${items}`;
  }

  const scopedRules: ScopedRule[] = scoped.map((r) => ({ name: r.name, origin: r.origin, globs: r.globs }));

  return { ruleSegments, ruleOmissionLine, ruleIndexLine, scopedRules };
}

const SKILL_FRONTMATTER_KEY_RE = /^(name|description):\s*(.*)$/;

interface SkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Parses a `SKILL.md` file's `name:`/`description:` frontmatter -- the same
 * shape `.claude/skills/<name>/SKILL.md` files already use for Claude Code's own
 * skill discovery, read here with the identical {@link FRONTMATTER_RE} block
 * extractor {@link parseRuleFrontmatter} uses (single-line scalar values
 * only; this repo's own skill files never span a name/description across
 * multiple lines). Never throws on a missing or malformed value: a missing
 * `name` falls back to `fallbackName` (the skill's own directory name, still
 * identifiable in the index without a frontmatter name), and a missing
 * `description` renders as a name-only entry -- both warn-logged, mirroring
 * how {@link parseRuleFrontmatter} treats a malformed scope as unscoped
 * rather than fatal.
 */
export function parseSkillFrontmatter(
  content: string,
  origin: string,
  fallbackName: string,
): SkillFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    console.warn(
      `Skill file ${origin} has no frontmatter; using directory name "${fallbackName}" with no description`,
    );
    return { name: fallbackName, description: '' };
  }

  let name: string | undefined;
  let description: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = line.match(SKILL_FRONTMATTER_KEY_RE);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    const value = stripQuotes(rest.trim());
    if (value.length === 0) continue;
    if (key === 'name') name = value;
    else description = value;
  }

  if (name === undefined) {
    console.warn(`Skill file ${origin} frontmatter missing "name"; using directory name "${fallbackName}"`);
    name = fallbackName;
  }
  if (description === undefined) {
    console.warn(`Skill file ${origin} frontmatter missing "description"; listing name only`);
    description = '';
  }
  return { name, description };
}

interface SkillFile {
  origin: string;
  name: string;
  description: string;
}

interface SkillsLayerResult {
  skillIndexLine?: string;
  skillOmissionLine?: string;
}

function formatSkillEntry(skill: SkillFile): string {
  return skill.description.length > 0 ? `${skill.name} -- ${skill.description}` : skill.name;
}

/**
 * Recursively collects every `SKILL.md` under `dir`, sorted by full path for
 * deterministic ordering. This repo's own `.claude/skills/<name>/SKILL.md` files
 * sit exactly one level down, but the walk does not assume that depth -- a
 * plugin- or namespace-scoped skill can sit deeper (see the `available-skills`
 * listing's `plugin:skill` / directory-prefixed names), so discovery is a
 * recursive claim, not a fixed-depth one. No `.claude/skills` directory at
 * all -- routine, most repos won't have one yet -- returns `[]` silently,
 * the same treatment `loadRulesLayer`'s missing-rules-directory case gets.
 * A symlinked skill directory is NOT followed: `entry.isDirectory()` /
 * `entry.isFile()` (from `readdir`'s `withFileTypes`, which reports the
 * dirent's own type without resolving symlinks) are both false for a
 * symlink, so it silently drops out of the walk rather than being recursed
 * into or read as `SKILL.md`. Declared here rather than worked around --
 * following symlinks would need a `stat` call plus a cycle guard, out of
 * this change's scope.
 */
async function findSkillFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    console.warn(
      `Failed to list skills directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSkillFiles(full)));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Skills-discovery layer: every `SKILL.md` reachable under
 * `<gitRoot>/.claude/skills/`, parsed for its
 * `name:`/`description:` frontmatter and composed into a single eager index
 * line -- name + one-line description per skill, never the skill's full
 * body. A skill is invoked by the model recognizing relevance from this
 * name/description pair (the same way a terminal Claude Code session's own
 * skill listing works), then reading the full `SKILL.md` on demand via the
 * existing `Read` tool -- there is no lazy-activation moment analogous to a
 * scoped rule's matching tool call (a skill is chosen by the model's
 * judgment, not by a path match), so unlike the rules layer above, a
 * discovered skill is either in the index or explicitly declared dropped for
 * size; none are held back structurally for later injection. No git root, or
 * no `.claude/skills` directory, produces an empty layer silently -- both
 * routine, the same as the rules layer's own absence handling.
 */
async function loadSkillsLayer(cwd: string): Promise<SkillsLayerResult> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot === null) return {};

  const skillsDir = path.join(gitRoot, '.claude', 'skills');
  const files = (await findSkillFiles(skillsDir)).sort();
  if (files.length === 0) return {};

  const skills: SkillFile[] = [];
  for (const origin of files) {
    const read = await tryReadTextPrefix(origin, SKILL_FRONTMATTER_READ_CAP_BYTES);
    if (!read.ok) {
      console.warn(`Skipping skill file ${origin}: ${read.message}`);
      continue;
    }
    const fallbackName = path.basename(path.dirname(origin));
    const { name, description } = parseSkillFrontmatter(read.content, origin, fallbackName);
    skills.push({ origin, name, description });
  }
  if (skills.length === 0) return {};

  const { survivors, dropped } = dropLargestUntilFits(
    skills,
    SKILLS_LAYER_CAP_BYTES,
    (s) => encoder.encode(formatSkillEntry(s)).length,
  );

  const skillIndexLine =
    survivors.length > 0
      ? `Skills available (open the named SKILL.md to read full instructions): ${survivors
          .map(formatSkillEntry)
          .join('; ')}`
      : undefined;

  let skillOmissionLine: string | undefined;
  if (dropped.length > 0) {
    const names = dropped.map((s) => s.name).sort().join(', ');
    console.warn(`Dropped skill entries to satisfy the ${SKILLS_LAYER_CAP_BYTES}-byte skills budget: ${names}`);
    skillOmissionLine = `skills omitted for size: ${names}`;
  }

  return { skillIndexLine, skillOmissionLine };
}

/**
 * Memory layer (epic #1636 Phase 2): the header rendered ABOVE the
 * `MEMORY.md` index, verbatim from docs/design/embedded-agent-worker.md
 * "The header text" with only the path substituted -- the convention is
 * stated in-band where the model can act on it, and the cross-user property
 * from the spec's keying section is stated where it matters.
 *
 * The first-entry clause exists because Edit cannot create a file that does
 * not exist yet, and a literal reader of the earlier wording -- which only
 * described the append-with-Edit / never-Write-rewrite step -- had no
 * permitted way to create the index on a fresh memoryDir: measured in the
 * memory-layer smoke, where the model read the nonce, found MEMORY.md
 * absent, and wrote nothing.
 */
export function formatMemoryHeader(memoryDir: string): string {
  return (
    `--- Memory: ${memoryDir} ---\n` +
    'This directory is your persistent memory for this agent definition on this repository. ' +
    'It is shared with every user who runs this definition on this repository (on a single-user install that is only you): ' +
    "record knowledge about the work, never one person's private details. " +
    'MEMORY.md is its index; its current contents follow. ' +
    'Each memory is one file holding one fact, with frontmatter (name, description, metadata.type: user | feedback | project | reference). ' +
    'After writing a file, add a one-line pointer to MEMORY.md: `- [Title](file.md) — hook` — ' +
    'if MEMORY.md does not exist yet, create it with Write containing that line; ' +
    "otherwise re-read MEMORY.md first, then append the line with Edit anchored on the file's current tail " +
    '(never overwrite an existing MEMORY.md with Write; other sessions may be writing it too). ' +
    'Read a topic file with Read when its hook is relevant; never put memory content in MEMORY.md itself.'
  );
}

/** Rendered in place of the index when `MEMORY.md` is absent or unreadable. */
export const MEMORY_ABSENT_INDEX_LINE = '(no MEMORY.md yet — create it with your first entry)';

export const MEMORY_INDEX_FILE_NAME = 'MEMORY.md';

/**
 * How many names an in-band memory declaration lists before it falls back to
 * "and N more" -- every declaration this layer renders is bounded by it, so a
 * runaway directory cannot turn a one-line declaration into the prompt's
 * largest section.
 */
export const MEMORY_DECLARATION_MAX_NAMES = 20;

/**
 * The index convention's line shape, `- [Title](file.md) — hook`: the link
 * target is what an omission declaration names, because it is the pointer's
 * identity (the title and hook are free text; the target is what the model
 * would `Read`). Only the leading list marker + link are matched -- the hook
 * and its separator are free-form and not part of the shape.
 */
const MEMORY_INDEX_LINK_RE = /^\s*[-*]\s*\[[^\]]*\]\(([^)\s]+)\)/;

function memoryIndexLinkTarget(line: string): string | null {
  const match = line.match(MEMORY_INDEX_LINK_RE);
  if (!match) return null;
  const target = match[1];
  return target.startsWith('./') ? target.slice(2) : target;
}

/**
 * `<label>: a, b, c` for up to {@link MEMORY_DECLARATION_MAX_NAMES} names;
 * past that, the first 20 sorted names plus a count of the rest, so the
 * declaration stays one bounded line however large the directory is.
 */
function formatMemoryDeclaration(label: string, names: string[]): string {
  const sorted = [...names].sort();
  if (sorted.length <= MEMORY_DECLARATION_MAX_NAMES) {
    return `${label}: ${sorted.join(', ')}`;
  }
  const shown = sorted.slice(0, MEMORY_DECLARATION_MAX_NAMES).join(', ');
  return `${label}: ${shown}, and ${sorted.length - MEMORY_DECLARATION_MAX_NAMES} more (${sorted.length} total)`;
}

interface MemoryLayerResult {
  memorySegment: string;
  memoryOmissionLine?: string;
  memoryUnreadableLine?: string;
}

/**
 * Memory layer (epic #1636 Phase 2, READ half): reads exactly ONE file,
 * `<memoryDir>/MEMORY.md`, and renders it under {@link formatMemoryHeader}.
 * Topic files are NEVER loaded eagerly -- the model opens them on demand
 * with `Read`, the same way it opens a `SKILL.md` from the skills index. The
 * index is the presence of memory in the prompt; the topic files are its
 * content.
 *
 * The header is ALWAYS rendered once `memoryDir` is supplied, even when
 * `MEMORY.md` does not exist yet (rendered as {@link MEMORY_ABSENT_INDEX_LINE},
 * not as an absent layer): the WRITE half depends on the model knowing the
 * path and the convention on its very first activation.
 *
 * Over {@link MEMORY_LAYER_CAP_BYTES}, whole index lines are dropped
 * largest-first through the shared {@link dropLargestUntilFits} loop and the
 * loss is declared in-band (`memory index lines omitted for size: ...`,
 * naming the dropped lines' link targets, or counting the ones without the
 * convention's shape) -- the same declared-omission shape the rules and
 * skills layers have. The index's non-list lines (heading, blanks) count
 * toward the budget but are never the largest line in any realistic index.
 *
 * The activation-time listing -- one non-recursive `readdir` plus one access
 * check per regular file, bounded by {@link MEMORY_LAYER_MAX_ENTRIES}, no
 * topic content read -- declares, never silently skips: files the running
 * user cannot read (the umask-077 residue of a shared directory; the model
 * must know an index entry it cannot open is a permissions fact, not a
 * missing memory), files no index line points at (the visible, recoverable
 * form of a lost index update under last-writer-wins), and entries past the
 * cap that were not checked at all. Every declaration is also warn-logged to
 * stderr -- never stdout, which is the subprocess's NDJSON channel (see
 * `resolveDirectoryInstructionFile`'s doc comment).
 */
async function loadMemoryLayer(memoryDir: string): Promise<MemoryLayerResult> {
  const indexPath = path.join(memoryDir, MEMORY_INDEX_FILE_NAME);
  // Bounded read (MEMORY_INDEX_READ_CAP_BYTES): the file is model-written,
  // so its size is not ours to trust at activation time. `Bun.file().size`
  // is a stat, not a read; it tells us whether anything lies past the cap.
  const indexFile = Bun.file(indexPath);
  const indexRead = await tryReadTextPrefix(indexPath, MEMORY_INDEX_READ_CAP_BYTES);
  const indexSizeBytes = indexRead.ok ? indexFile.size : 0;
  const indexTruncated = indexRead.ok && indexSizeBytes > MEMORY_INDEX_READ_CAP_BYTES;

  let indexLines: string[] = [];
  let indexUnreadable = false;
  let unreadBytes = 0;
  if (indexRead.ok) {
    indexLines = indexRead.content.replace(/\r?\n$/, '').split(/\r?\n/);
    if (indexTruncated) {
      // The prefix may end mid-line. Unless it ends exactly at a line
      // boundary, its last segment is a partial line: discarded rather than
      // rendered as if complete, and its bytes are counted with the unread
      // remainder in the declaration.
      const partial = indexRead.content.endsWith('\n') ? '' : (indexLines.pop() ?? '');
      unreadBytes = indexSizeBytes - MEMORY_INDEX_READ_CAP_BYTES + encoder.encode(partial).length;
    }
  } else if (indexRead.code !== 'ENOENT') {
    // Exists but cannot be read: declared below via the listing (it is a
    // regular file the access check also fails on), and rendered as the
    // absent-index line -- a permissions fact, not a missing memory.
    indexUnreadable = true;
    console.warn(`Failed to read memory index ${indexPath}: ${indexRead.message}`);
  }

  // Cap: whole-line drop, largest-first, declared in-band.
  let memoryOmissionLine: string | undefined;
  let surviving = indexLines;
  if (indexLines.length > 0) {
    const { survivors, dropped } = dropLargestUntilFits(
      indexLines,
      MEMORY_LAYER_CAP_BYTES,
      (line) => encoder.encode(line).length,
    );
    surviving = survivors;
    if (dropped.length > 0) {
      const targets: string[] = [];
      let unshaped = 0;
      for (const line of dropped) {
        const target = memoryIndexLinkTarget(line);
        if (target !== null) targets.push(target);
        else unshaped += 1;
      }
      const parts: string[] = [];
      if (targets.length > 0) {
        parts.push(formatMemoryDeclaration('memory index lines omitted for size', targets));
      }
      if (unshaped > 0) {
        parts.push(
          targets.length > 0
            ? `and ${unshaped} line(s) without a link target`
            : `memory index lines omitted for size: ${unshaped} line(s) without a link target`,
        );
      }
      memoryOmissionLine = parts.join(', ');
      console.warn(
        `Dropped ${dropped.length} memory index line(s) to satisfy the ${MEMORY_LAYER_CAP_BYTES}-byte memory budget: ${memoryOmissionLine}`,
      );
    }
  }
  if (indexTruncated) {
    const truncation = `memory index truncated for size: ${unreadBytes} bytes past the first ${MEMORY_INDEX_READ_CAP_BYTES} not read`;
    memoryOmissionLine = memoryOmissionLine === undefined ? truncation : `${memoryOmissionLine}; ${truncation}`;
    console.warn(`Memory index ${indexPath} is ${indexSizeBytes} bytes; ${truncation}`);
  }

  // Listing: one readdir, one access check per regular file, bounded.
  const declarations: string[] = [];
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fsPromises.readdir(memoryDir, { withFileTypes: true });
  } catch (err) {
    // The server creates and verifies this directory before every spawn, so
    // an unlistable directory here is a fact worth declaring, not a routine
    // absence -- but never fatal: the header still tells the model the path.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to list memory directory ${memoryDir}: ${message}`);
    declarations.push(`memory directory could not be listed: ${message}`);
  }

  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const checked = files.slice(0, MEMORY_LAYER_MAX_ENTRIES);
  const unchecked = files.length - checked.length;

  const indexedTargets = new Set<string>();
  for (const line of indexLines) {
    const target = memoryIndexLinkTarget(line);
    if (target !== null) indexedTargets.add(target);
  }

  const unreadable: string[] = [];
  const notInIndex: string[] = [];
  for (const name of checked) {
    let readable = true;
    try {
      await fsPromises.access(path.join(memoryDir, name), fsPromises.constants.R_OK);
    } catch {
      readable = false;
    }
    if (!readable) {
      unreadable.push(name);
      continue;
    }
    if (name !== MEMORY_INDEX_FILE_NAME && !indexedTargets.has(name)) {
      notInIndex.push(name);
    }
  }
  if (indexUnreadable && !unreadable.includes(MEMORY_INDEX_FILE_NAME)) {
    // The read above failed for a reason `access` did not reproduce (e.g. a
    // race, or EISDIR); declare it under the same line anyway.
    unreadable.push(MEMORY_INDEX_FILE_NAME);
  }

  if (unreadable.length > 0) {
    declarations.push(formatMemoryDeclaration('memory files unreadable', unreadable));
  }
  if (notInIndex.length > 0) {
    declarations.push(formatMemoryDeclaration('memory files not in the index', notInIndex));
  }
  if (unchecked > 0) {
    declarations.push(`memory directory has ${files.length} files; ${unchecked} not checked`);
  }
  for (const declaration of declarations) {
    console.warn(`Memory layer (${memoryDir}): ${declaration}`);
  }

  const body = indexRead.ok ? surviving.join('\n') : MEMORY_ABSENT_INDEX_LINE;
  const memorySegment = `${formatMemoryHeader(memoryDir)}\n${body}`;

  return {
    memorySegment,
    ...(memoryOmissionLine !== undefined ? { memoryOmissionLine } : {}),
    ...(declarations.length > 0 ? { memoryUnreadableLine: declarations.join('\n') } : {}),
  };
}

/**
 * Phase B (#1343 R1): how many of {@link RULES_LAYER_CAP_BYTES} the eager
 * unscoped layer already spent for a given `loadInstructions` result -- the
 * figure `RuleActivator`'s caller (main.ts) subtracts from the cap to compute
 * the remaining lazy-activation allowance. Summing `ruleSegments`' own byte
 * lengths here, rather than threading a separate number out of
 * `loadRulesLayer`'s internal budgeting loop, means this can never drift from
 * what `ruleSegments` actually contains -- there is exactly one number that
 * describes "the bytes in these segments", and this computes it directly.
 */
export function rulesLayerBytesUsed(instructions: LoadInstructionsResult): number {
  return (instructions.ruleSegments ?? []).reduce((sum, s) => sum + segmentByteLength(s), 0);
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
  // delegated to loadOptInInstructions. R1 (Phase A): dedupe by REALPATH
  // against the global/chain layers already discovered above, so a
  // definition whose instructions[] still explicitly lists 'CLAUDE.md' (the
  // pre-Phase-A builtin's own convention) does not double-load once the
  // chain tail already resolves the same file. Architect F1: the opt-in
  // side's `origin` is already realpath'd (`resolveConfinedPath`'s
  // `resolvedPath`, path-confinement.ts), but the global/chain side's
  // `origin` is a plain `path.join` result -- comparing the two AS STRINGS
  // misses whenever `cwd` (or the global dir) contains a symlink component
  // (macOS `/tmp` -> `/private/tmp`, `/var/folders/...`, a symlinked
  // worktree), reproducing the exact double-load this dedupe exists to
  // prevent. Both sides go through `realpathOrSelf` so the comparison is
  // symlink-transparent on both ends, not just one.
  const priorOrigins = new Set<string>(
    await Promise.all(
      [...(globalRaw !== null ? [globalRaw.origin] : []), ...chainRaw.map((s) => s.origin)].map(
        realpathOrSelf,
      ),
    ),
  );
  const instructionsRaw = await loadOptInInstructions(cwd, params.instructionsList);
  const instructionRealpaths = await Promise.all(instructionsRaw.map((s) => realpathOrSelf(s.origin)));
  const instructionSegments = instructionsRaw.filter((_, i) => !priorOrigins.has(instructionRealpaths[i]));

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

  // Rules layer (R2/R3): independent budget, independent of the aggregate
  // cap above -- see RULES_LAYER_CAP_BYTES's doc comment.
  const rulesLayer = await loadRulesLayer(cwd);

  // Skills layer: independent budget, same shared shape as the
  // rules layer -- see SKILLS_LAYER_CAP_BYTES's doc comment.
  const skillsLayer = await loadSkillsLayer(cwd);

  // Memory layer (epic #1636 Phase 2): a fourth independent budget; empty
  // and silent when no memoryDir was supplied -- see loadMemoryLayer.
  const memoryLayer = params.memoryDir !== undefined ? await loadMemoryLayer(params.memoryDir) : {};

  return { segments, ...rulesLayer, ...skillsLayer, ...memoryLayer };
}
