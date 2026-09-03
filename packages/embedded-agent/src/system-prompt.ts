/**
 * System-prompt assembly for the embedded-agent loop.
 *
 * The prompt is assembled once per activation. `loadInstructions` discovers
 * instruction files across FOUR layers -- global (`~/.config/agent-console`),
 * chain (git root down to cwd), an opt-in `EmbeddedAgentDefinition.instructions`
 * file list, and the `.claude/rules/*.md` rules layer (unscoped rules included,
 * scoped rules listed in an index line only -- see `loadRulesLayer` below) --
 * then `assembleSystemPrompt` concatenates: (1) context preamble -> (2)
 * discovered/opt-in instruction segments, in discovery order -> (3) the rules
 * layer -> (4) the operator-configured definition system prompt (last, so it
 * wins on conflict). Used identically by both engines (claude-sdk composes
 * the same layers via `composeSdkSystemPromptAppend`, minus the preamble --
 * see its doc comment).
 *
 * See docs/design/embedded-agent-worker.md "Instruction loader" for the
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
const RULES_LAYER_CAP_BYTES_DEFAULT = 160 * 1024;

/**
 * Non-positive or non-numeric env values fall back to the default rather
 * than surviving as-is -- a bare `Number(env) || default` lets a NEGATIVE
 * override through unclamped (e.g. `Number('-5') === -5`, which is truthy,
 * so `-5 || default` evaluates to `-5`), and a negative budget drops every
 * rule on the very first over-budget check (Architect N1).
 */
/** @internal Exported for testing -- takes the raw env value as a parameter
 * rather than reading `process.env` directly, so a test can exercise the
 * clamping logic without needing a module re-import per env value. */
export function parseRulesLayerCapBytes(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : RULES_LAYER_CAP_BYTES_DEFAULT;
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
 * produces except the preamble (caller-specific) and the definition system
 * prompt (appended by each caller after this, so it always wins on conflict).
 * Single writer of this ordering: instruction segments, then unscoped rule
 * segments, then the scoped-rules index line if present. All capping already
 * happened inside `loadInstructions`/`loadRulesLayer` -- nothing here re-caps.
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
 * `claude-sdk` init arm): the SAME `loadInstructions` result the openai-api
 * arm uses (Phase A, R1) -- global/chain/opt-in segments plus the
 * rules layer, formatted the same way `assembleSystemPrompt` renders them,
 * followed by the definition system prompt if present -- minus the preamble
 * (the SDK engine uses the SDK's own `claude_code` preset preamble instead of
 * ours, so `buildPreamble` must not run here). All capping already happened
 * inside `loadInstructions`, so this does no capping of its own -- unlike its
 * pre-Phase-A shape, which capped an opt-in-only list that had never passed
 * through `loadInstructions`. Returns `undefined` when there is nothing to
 * append, so callers can omit `Options.systemPrompt` entirely rather than
 * passing an empty string (see docs/design/embedded-agent-sdk-engine.md §4's
 * "Instruction loader" row correction).
 */
export function composeSdkSystemPromptAppend(
  instructions: LoadInstructionsResult,
  definitionSystemPrompt: string | undefined,
): string | undefined {
  const sections = renderInstructionsBody(instructions);
  if (definitionSystemPrompt !== undefined && definitionSystemPrompt.length > 0) {
    sections.push(definitionSystemPrompt);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
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
  if (gitRoot === null) return { ruleSegments: [] };

  const rulesDir = path.join(gitRoot, '.claude', 'rules');
  let entries: string[];
  try {
    entries = (await fsPromises.readdir(rulesDir)).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { ruleSegments: [] };
    console.warn(
      `Failed to list rules directory ${rulesDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ruleSegments: [] };
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
  // Splice-based removal preserves the relative (name) order of survivors.
  const survivors = [...unscoped];
  const dropped: RuleFile[] = [];
  const total = () => survivors.reduce((sum, r) => sum + encoder.encode(r.content).length, 0);
  while (total() > RULES_LAYER_CAP_BYTES && survivors.length > 0) {
    let largestIdx = 0;
    for (let i = 1; i < survivors.length; i++) {
      if (encoder.encode(survivors[i].content).length > encoder.encode(survivors[largestIdx].content).length) {
        largestIdx = i;
      }
    }
    const [removed] = survivors.splice(largestIdx, 1);
    if (removed !== undefined) dropped.push(removed);
  }

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

  return { ruleSegments, ruleOmissionLine, ruleIndexLine };
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

  return { segments, ...rulesLayer };
}
