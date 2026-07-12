import { describe, it, expect } from 'bun:test';
import { BUILTIN_TOOLS, resolveEnabledBuiltinTools } from '../index.js';
import { readTool } from '../read.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';
import { bashTool } from '../bash.js';

describe('resolveEnabledBuiltinTools', () => {
  it('resolves the default read-only set when enabledTools is undefined (Bash stays off by default)', () => {
    const result = resolveEnabledBuiltinTools(undefined);
    expect(result).toEqual([readTool, globTool, grepTool]);
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

  it('resolves all four tools when explicitly enabled in order', () => {
    const result = resolveEnabledBuiltinTools(['Read', 'Glob', 'Grep', 'Bash']);
    expect(result).toEqual([readTool, globTool, grepTool, bashTool]);
  });

  it('BUILTIN_TOOLS contains exactly the implemented tools in registry order', () => {
    expect(BUILTIN_TOOLS).toEqual([readTool, globTool, grepTool, bashTool]);
  });
});
