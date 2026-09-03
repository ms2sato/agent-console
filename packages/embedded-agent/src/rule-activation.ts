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
 */

import { Glob } from 'bun';
import * as path from 'node:path';
import type { ScopedRule } from './system-prompt.js';

export interface ActivationBlock {
  text: string;
  /** Rule names skipped THIS call because their content exceeded the
   * remaining budget -- R2's "[rule not activated for size: <name>]" line. */
  skippedForSize: string[];
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

/** R3: builtin tools whose sole path-shaped argument is a FILE to operate on. */
const FILE_ARG_KEY: Partial<Record<string, string>> = {
  Read: 'path',
  Write: 'file_path',
  Edit: 'file_path',
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
   * name never carries one (the majority of tool names) or the relevant
   * argument is absent/not-a-string. `args` is deliberately `unknown` here,
   * not `Record<string, unknown>`: the caller (`CompositeToolExecutor`)
   * forwards whatever shape a tool call happened to parse to, and this
   * method must stay tolerant of anything short of throwing.
   */
  private resolveCandidate(toolName: string, args: unknown): PathCandidate | null {
    const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

    const fileKey = FILE_ARG_KEY[toolName];
    if (fileKey !== undefined) {
      const raw = a[fileKey];
      return typeof raw === 'string' ? this.toRelativeCandidate(raw, false) : null;
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

    return { text: sections.join('\n\n'), skippedForSize };
  }
}
