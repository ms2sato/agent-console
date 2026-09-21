/**
 * Project `.claude/agents/*.md` discovery for the `claude-sdk` engine (epic
 * #1636 Phase 5 PR-2, docs/design/embedded-agent-sdk-engine.md §4.5
 * "Discovery: who reads what, as whom" -- Subagents bullet).
 *
 * PRECONDITION the caller must enforce, NOT checked here: this function
 * should only be called when `'Task'` is in the worker's enabled tools
 * (§4.5's "no approval gate" text is about the TUI's own lack of a gate for
 * project subagent files, not about whether `Task` is enabled at all --
 * that gating is `sdk-engine.ts`'s `buildOptions()` responsibility, one
 * layer up).
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { findGitRoot, parseCapBytesEnv } from './system-prompt.js';
import { isErrnoException } from './type-guards.js';

const AGENTS_LAYER_CAP_BYTES_DEFAULT = 64 * 1024;

/**
 * @internal Exported for testing -- see `system-prompt.ts`'s
 * `parseRulesLayerCapBytes` doc comment for why this takes the raw env
 * value as a parameter instead of reading `process.env` directly.
 */
export function parseAgentsLayerCapBytes(raw: string | undefined): number {
  return parseCapBytesEnv(raw, AGENTS_LAYER_CAP_BYTES_DEFAULT);
}

/**
 * This layer's own budget -- independent of `RULES_LAYER_CAP_BYTES` /
 * `SKILLS_LAYER_CAP_BYTES` (system-prompt.ts), sized closer to the skills
 * cap than the rules cap because a subagent definition is a name +
 * description + prompt, not a whole instruction file. Overflow drops WHOLE
 * agent definitions, farthest-from-cwd first (never truncated) -- see
 * {@link discoverProjectAgents}.
 */
export const AGENTS_LAYER_CAP_BYTES = parseAgentsLayerCapBytes(process.env.AGENTS_LAYER_CAP_BYTES);

const encoder = new TextEncoder();

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const KEY_RE = /^(name|description|model|tools|mcpServers):\s*(.*)$/;

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Splits an inline `[a, b]` array or a bare comma-separated `a, b` value
 * into raw (not-yet-quote-stripped) item strings. A naive top-level comma
 * split -- this repo's own `.claude/agents/*.md` frontmatter never needs a
 * comma embedded inside one list item, and `parseRuleFrontmatter`
 * (system-prompt.ts) makes the same simplifying assumption for its own
 * inline-array form.
 */
function splitInlineListValue(inline: string): string[] {
  const trimmed = inline.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface RawAgentFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  /** Raw (not-yet-quote-stripped) items -- `tools:` is always a plain-string list. */
  toolsRaw?: string[];
  /**
   * Raw (not-yet-quote-stripped, not-yet-classified) items -- an `mcpServers:`
   * item can be a plain string OR an inline `{ ... }` object; classification
   * happens at the caller, which needs the ORIGINAL (unstripped) text to
   * detect the `{` prefix before any quote-stripping would remove it.
   */
  mcpServersRaw?: string[];
}

/**
 * Extracts an agent file's `name`/`description`/`model`/`tools`/`mcpServers`
 * frontmatter. Returns `null` only when no frontmatter block is found at all
 * (no closing `---` delimiter) -- every other malformed shape (a missing
 * key, an empty list) degrades to an absent field rather than a parse
 * failure, mirroring `parseRuleFrontmatter`'s "malformed -> unscoped" and
 * `parseSkillFrontmatter`'s "malformed -> fallback" tolerance philosophy.
 *
 * NOT `system-prompt.ts`'s `parseSkillFrontmatter`: that function's contract
 * is `name`/`description` scalars only (single-line values), with no
 * concept of a list-valued key. `tools` needs comma-separated-string OR
 * YAML-list support, which is outside that contract, so this is a sibling
 * parser rather than a reuse -- following the SAME frontmatter-block
 * extraction shape (`FRONTMATTER_RE`) and the same "never throw, degrade to
 * absent" philosophy, but generalized to five different keys instead of two.
 */
function parseAgentFrontmatter(
  content: string,
): { frontmatter: RawAgentFrontmatter; bodyStart: number } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const result: RawAgentFrontmatter = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(KEY_RE);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    const inline = rest.trim();

    if (key === 'name' || key === 'description' || key === 'model') {
      if (inline.length > 0) result[key] = stripQuotes(inline);
      continue;
    }

    // tools / mcpServers -- list-valued.
    let items: string[];
    if (inline.length > 0) {
      items = splitInlineListValue(inline);
    } else {
      // Nothing after the colon -- a multi-line YAML list is expected on
      // the following lines (`  - item`).
      items = [];
      for (let j = i + 1; j < lines.length; j++) {
        const listMatch = lines[j].match(/^\s*-\s*(.+)$/);
        if (!listMatch) break;
        items.push(listMatch[1].trim());
      }
    }
    if (key === 'tools') result.toolsRaw = items;
    else result.mcpServersRaw = items;
  }
  return { frontmatter: result, bodyStart: match[0].length };
}

/**
 * Recursively collects every `.md` file under `dir`, mirroring
 * `system-prompt.ts`'s `findSkillFiles` (same symlink-not-followed
 * behavior, same "missing directory is routine" ENOENT handling) but
 * generalized to any `.md` name rather than a fixed `SKILL.md`.
 */
async function findAgentMdFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    console.warn(`Failed to list agents directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findAgentMdFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Directories to scan for `.claude/agents/`, in root-to-cwd order (farthest
 * first) -- mirrors `system-prompt.ts`'s private `buildChainDirs`, which
 * cannot be imported (module-private) and is reimplemented here rather than
 * exported from there, since this is the only other caller. Reduces to
 * `[cwd]` when `cwd` is outside any git repository, same fallback.
 */
async function buildAgentChainDirs(cwd: string): Promise<string[]> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot === null) return [cwd];

  const rel = path.relative(gitRoot, cwd);
  if (rel === '' || rel === '.') return [gitRoot];

  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  const dirs = [gitRoot];
  let current = gitRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

function byteLength(def: AgentDefinition): number {
  return encoder.encode(JSON.stringify(def)).length;
}

/**
 * Discovers every `.claude/agents/*.md` subagent reachable by walking from
 * `cwd` UP to the git root (the TUI's own discovery rule), parses each
 * file's frontmatter, and returns the set to pass through `Options.agents`.
 *
 * Duplicate `name` across levels: the level NEAREST `cwd` wins. Achieved by
 * processing directories farthest-first and letting a `Map.set()` on an
 * already-present key overwrite its VALUE while preserving its original
 * (farthest) iteration POSITION -- which is exactly the property the byte-
 * cap drop order below needs (§4.5: "drop in walk order, farthest first").
 *
 * Skip rules (each logged via `console.warn` naming the file and reason,
 * never thrown): missing `name`; `name` starting with `-`; `name` containing
 * `:`; missing `description`; a frontmatter parse error (no closing `---`).
 *
 * `mcpServers` frontmatter: only plain-STRING entries present in
 * `allowedServerNames` are kept; an inline OBJECT entry, or a string naming
 * a server not in `allowedServerNames`, is dropped with a `console.warn`.
 *
 * Never throws.
 */
export async function discoverProjectAgents(
  cwd: string,
  allowedServerNames: Set<string>,
): Promise<{ agents: Record<string, AgentDefinition>; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = (message: string) => {
    console.warn(message);
    warnings.push(message);
  };

  const chainDirs = await buildAgentChainDirs(cwd);
  const activeMap = new Map<string, AgentDefinition>();

  for (const dir of chainDirs) {
    const agentsDir = path.join(dir, '.claude', 'agents');
    const files = (await findAgentMdFiles(agentsDir)).sort();

    for (const filePath of files) {
      let content: string;
      try {
        content = await Bun.file(filePath).text();
      } catch (err) {
        warn(`Skipping agent file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const parsed = parseAgentFrontmatter(content);
      if (parsed === null) {
        warn(`Skipping agent file ${filePath}: no frontmatter block found`);
        continue;
      }
      const { frontmatter: raw, bodyStart } = parsed;
      if (raw.name === undefined) {
        warn(`Skipping agent file ${filePath}: frontmatter missing "name"`);
        continue;
      }
      if (raw.name.startsWith('-')) {
        warn(`Skipping agent file ${filePath}: name "${raw.name}" starts with "-"`);
        continue;
      }
      if (raw.name.includes(':')) {
        warn(`Skipping agent file ${filePath}: name "${raw.name}" contains ":"`);
        continue;
      }
      if (raw.description === undefined) {
        warn(`Skipping agent file ${filePath}: frontmatter missing "description"`);
        continue;
      }

      const prompt = content.slice(bodyStart).trim();

      const tools = (raw.toolsRaw ?? []).map((item) => stripQuotes(item)).filter((item) => item.length > 0);

      const mcpServers: string[] = [];
      for (const item of raw.mcpServersRaw ?? []) {
        const trimmed = item.trim();
        if (trimmed.startsWith('{')) {
          warn(`Agent file ${filePath}: dropping inline object mcpServers entry "${trimmed}" -- only plain server-name references are honored`);
          continue;
        }
        const name = stripQuotes(trimmed);
        if (!allowedServerNames.has(name)) {
          warn(`Agent file ${filePath}: dropping mcpServers reference "${name}" -- not an allowed project server`);
          continue;
        }
        mcpServers.push(name);
      }

      const definition: AgentDefinition = {
        description: raw.description,
        prompt,
        ...(tools.length > 0 ? { tools } : {}),
        ...(raw.model !== undefined ? { model: raw.model } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
      };
      activeMap.set(raw.name, definition);
    }
  }

  // Byte-cap overflow: drop whole definitions, farthest-from-cwd first
  // (Map iteration order == first-insertion order, which IS farthest-first
  // -- see this function's own doc comment).
  const entries = [...activeMap.entries()];
  let totalBytes = entries.reduce((sum, [, def]) => sum + byteLength(def), 0);
  while (totalBytes > AGENTS_LAYER_CAP_BYTES && entries.length > 0) {
    const dropped = entries.shift();
    if (dropped === undefined) break;
    const [name, def] = dropped;
    totalBytes -= byteLength(def);
    warn(`Dropped agent definition "${name}" to satisfy the ${AGENTS_LAYER_CAP_BYTES}-byte agents budget`);
  }

  return { agents: Object.fromEntries(entries), warnings };
}
