import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHandoffPrompt, DEFAULT_HANDOFF_PROMPT } from '../handoff-prompt.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-handoff-prompt-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Isolates a test from the real OS home directory's global config: points
 * `xdgConfigHome` at a fresh, empty temp dir so the global layer resolves
 * ENOENT (silently absent) instead of reading whatever `~/.config` happens to
 * contain on the machine running the test.
 */
async function isolatedXdgConfigHome(): Promise<string> {
  return makeTempDir();
}

describe('loadHandoffPrompt — 3-layer override precedence', () => {
  it('repo layer wins over global and bundled when all three exist', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, '.agent-console'), { recursive: true });
    await writeFile(join(cwd, '.agent-console', 'handoff-prompt.md'), 'REPO_PROMPT');

    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'handoff-prompt.md'), 'GLOBAL_PROMPT');

    const result = await loadHandoffPrompt({ cwd, xdgConfigHome });

    expect(result).toEqual({ content: 'REPO_PROMPT', origin: 'repo' });
  });

  it('global layer wins over bundled when repo is absent', async () => {
    const cwd = await makeTempDir();
    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'handoff-prompt.md'), 'GLOBAL_PROMPT');

    const result = await loadHandoffPrompt({ cwd, xdgConfigHome });

    expect(result).toEqual({ content: 'GLOBAL_PROMPT', origin: 'global' });
  });

  it('returns the bundled default when neither repo nor global is present', async () => {
    const cwd = await makeTempDir();

    const result = await loadHandoffPrompt({ cwd, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result).toEqual({ content: DEFAULT_HANDOFF_PROMPT, origin: 'bundled-default' });
  });

  it('does not read the global or bundled layer content when the repo layer wins (override, not concatenation)', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, '.agent-console'), { recursive: true });
    await writeFile(join(cwd, '.agent-console', 'handoff-prompt.md'), 'REPO_ONLY');

    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'handoff-prompt.md'), 'GLOBAL_SHOULD_NOT_APPEAR');

    const result = await loadHandoffPrompt({ cwd, xdgConfigHome });

    expect(result.content).not.toContain('GLOBAL_SHOULD_NOT_APPEAR');
    expect(result.content).not.toContain(DEFAULT_HANDOFF_PROMPT);
  });
});

describe('loadHandoffPrompt — 16 KiB cap', () => {
  it('truncates an oversized repo prompt to the cap and warn-logs', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, '.agent-console'), { recursive: true });
    const oversized = 'x'.repeat(20 * 1024);
    await writeFile(join(cwd, '.agent-console', 'handoff-prompt.md'), oversized);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadHandoffPrompt({
        cwd,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.origin).toBe('repo');
      expect(new TextEncoder().encode(result.content).length).toBeLessThanOrEqual(16 * 1024);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadHandoffPrompt — unreadable-but-existing file falls through', () => {
  function makeRejectingBunFile(errorCode: string, message: string) {
    return {
      text: () => {
        const err = new Error(message) as NodeJS.ErrnoException;
        err.code = errorCode;
        return Promise.reject(err);
      },
    } as ReturnType<typeof Bun.file>;
  }

  it('warn-logs and falls through to global when the repo file exists but is unreadable (EACCES)', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, '.agent-console'), { recursive: true });
    const repoPath = join(cwd, '.agent-console', 'handoff-prompt.md');

    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'handoff-prompt.md'), 'GLOBAL_FALLBACK');

    const originalBunFile = Bun.file.bind(Bun);
    const fileSpy = spyOn(Bun, 'file').mockImplementation((filePath: unknown, ...rest: unknown[]) => {
      if (filePath === repoPath) {
        return makeRejectingBunFile('EACCES', 'EACCES: permission denied, open ' + repoPath);
      }
      return (originalBunFile as (...args: unknown[]) => ReturnType<typeof Bun.file>)(
        filePath,
        ...rest,
      );
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadHandoffPrompt({ cwd, xdgConfigHome });

      expect(result).toEqual({ content: 'GLOBAL_FALLBACK', origin: 'global' });
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes(repoPath))).toBe(true);
    } finally {
      fileSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
