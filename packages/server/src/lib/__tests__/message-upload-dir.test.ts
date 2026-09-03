import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'os';
import { resolveUploadDir } from '../message-upload-dir.js';

describe('resolveUploadDir', () => {
  it('returns a path under the OS temp dir, namespaced by the current euid (or "shared" when unavailable)', () => {
    const dir = resolveUploadDir();
    const suffix = typeof process.geteuid === 'function' ? String(process.geteuid()) : 'shared';

    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toContain('agent-console-uploads-');
    expect(dir.endsWith(`agent-console-uploads-${suffix}`)).toBe(true);
  });

  it('is pure and deterministic -- repeated calls return the identical path', () => {
    expect(resolveUploadDir()).toBe(resolveUploadDir());
  });
});
