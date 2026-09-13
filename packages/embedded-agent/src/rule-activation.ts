/**
 * Lazy scoped-rule activation for the `openai-api` engine (Phase B,
 * openai-api slice; see docs/design/embedded-agent-worker.md's instruction
 * loader section for the normative spec).
 *
 * `loadInstructions`'s rules layer (system-prompt.ts) already reads every
 * `.claude/rules/*.md` file at activation time: unscoped rules go straight
 * into the system prompt, while a rule with `paths:`/`globs:` frontmatter is
 * only summarized into `ruleIndexLine` -- its own content is read once, then
 * discarded, so nothing downstream can reach it. `RuleActivator` is what
 * makes that content reachable: the first time a builtin tool call's path
 * argument matches a scoped rule's globs, the rule's full content is
 * activated -- appended to that tool call's result (R2) via
 * `CompositeToolExecutor`, see its own doc comment -- instead of the model
 * only ever seeing the index line.
 *
 * R1: this class never talks to the provider or the conversation directly.
 * It exposes one PURE query, {@link RuleActivator.matchScopedRules}, and one
 * EFFECTFUL command, {@link RuleActivator.activate}; the caller decides what
 * to do with the result. Each rule activates at most once per incarnation --
 * {@link RuleActivator.seedActivated} lets the caller pre-mark names a
 * restored transcript already shows as activated (R4), without re-spending
 * budget for them.
 *
 * R3 defines the match table this class implements: `Read`'s `path`,
 * `Write`/`Edit`'s `file_path`, and `Glob`/`Grep`'s optional `path` (matched
 * as a directory candidate via a synthetic never-real filename) are the only
 * arguments ever consulted. Every other tool name -- `Bash`, `TodoWrite`,
 * `Compact`, any MCP tool -- never matches, by construction: the matcher is
 * keyed on tool NAME first, so it never inspects `args` for a name outside
 * the two tables below.
 *
 * R3's SDK-arm extension (#1343 Phase B, claude-sdk slice): the native
 * `claude` CLI's own builtin `Read` uses `file_path`, NOT `path` --
 * openai-api's embedded `Read` tool (a completely different implementation)
 * uses `path`. This class is shared by BOTH engine adapters (R1: "One
 * activator, two adapters"), so `FILE_ARG_KEYS` maps a tool name to an
 * ORDERED array of candidate argument keys rather than a single key --
 * trying each in turn and using the first string value found. This is safe
 * for both engines simultaneously: openai-api's `Read` call never carries a
 * `file_path` key, so trying it and finding nothing is harmless; the native
 * CLI's `Read` never carries a `path` key. No engine-specific branching is
 * needed inside this class at all. `NotebookEdit` (`notebook_path`) is an
 * SDK-arm-only tool -- openai-api has no such builtin, so that key is simply
 * never present there.
 */

import { Glob } from 'bun';
import * as path from 'node:path';
import type { ScopedRule } from './system-prompt.js';

export interface ActivationBlock {
  text: string;
  /** Rule names skipped THIS call because their content exceeded the
   * remaining budget -- R2's "[rule not activated for size: <name>]" line. */
  skippedForSize: string[];
  /**
   * Rule names ACTUALLY activated by this call (never the size-skipped
   * ones) -- the structural fact `text`'s `[rule activated: <name>]` lines
   * ALSO carry as human-visible prose. Threaded onward to
   * `ToolCallOutcome.activatedRules` and the `tool-result` wire event's
   * `activatedRules` field so restore-seeding (main.ts) never has to parse
   * it back out of `text` (#1343 R4 -- a tool output that happens to
   * CONTAIN the marker substring must never be misread as a real
   * activation).
   */
  activatedNames: string[];
}

/**
 * Narrow surface `CompositeToolExecutor` depends on, so a test can supply a
 * plain object double instead of constructing a real `RuleActivator` backed
 * by real filesystem reads (testing.md "Isolation").
 */
export interface RuleActivatorLike {
  matchScopedRules(toolName: string, args: unknown): string[];
  activate(names: string[]): Promise<ActivationBlock | null>;
}

export interface RuleActivatorParams {
  scopedRules: ScopedRule[];
  gitRoot: string;
  cwd: string;
  /**
   * Total lazy-activation allowance for this incarnation -- the caller passes
   * `RULES_LAYER_CAP_BYTES` minus whatever the eager unscoped layer already
   * consumed (see `rulesLayerBytesUsed` in system-prompt.ts). Decremented as
   * rules activate; never replenished within an incarnation.
   */
  remainingBudgetBytes: number;
}

const encoder = new TextEncoder();

/**
 * R3: builtin tools whose path-shaped argument is a FILE to operate on,
 * keyed to an ORDERED array of candidate argument names -- see this file's
 * header comment ("R3's SDK-arm extension") for why an array rather than a
 * single key. `path` is tried before `file_path` for `Read` purely by
 * convention (openai-api's own shape listed first); no real tool call is
 * expected to carry both keys, so the ordering has no observed production
 * effect -- see `resolveCandidate`'s doc comment for the pinned tie-break
 * behavior in that hypothetical case.
 */
const FILE_ARG_KEYS: Partial<Record<string, readonly string[]>> = {
  Read: ['path', 'file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

/**
 * R3: builtin tools whose OPTIONAL `path` argument is a DIRECTORY to search
 * under. Absent, there is no candidate at all -- Glob/Grep with no `path`
 * matches nothing, it does not fall back to `cwd`.
 */
const DIR_ARG_TOOLS = new Set(['Glob', 'Grep']);

interface PathCandidate {
  /** `gitRoot`-relative path (POSIX-style, matching how globs in this repo's
   * rule frontmatter are written). */
  rel: string;
  isDirectory: boolean;
}

/** A rule paired with the content `activate()` just read for it. */
interface ActivatedRule extends ScopedRule {
  content: string;
}

export class RuleActivator implements RuleActivatorLike {
  private readonly rulesByName: Map<string, ScopedRule>;
  private readonly activated = new Set<string>();
  private remainingBudgetBytes: number;

  constructor(private readonly params: RuleActivatorParams) {
    this.rulesByName = new Map(params.scopedRules.map((r) => [r.name, r]));
    this.remainingBudgetBytes = params.remainingBudgetBytes;
  }

  /**
   * R4: pre-marks `names` as already activated, without touching the budget.
   * Used at restore (main.ts) to reflect that an EARLIER incarnation already
   * spent these rules' bytes in the conversation the model is resuming
   * into -- this incarnation's own budget bookkeeping starts fresh
   * regardless; it is not reconstructed from the prior incarnation's state.
   */
  seedActivated(names: string[]): void {
    for (const name of names) this.activated.add(name);
  }

  /**
   * R3: pure -- reads no file, mutates no state. Returns the names of
   * not-yet-activated scoped rules whose globs match this call.
   */
  matchScopedRules(toolName: string, args: unknown): string[] {
    const candidate = this.resolveCandidate(toolName, args);
    if (candidate === null) return [];

    // Glob/Grep's directory candidate is tested via a synthetic, never-real
    // filename appended under it -- "the rule would apply to something under
    // that directory" is the property being tested, not that the directory
    // itself is a file match.
    const matchTarget = candidate.isDirectory
      ? candidate.rel.length > 0
        ? `${candidate.rel}/x`
        : 'x'
      : candidate.rel;

    const names: string[] = [];
    for (const rule of this.params.scopedRules) {
      if (this.activated.has(rule.name)) continue;
      if (rule.globs.some((g) => new Glob(g).match(matchTarget))) {
        names.push(rule.name);
      }
    }
    return names;
  }

  /**
   * Resolves the tool-name-keyed path candidate, or `null` when this tool
   * name never carries one (the majority of tool names) or none of its
   * candidate arguments are present/a string. `args` is deliberately
   * `unknown` here, not `Record<string, unknown>`: the caller
   * (`CompositeToolExecutor`) forwards whatever shape a tool call happened to
   * parse to, and this method must stay tolerant of anything short of
   * throwing.
   *
   * When a tool name's candidate-key array has more than one entry (`Read`'s
   * `['path', 'file_path']`), the FIRST key in the array whose value is a
   * string wins -- so `path` beats `file_path` if a call somehow carried
   * both. No real tool call is expected to carry both keys (openai-api's
   * `Read` never has `file_path`; the native CLI's `Read` never has `path`),
   * so this tie-break has no observed production effect; it exists only so
   * the behavior is a documented, pinned choice rather than silently
   * undefined for a shape that should not occur.
   */
  private resolveCandidate(toolName: string, args: unknown): PathCandidate | null {
    const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

    const fileKeys = FILE_ARG_KEYS[toolName];
    if (fileKeys !== undefined) {
      for (const key of fileKeys) {
        const raw = a[key];
        if (typeof raw === 'string') return this.toRelativeCandidate(raw, false);
      }
      return null;
    }
    if (DIR_ARG_TOOLS.has(toolName)) {
      const raw = a.path;
      return typeof raw === 'string' ? this.toRelativeCandidate(raw, true) : null;
    }
    // Any other tool name -- Bash, TodoWrite, Compact, any MCP tool -- never
    // matches. Nothing above ever reads `args` for a name outside the two
    // tables, so a Bash call whose args happen to contain a path-shaped
    // string still can never produce a candidate.
    return null;
  }

  /**
   * Resolves `raw` against `cwd` (if relative) to an absolute path, then
   * expresses it relative to `gitRoot`. A candidate outside `gitRoot` (its
   * relative path starts with `..`) matches nothing -- R3.
   */
  private toRelativeCandidate(raw: string, isDirectory: boolean): PathCandidate | null {
    const absolute = path.isAbsolute(raw) ? raw : path.join(this.params.cwd, raw);
    const rel = path.relative(this.params.gitRoot, absolute);
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
    return { rel, isDirectory };
  }

  /**
   * R1/R2: effectful. Activates every not-yet-activated name in `names`
   * (caller-given order), reading each rule's file fresh.
   *
   * - A rule whose file vanished since index time is warn-logged and
   *   skipped: never activated, never counted in `skippedForSize`.
   * - A rule whose content exceeds the remaining budget is reported in
   *   `skippedForSize` and left un-activated. The budget only ever shrinks
   *   within an incarnation, so a size-skipped rule will typically stay
   *   skipped for the rest of it -- but this method does not assume that; a
   *   later call for the same name simply re-reads and re-checks. The
   *   re-read is a little wasteful in the common case (the outcome rarely
   *   changes), but it is the simplest implementation that stays correct if
   *   that assumption ever stops holding, and rule files are small enough
   *   that the extra read is not worth guarding against.
   *
   * Returns `null` when nothing was activated and nothing was skipped for
   * size (every requested name was already activated, unknown, or vanished).
   */
  async activate(names: string[]): Promise<ActivationBlock | null> {
    const activatedRules: ActivatedRule[] = [];
    const skippedForSize: string[] = [];

    for (const name of names) {
      if (this.activated.has(name)) continue;
      const rule = this.rulesByName.get(name);
      if (rule === undefined) continue;

      let content: string;
      try {
        content = await Bun.file(rule.origin).text();
      } catch (err) {
        console.warn(
          `Rule "${rule.name}" (${rule.origin}) vanished since index time; skipping activation: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const byteLength = encoder.encode(content).length;
      if (byteLength > this.remainingBudgetBytes) {
        skippedForSize.push(name);
        continue;
      }

      this.activated.add(name);
      this.remainingBudgetBytes -= byteLength;
      activatedRules.push({ ...rule, content });
    }

    if (activatedRules.length === 0 && skippedForSize.length === 0) {
      return null;
    }

    const sortedActivated = [...activatedRules].sort((a, b) => a.name.localeCompare(b.name));
    const blocks = sortedActivated.map(
      (r) =>
        `[rule activated: ${r.name}]\n--- Rule (applies to: ${r.globs.join(', ')}): ${r.origin} ---\n${r.content}`,
    );

    const sections = [...blocks];
    if (skippedForSize.length > 0) {
      const sortedSkipped = [...skippedForSize].sort();
      sections.push(`[rule not activated for size: ${sortedSkipped.join(', ')}]`);
    }

    return {
      text: sections.join('\n\n'),
      skippedForSize,
      activatedNames: sortedActivated.map((r) => r.name),
    };
  }
}
