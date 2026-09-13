import { describe, it, expect } from 'bun:test';
import { BUILTIN_TOOLS, resolveEnabledBuiltinTools } from '../index.js';
import { readTool } from '../read.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';
import { bashTool } from '../bash.js';
import { writeTool } from '../write.js';
import { editTool } from '../edit.js';

describe('resolveEnabledBuiltinTools', () => {
  it('resolves the default read-only set when enabledTools is undefined (Bash/Write/Edit stay off, TodoWrite stays on by default)', () => {
    const result = resolveEnabledBuiltinTools(undefined);

    // TodoWrite is constructed fresh per call (see index.ts's header comment
    // on BUILTIN_TOOLS), so it is never reference-equal to a shared singleton
    // -- assert on shape instead of a `toEqual` deep-equal against a fixture
    // instance.
    expect(result).toHaveLength(4);
    expect(result.slice(0, 3)).toEqual([readTool, globTool, grepTool]);
    expect(result[3]?.name).toBe('TodoWrite');
    expect(result).not.toContain(writeTool);
    expect(result).not.toContain(editTool);
  });

  it('resolves TodoWrite to a fresh instance each call, not a shared singleton', () => {
    const first = resolveEnabledBuiltinTools(['TodoWrite']);
    const second = resolveEnabledBuiltinTools(['TodoWrite']);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.name).toBe('TodoWrite');
    expect(second[0]?.name).toBe('TodoWrite');
    expect(first[0]).not.toBe(second[0]);
  });

  it('does not resolve TodoWrite when enabledTools explicitly omits it', () => {
    const result = resolveEnabledBuiltinTools(['Read']);
    expect(result.map((t) => t.name)).toEqual(['Read']);
    expect(result.some((t) => t.name === 'TodoWrite')).toBe(false);
  });

  it('resolves to zero tools when enabledTools is an explicit empty array (policy-off)', () => {
    const result = resolveEnabledBuiltinTools([]);
    expect(result).toEqual([]);
  });

  it('resolves to only the requested tool when a single name is given', () => {
    const result = resolveEnabledBuiltinTools(['Grep']);
    expect(result).toEqual([grepTool]);
  });

  it('resolves Bash to the bashTool now that FF-1b registered it', () => {
    const result = resolveEnabledBuiltinTools(['Bash']);
    expect(result).toEqual([bashTool]);
  });

  it('resolves Write/Edit to their tools now that FF-1c registered them', () => {
    const result = resolveEnabledBuiltinTools(['Write', 'Edit']);
    expect(result).toEqual([writeTool, editTool]);
  });

  it('resolves all six tools when explicitly enabled in order', () => {
    const result = resolveEnabledBuiltinTools(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit']);
    expect(result).toEqual([readTool, globTool, grepTool, bashTool, writeTool, editTool]);
  });

  it('BUILTIN_TOOLS contains exactly the implemented tools in registry order', () => {
    expect(BUILTIN_TOOLS).toEqual([readTool, globTool, grepTool, bashTool, writeTool, editTool]);
    // TodoWrite is deliberately excluded from this shared-singleton registry
    // -- it carries per-incarnation state and is constructed fresh by
    // resolveEnabledBuiltinTools instead. See index.ts's header comment.
    expect(BUILTIN_TOOLS.map((t) => t.name)).not.toContain('TodoWrite');
  });
});
