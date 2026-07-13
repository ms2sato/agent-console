import { describe, it, expect } from 'bun:test';
import { BUILTIN_TOOLS, resolveEnabledBuiltinTools } from '../index.js';
import { readTool } from '../read.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';
import { bashTool } from '../bash.js';
import { writeTool } from '../write.js';
import { editTool } from '../edit.js';

describe('resolveEnabledBuiltinTools', () => {
  it('resolves the default read-only set when enabledTools is undefined (Bash/Write/Edit stay off by default)', () => {
    const result = resolveEnabledBuiltinTools(undefined);
    expect(result).toEqual([readTool, globTool, grepTool]);
    expect(result).not.toContain(writeTool);
    expect(result).not.toContain(editTool);
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
  });
});
