import { describe, it, expect } from 'bun:test';
import { BUILTIN_TOOLS, resolveEnabledBuiltinTools } from '../index.js';
import { readTool } from '../read.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';

describe('resolveEnabledBuiltinTools', () => {
  it('resolves the default read-only set when enabledTools is undefined', () => {
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

  it('resolves Bash to zero tools — no registry entry yet (FF-1b will add one)', () => {
    // This test intentionally asserts the CURRENT "inert" behavior: selecting
    // Bash today is a no-op. A future FF-1b PR that registers a bashTool
    // must update this assertion, not leave it silently passing either way.
    const result = resolveEnabledBuiltinTools(['Bash']);
    expect(result).toEqual([]);
  });

  it('BUILTIN_TOOLS contains exactly the implemented tools in registry order', () => {
    expect(BUILTIN_TOOLS).toEqual([readTool, globTool, grepTool]);
  });
});
