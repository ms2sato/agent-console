/**
 * The `Compact` tool's engine-neutral surface.
 *
 * The load-bearing assertion here is the containment one: `Compact` must not
 * be reachable from `enabledTools`. That is a claim about the RELATIONSHIP
 * between two modules (this tool's name and the capability registry's name
 * list), which neither module can state on its own, and which a future change
 * to either could break silently -- adding `'Compact'` to
 * `EMBEDDED_AGENT_TOOL_NAMES` would compile, would look like tidying, and
 * would quietly make the tool gateable.
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS,
  EMBEDDED_AGENT_TOOL_NAMES,
} from '@agent-console/shared';
import { BUILTIN_TOOLS } from '../tools/index.js';
import {
  COMPACT_TOOL_NAME,
  COMPACT_TOOL_SCHEDULED_RESULT,
  COMPACT_TOOL_UNSUPPORTED_RESULT,
  compactToolDefinition,
} from '../compact-tool.js';

describe('Compact — the self-management tool class', () => {
  it('is NOT a member of the capability registry, so no enabledTools value can reach it', () => {
    expect(EMBEDDED_AGENT_TOOL_NAMES as readonly string[]).not.toContain(COMPACT_TOOL_NAME);
    expect(DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS as readonly string[]).not.toContain(
      COMPACT_TOOL_NAME,
    );
  });

  it('is NOT in BUILTIN_TOOLS either, so resolveEnabledBuiltinTools can never produce it', () => {
    expect(BUILTIN_TOOLS.map((t) => t.name as string)).not.toContain(COMPACT_TOOL_NAME);
  });
});

describe('Compact — the published definition', () => {
  it('takes no parameters, and refuses extras rather than ignoring them', () => {
    // "No parameters" has two halves: an empty `properties`, and
    // `additionalProperties: false`. Without the second, a model could pass
    // arguments that silently do nothing -- an affordance that looks real and
    // is not.
    expect(compactToolDefinition.name).toBe(COMPACT_TOOL_NAME);
    expect(compactToolDefinition.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('describes when it runs, not just what it does', () => {
    // The reservation is the one surprising part of this tool's contract: the
    // model calls it mid-turn and nothing happens until the turn ends. The
    // description has to say so, or the model reads a no-op as a failure and
    // calls it again.
    expect(compactToolDefinition.description).toBeDefined();
    expect(compactToolDefinition.description!.toLowerCase()).toContain('turn');
  });
});

describe('Compact — result strings', () => {
  it('distinguishes the scheduled result from the automatic-only one', () => {
    expect(COMPACT_TOOL_SCHEDULED_RESULT).not.toBe(COMPACT_TOOL_UNSUPPORTED_RESULT);
  });

  it('states that the scheduled compaction runs at the end of the turn', () => {
    expect(COMPACT_TOOL_SCHEDULED_RESULT).toContain('turn');
  });

  it('explains the automatic-only case instead of reporting a bare failure', () => {
    // An engine that cannot compact on demand still registers the tool, so
    // the model can say WHY it cannot comply. A result that just said "error"
    // would leave it guessing.
    expect(COMPACT_TOOL_UNSUPPORTED_RESULT.toLowerCase()).toContain('automatic');
  });
});
