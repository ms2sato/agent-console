// The sibling engine's own literal is `openai-api` (#1364; formerly
// `native-loop`) -- production `system-prompt.ts` only names it in a
// comment, so no assertion here changes.
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleSystemPrompt,
  composeSdkSystemPromptAppend,
  loadInstructions,
  loadOptInInstructions,
  parseRuleFrontmatter,
  INSTRUCTION_PER_FILE_CAP_BYTES,
  INSTRUCTION_AGGREGATE_CAP_BYTES,
  RULES_LAYER_CAP_BYTES,
  type SystemPromptContext,
  type LoadInstructionsResult,
} from '../system-prompt.js';

const context: SystemPromptContext = {
  sessionId: 'sess-1',
  workerId: 'work-1',
  cwd: '/work/dir',
  repositoryId: 'repo-1',
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-instructions-'));
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

const emptyInstructions: LoadInstructionsResult = { segments: [] };

describe('assembleSystemPrompt', () => {
  it('includes the context preamble with session, worker, cwd, and repository id', () => {
    const prompt = assembleSystemPrompt({ context, instructions: emptyInstructions });
    expect(prompt).toContain('embedded agent running inside agent-console');
    expect(prompt).toContain('Session ID: sess-1');
    expect(prompt).toContain('Worker ID: work-1');
    expect(prompt).toContain('Working directory: /work/dir');
    expect(prompt).toContain('Repository ID: repo-1');
    expect(prompt).toContain('fromSessionId');
  });

  it('includes the sandboxed HTML/SVG preview guidance (#1097), naming both stripped vectors', () => {
    const prompt = assembleSystemPrompt({ context, instructions: emptyInstructions });
    expect(prompt).toContain('sandboxed preview');
    expect(prompt).toContain('<script>');
    expect(prompt).toContain('onclick');
  });

  it('omits the Repository ID line when repositoryId is absent', () => {
    const prompt = assembleSystemPrompt({
      context: { sessionId: 's', workerId: 'w', cwd: '/c' },
      instructions: emptyInstructions,
    });
    expect(prompt).not.toContain('Repository ID:');
  });

  it('omits instruction blocks entirely when segments is empty', () => {
    const prompt = assembleSystemPrompt({ context, instructions: emptyInstructions });
    expect(prompt).not.toContain('--- Instructions:');
  });

  it('renders a segment with the "--- Instructions: <origin> ---" delimiter', () => {
    const prompt = assembleSystemPrompt({
      context,
      instructions: { segments: [{ origin: '/repo/AGENTS.md', content: 'use tabs' }] },
    });
    expect(prompt).toContain('--- Instructions: /repo/AGENTS.md ---\nuse tabs');
  });

  it('renders multiple segments in the given order', () => {
    const prompt = assembleSystemPrompt({
      context,
      instructions: {
        segments: [
          { origin: '/a/AGENTS.md', content: 'FIRST_MARKER' },
          { origin: '/b/AGENTS.md', content: 'SECOND_MARKER' },
        ],
      },
    });
    const firstIdx = prompt.indexOf('FIRST_MARKER');
    const secondIdx = prompt.indexOf('SECOND_MARKER');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('places the definition system prompt last, so it wins on conflict by position', () => {
    const prompt = assembleSystemPrompt({
      context,
      instructions: { segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }] },
      definitionSystemPrompt: 'OPERATOR_MARKER',
    });
    const preambleIdx = prompt.indexOf('Session ID: sess-1');
    const repoIdx = prompt.indexOf('REPO_MARKER');
    const operatorIdx = prompt.indexOf('OPERATOR_MARKER');
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(repoIdx).toBeGreaterThan(preambleIdx);
    expect(operatorIdx).toBeGreaterThan(repoIdx);
  });

  it('appends the definition system prompt even without any instruction segments', () => {
    const prompt = assembleSystemPrompt({
      context,
      instructions: emptyInstructions,
      definitionSystemPrompt: 'X',
    });
    expect(prompt.indexOf('X')).toBeGreaterThan(prompt.indexOf('Session ID'));
  });
});

describe('loadInstructions — AGENTS.md canonical / CLAUDE.md fallback (a)', () => {
  it('loads AGENTS.md when only AGENTS.md is present', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'AGENTS.md'), 'agents content');

    const result = await loadInstructions({ cwd: dir, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ origin: join(dir, 'AGENTS.md'), content: 'agents content' });
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'CLAUDE.md'), 'claude content');

    const result = await loadInstructions({ cwd: dir, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ origin: join(dir, 'CLAUDE.md'), content: 'claude content' });
  });

  it('picks AGENTS.md when both are present, and debug-logs the choice (not warn)', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'AGENTS.md'), 'agents content');
    await writeFile(join(dir, 'CLAUDE.md'), 'claude content');

    const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd: dir,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].origin).toBe(join(dir, 'AGENTS.md'));
      expect(debugSpy).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — chain discovery (b)', () => {
  it('walks a real .git directory root down to cwd, root-to-cwd order', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'AGENTS.md'), 'ROOT_MARKER');
    const leaf = join(root, 'a', 'b');
    await mkdir(leaf, { recursive: true });
    // The intermediate "a" directory intentionally has no AGENTS.md/CLAUDE.md.
    await writeFile(join(leaf, 'AGENTS.md'), 'LEAF_MARKER');

    const result = await loadInstructions({
      cwd: leaf,
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    const origins = result.segments.map((s) => s.origin);
    expect(origins).toEqual([join(root, 'AGENTS.md'), join(leaf, 'AGENTS.md')]);
    const rootIdx = result.segments.findIndex((s) => s.content === 'ROOT_MARKER');
    const leafIdx = result.segments.findIndex((s) => s.content === 'LEAF_MARKER');
    expect(rootIdx).toBe(0);
    expect(leafIdx).toBe(1);
  });
});

describe('loadInstructions — git-root discovery tolerates non-ENOENT stat errors while climbing (b2)', () => {
  it('keeps climbing past a directory whose .git stat rejects with EACCES, and still finds the real root', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'AGENTS.md'), 'ROOT_MARKER');
    const leaf = join(root, 'sub');
    await mkdir(leaf);

    const leafGitPath = join(leaf, '.git');
    const originalStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, 'stat').mockImplementation(((...args: Parameters<typeof fsPromises.stat>) => {
      if (args[0] === leafGitPath) {
        return Promise.reject(Object.assign(new Error('EACCES: permission denied, stat ' + leafGitPath), { code: 'EACCES' }));
      }
      return (originalStat as (...a: unknown[]) => ReturnType<typeof fsPromises.stat>)(...args);
    }) as typeof fsPromises.stat);

    try {
      const result = await loadInstructions({
        cwd: leaf,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      // Discovery reaches the real root above the EACCES'd directory instead
      // of stopping (or throwing) at the inaccessible `.git` stat.
      const origins = result.segments.map((s) => s.origin);
      expect(origins).toContain(join(root, 'AGENTS.md'));
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('loadInstructions — .git as a FILE (worktree gitfile) (c, A10)', () => {
  it('treats a directory whose .git is a FILE (not a directory) as the git root', async () => {
    const root = await makeTempDir();
    // Worktree-style .git FILE, not a directory.
    await writeFile(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/example\n');
    await writeFile(join(root, 'AGENTS.md'), 'ROOT_GITFILE_MARKER');
    const leaf = join(root, 'sub');
    await mkdir(leaf);
    await writeFile(join(leaf, 'AGENTS.md'), 'LEAF_GITFILE_MARKER');

    const result = await loadInstructions({
      cwd: leaf,
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    const origins = result.segments.map((s) => s.origin);
    expect(origins).toEqual([join(root, 'AGENTS.md'), join(leaf, 'AGENTS.md')]);
  });
});

describe('loadInstructions — no .git anywhere reduces chain to [cwd] only (d)', () => {
  it('does not climb to a parent directory when no .git exists', async () => {
    const parent = await makeTempDir();
    await writeFile(join(parent, 'AGENTS.md'), 'PARENT_MARKER_SHOULD_NOT_APPEAR');
    const cwd = join(parent, 'nested');
    await mkdir(cwd);
    await writeFile(join(cwd, 'AGENTS.md'), 'CWD_MARKER');

    const result = await loadInstructions({ cwd, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ origin: join(cwd, 'AGENTS.md'), content: 'CWD_MARKER' });
  });
});

describe('loadInstructions — global layer via xdgConfigHome/homeDir overrides (e)', () => {
  it('reads <xdgConfigHome>/agent-console/AGENTS.md when xdgConfigHome is given', async () => {
    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'AGENTS.md'), 'GLOBAL_MARKER');
    const cwd = await makeTempDir();

    const result = await loadInstructions({ cwd, xdgConfigHome });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      origin: join(globalDir, 'AGENTS.md'),
      content: 'GLOBAL_MARKER',
    });
  });

  it('reads <homeDir>/.config/agent-console/AGENTS.md when only homeDir is given', async () => {
    // xdgConfigHome (param) and XDG_CONFIG_HOME (env) both take precedence
    // over homeDir by design (A2: "honor XDG_CONFIG_HOME when set"). This
    // test exercises the homeDir-only fallback path specifically, so the
    // ambient process env must be neutralized for its duration -- otherwise
    // a CI runner or developer machine with XDG_CONFIG_HOME set would leak
    // into loadInstructions and this test would flake.
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const homeDir = await makeTempDir();
      const globalDir = join(homeDir, '.config', 'agent-console');
      await mkdir(globalDir, { recursive: true });
      await writeFile(join(globalDir, 'AGENTS.md'), 'HOME_GLOBAL_MARKER');
      const cwd = await makeTempDir();

      const result = await loadInstructions({ cwd, homeDir });

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toEqual({
        origin: join(globalDir, 'AGENTS.md'),
        content: 'HOME_GLOBAL_MARKER',
      });
    } finally {
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
    }
  });
});

describe('loadInstructions — per-file 16 KiB truncation (f)', () => {
  it('truncates an oversized instructions[] entry to <= the per-file cap and warn-logs, without appending a marker', async () => {
    const cwd = await makeTempDir();
    const oversized = 'x'.repeat(INSTRUCTION_PER_FILE_CAP_BYTES + 5000);
    await writeFile(join(cwd, 'big.md'), oversized);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        instructionsList: ['big.md'],
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toHaveLength(1);
      const content = result.segments[0].content;
      expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(
        INSTRUCTION_PER_FILE_CAP_BYTES,
      );
      // No in-prompt truncation marker/notice text is appended.
      expect(content).toBe('x'.repeat(content.length));
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('big.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — aggregate 48 KiB overflow drop order (g)', () => {
  it('drops global before chain-root before chain-leaf, preserving survivors in relative order', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    const capContent = 'x'.repeat(INSTRUCTION_PER_FILE_CAP_BYTES);
    await writeFile(join(root, 'AGENTS.md'), capContent); // chain-root

    const leaf = join(root, 'leaf');
    await mkdir(leaf);
    await writeFile(join(leaf, 'AGENTS.md'), capContent); // chain-leaf (== cwd)

    const xdgConfigHome = await makeTempDir();
    const globalDir = join(xdgConfigHome, 'agent-console');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'AGENTS.md'), capContent); // global

    // instructions[] entries must resolve INSIDE cwd (leaf) to pass
    // confinement (A9) -- a separate temp dir would be legitimately rejected,
    // which is not what this test is exercising.
    await mkdir(join(leaf, 'instr'));
    await writeFile(join(leaf, 'instr', 'a.md'), capContent);
    await writeFile(join(leaf, 'b.md'), capContent);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 5 capped segments x 16384 bytes = 81920 bytes; cap = 49152.
      // Drop order: global (1st), chain-root (2nd) -> remaining 49152 <= cap.
      const result = await loadInstructions({
        cwd: leaf,
        xdgConfigHome,
        instructionsList: ['instr/a.md', 'b.md'],
      });

      const origins = result.segments.map((s) => s.origin);
      expect(origins).toEqual([
        join(leaf, 'AGENTS.md'),
        join(leaf, 'instr', 'a.md'),
        join(leaf, 'b.md'),
      ]);

      const totalBytes = result.segments.reduce(
        (sum, s) => sum + new TextEncoder().encode(s.content).length,
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(INSTRUCTION_AGGREGATE_CAP_BYTES);

      const droppedOrigins = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(droppedOrigins.some((m) => m.includes(join(globalDir, 'AGENTS.md')))).toBe(true);
      expect(droppedOrigins.some((m) => m.includes(join(root, 'AGENTS.md')))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops instructions[] entries from the LAST array entry backward when chain/global are absent', async () => {
    const cwd = await makeTempDir();
    const capContent = 'x'.repeat(INSTRUCTION_PER_FILE_CAP_BYTES);
    await writeFile(join(cwd, 'a.md'), capContent);
    await writeFile(join(cwd, 'b.md'), capContent);
    await writeFile(join(cwd, 'c.md'), capContent);
    await writeFile(join(cwd, 'd.md'), capContent);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 4 x 16384 = 65536 bytes; cap = 49152. Dropping exactly 1 (the last,
      // "d.md") brings the total to 49152 <= cap.
      const result = await loadInstructions({
        cwd,
        instructionsList: ['a.md', 'b.md', 'c.md', 'd.md'],
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      const origins = result.segments.map((s) => s.origin);
      expect(origins).toEqual([join(cwd, 'a.md'), join(cwd, 'b.md'), join(cwd, 'c.md')]);

      const droppedOrigins = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(droppedOrigins.some((m) => m.includes(join(cwd, 'd.md')))).toBe(true);
      expect(droppedOrigins.some((m) => m.includes(join(cwd, 'c.md')))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — instructions[] confinement (h, i, j, k; A9)', () => {
  it('(h, positive) resolves and loads a legitimate relative path inside cwd', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'note.md'), 'NOTE_CONTENT');

    const result = await loadInstructions({
      cwd,
      instructionsList: ['docs/note.md'],
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({
      origin: join(cwd, 'docs', 'note.md'),
      content: 'NOTE_CONTENT',
    });
  });

  it('(i, negative) rejects+skips+warn-logs an absolute path outside cwd; activation still succeeds with other segments intact', async () => {
    const cwd = await makeTempDir();
    await writeFile(join(cwd, 'inside.md'), 'INSIDE_CONTENT');
    const outside = await makeTempDir();
    await writeFile(join(outside, 'secret.md'), 'SECRET_CONTENT');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        instructionsList: ['inside.md', join(outside, 'secret.md')],
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toEqual({
        origin: join(cwd, 'inside.md'),
        content: 'INSIDE_CONTENT',
      });
      expect(result.segments.some((s) => s.content === 'SECRET_CONTENT')).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes(join(outside, 'secret.md'))),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('(j, negative) rejects a symlink inside cwd that points outside cwd (realpath escape, A9 polarity)', async () => {
    const cwd = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, 'secret.md'), 'SECRET_CONTENT');
    await symlink(join(outside, 'secret.md'), join(cwd, 'link.md'));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        instructionsList: ['link.md'],
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('link.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('(k) warn-logs and skips a missing instructions[] entry (explicit opt-in reference)', async () => {
    const cwd = await makeTempDir();

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        instructionsList: ['does-not-exist.md'],
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('does-not-exist.md')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — dedupe by resolved path (Issue #1343 Phase A, R1)', () => {
  it('does not double-load CLAUDE.md when instructions[] redundantly lists it and the chain tail already resolves the same file', async () => {
    const cwd = await makeTempDir();
    await writeFile(join(cwd, 'CLAUDE.md'), 'CLAUDE_MD_CONTENT');

    const result = await loadInstructions({
      cwd,
      instructionsList: ['CLAUDE.md'],
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    // Chain layer resolves cwd's own CLAUDE.md (buildChainDirs reduces to
    // [cwd] with no .git present); the opt-in entry for the SAME resolved
    // path must be dropped rather than appended a second time.
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ origin: join(cwd, 'CLAUDE.md'), content: 'CLAUDE_MD_CONTENT' });
  });

  it('does not dedupe two DIFFERENT files even if their content happens to be identical (dedupe is by path, not content)', async () => {
    const cwd = await makeTempDir();
    await writeFile(join(cwd, 'CLAUDE.md'), 'SAME_CONTENT');
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'note.md'), 'SAME_CONTENT');

    const result = await loadInstructions({
      cwd,
      instructionsList: ['docs/note.md'],
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    expect(result.segments).toHaveLength(2);
  });
});

describe('loadInstructions — non-ENOENT read error is warn-logged, not thrown (m)', () => {
  function makeRejectingBunFile(errorCode: string, message: string) {
    return {
      text: () => {
        const err = new Error(message) as NodeJS.ErrnoException;
        err.code = errorCode;
        return Promise.reject(err);
      },
    } as ReturnType<typeof Bun.file>;
  }

  it('(m1) warn-logs and skips the directory when AGENTS.md read fails with EACCES', async () => {
    const cwd = await makeTempDir();
    const agentsPath = join(cwd, 'AGENTS.md');
    const originalBunFile = Bun.file.bind(Bun);

    const fileSpy = spyOn(Bun, 'file').mockImplementation((filePath: unknown, ...rest: unknown[]) => {
      if (filePath === agentsPath) {
        return makeRejectingBunFile('EACCES', 'EACCES: permission denied, open ' + agentsPath);
      }
      return (originalBunFile as (...args: unknown[]) => ReturnType<typeof Bun.file>)(
        filePath,
        ...rest,
      );
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      // The directory yields no segment -- the read error is non-fatal to
      // the overall activation, not a thrown exception.
      expect(result.segments).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes(agentsPath))).toBe(true);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('EACCES'))).toBe(true);
    } finally {
      fileSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('(m2) warn-logs and skips the directory when CLAUDE.md read fails with EACCES (AGENTS.md absent)', async () => {
    const cwd = await makeTempDir();
    const claudePath = join(cwd, 'CLAUDE.md');
    const originalBunFile = Bun.file.bind(Bun);

    const fileSpy = spyOn(Bun, 'file').mockImplementation((filePath: unknown, ...rest: unknown[]) => {
      if (filePath === claudePath) {
        return makeRejectingBunFile('EACCES', 'EACCES: permission denied, open ' + claudePath);
      }
      return (originalBunFile as (...args: unknown[]) => ReturnType<typeof Bun.file>)(
        filePath,
        ...rest,
      );
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      // AGENTS.md is genuinely absent (real ENOENT via the unmocked path),
      // so resolution falls through to CLAUDE.md, whose non-ENOENT failure
      // must also be warn-logged rather than thrown.
      expect(result.segments).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes(claudePath))).toBe(true);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('EACCES'))).toBe(true);
    } finally {
      fileSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — routine absence is silent (l, anti-noise)', () => {
  it('emits no log at all when a directory has neither AGENTS.md nor CLAUDE.md', async () => {
    const cwd = await makeTempDir();

    const debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({
        cwd,
        xdgConfigHome: await isolatedXdgConfigHome(),
      });

      expect(result.segments).toEqual([]);
      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// loadOptInInstructions -- the extracted opt-in-only reader, now directly
// callable (shared by loadInstructions above and the SDK engine's main.ts
// claude-sdk arm). loadInstructions's own confinement/cap tests above (h-k,
// f) already exercise this code path indirectly; these tests exercise the
// function DIRECTLY, as its own independently-testable unit.
// ---------------------------------------------------------------------------

describe('loadOptInInstructions', () => {
  it('returns an empty array when instructionsList is undefined', async () => {
    const cwd = await makeTempDir();
    const result = await loadOptInInstructions(cwd, undefined);
    expect(result).toEqual([]);
  });

  it('resolves and loads a legitimate relative path inside cwd', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'docs', 'note.md'), 'NOTE_CONTENT');

    const result = await loadOptInInstructions(cwd, ['docs/note.md']);

    expect(result).toEqual([{ origin: join(cwd, 'docs', 'note.md'), content: 'NOTE_CONTENT' }]);
  });

  it('rejects+skips+warn-logs a path that resolves outside cwd (confinement)', async () => {
    const cwd = await makeTempDir();
    await writeFile(join(cwd, 'inside.md'), 'INSIDE_CONTENT');
    const outside = await makeTempDir();
    await writeFile(join(outside, 'secret.md'), 'SECRET_CONTENT');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadOptInInstructions(cwd, ['inside.md', join(outside, 'secret.md')]);

      expect(result).toEqual([{ origin: join(cwd, 'inside.md'), content: 'INSIDE_CONTENT' }]);
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes(join(outside, 'secret.md'))),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects a symlink inside cwd that points outside cwd (realpath escape)', async () => {
    const cwd = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, 'secret.md'), 'SECRET_CONTENT');
    await symlink(join(outside, 'secret.md'), join(cwd, 'link.md'));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadOptInInstructions(cwd, ['link.md']);

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('link.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warn-logs and skips a missing entry', async () => {
    const cwd = await makeTempDir();

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadOptInInstructions(cwd, ['does-not-exist.md']);

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('does-not-exist.md')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('truncates an oversized entry to <= the per-file cap and warn-logs, without appending a marker', async () => {
    const cwd = await makeTempDir();
    const oversized = 'x'.repeat(INSTRUCTION_PER_FILE_CAP_BYTES + 5000);
    await writeFile(join(cwd, 'big.md'), oversized);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadOptInInstructions(cwd, ['big.md']);

      expect(result).toHaveLength(1);
      const content = result[0].content;
      expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(
        INSTRUCTION_PER_FILE_CAP_BYTES,
      );
      expect(content).toBe('x'.repeat(content.length));
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('big.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// composeSdkSystemPromptAppend -- the SDK engine's systemPrompt.append
// composition (instruction segments, formatted the same way
// assembleSystemPrompt renders them, followed by the definition system
// prompt if present; no preamble).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseRuleFrontmatter -- boundary pins for the .claude/rules/*.md
// paths:/globs: frontmatter parser (Issue #1343 Phase A, R2).
// ---------------------------------------------------------------------------

describe('parseRuleFrontmatter', () => {
  it('returns [] (unscoped) with no warning when there is no frontmatter at all', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRuleFrontmatter('# Just a rule\n\nSome content.\n', '/r/x.md')).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns [] (unscoped) with no warning when frontmatter is present but has no paths/globs key', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRuleFrontmatter('---\nsomething: else\n---\n\nBody.\n', '/r/x.md')).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('parses the multi-line YAML list form under "paths:" (this repo\'s own convention)', () => {
    const content = '---\npaths:\n  - "packages/server/**"\n  - "scripts/**"\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['packages/server/**', 'scripts/**']);
  });

  it('parses the multi-line YAML list form under "globs:" (the other accepted spelling)', () => {
    const content = '---\nglobs:\n  - "**/*.test.ts"\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['**/*.test.ts']);
  });

  it('parses an inline JSON-ish array on the same line', () => {
    const content = '---\npaths: ["src/**", "docs/**"]\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['src/**', 'docs/**']);
  });

  it('parses a single unquoted scalar on the same line', () => {
    const content = '---\npaths: src/**\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['src/**']);
  });

  it('parses a single quoted scalar on the same line', () => {
    const content = '---\npaths: "src/**"\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['src/**']);
  });

  it('malformed: empty inline array warns and treats as unscoped', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRuleFrontmatter('---\npaths: []\n---\n', '/r/x.md')).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('malformed: key present with nothing after the colon and no following list items warns and treats as unscoped', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRuleFrontmatter('---\npaths:\nBody starts immediately.\n---\n', '/r/x.md')).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('/r/x.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// loadInstructions — rules layer (Issue #1343 Phase A, R2/R3): every
// <gitRoot>/.claude/rules/*.md, unscoped included eagerly, scoped listed in
// an index line only, budget-capped whole-file largest-first.
// ---------------------------------------------------------------------------

describe('loadInstructions — rules layer', () => {
  async function makeGitRepo(): Promise<string> {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    return root;
  }

  it('produces no rules layer when there is no .claude/rules directory at all', async () => {
    const root = await makeGitRepo();
    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
    expect(result.ruleSegments).toEqual([]);
    expect(result.ruleOmissionLine).toBeUndefined();
    expect(result.ruleIndexLine).toBeUndefined();
  });

  it('produces no rules layer when cwd is outside any git repository (routine, silent)', async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, '.claude', 'rules'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'rules', 'a.md'), 'UNSCOPED_CONTENT');

    const result = await loadInstructions({ cwd, xdgConfigHome: await isolatedXdgConfigHome() });
    expect(result.ruleSegments).toEqual([]);
  });

  it('includes unscoped rules eagerly, in file-name order, and excludes scoped rules but lists them in an index line', async () => {
    const root = await makeGitRepo();
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'b-unscoped.md'), 'B_CONTENT');
    await writeFile(join(rulesDir, 'a-unscoped.md'), 'A_CONTENT');
    await writeFile(
      join(rulesDir, 'scoped.md'),
      '---\npaths:\n  - "src/**"\n---\n\nSCOPED_CONTENT',
    );

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.ruleSegments!.map((s) => s.content)).toEqual(['A_CONTENT', 'B_CONTENT']);
    expect(result.ruleSegments!.some((s) => s.content.includes('SCOPED_CONTENT'))).toBe(false);
    expect(result.ruleIndexLine).toBeDefined();
    expect(result.ruleIndexLine).toContain('scoped.md');
    expect(result.ruleIndexLine).toContain('src/**');
    expect(result.ruleOmissionLine).toBeUndefined();
  });

  it('drops unscoped rule files whole, largest-first, once the total exceeds RULES_LAYER_CAP_BYTES, and declares the exact dropped names in-band', async () => {
    const root = await makeGitRepo();
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    // Two files that together exceed the cap; "big.md" alone is larger than
    // half the budget so it is the one dropped (largest-first).
    const bigSize = Math.floor(RULES_LAYER_CAP_BYTES * 0.7);
    const smallSize = Math.floor(RULES_LAYER_CAP_BYTES * 0.4);
    await writeFile(join(rulesDir, 'big.md'), 'x'.repeat(bigSize));
    await writeFile(join(rulesDir, 'small.md'), 'y'.repeat(smallSize));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

      expect(result.ruleSegments).toHaveLength(1);
      expect(result.ruleSegments![0].content).toBe('y'.repeat(smallSize));
      expect(result.ruleOmissionLine).toBe('rules omitted for size: big.md');
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('big.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never truncates a rule file mid-content: a single unscoped rule larger than the per-file instruction cap but under the rules budget survives intact', async () => {
    const root = await makeGitRepo();
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    const size = INSTRUCTION_PER_FILE_CAP_BYTES + 5000; // > 16 KiB instruction cap, well under the 160 KiB rules cap
    await writeFile(join(rulesDir, 'large.md'), 'z'.repeat(size));

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.ruleSegments).toHaveLength(1);
    expect(new TextEncoder().encode(result.ruleSegments![0].content).length).toBe(size);
    expect(result.ruleOmissionLine).toBeUndefined();
  });

  it('the aggregate INSTRUCTION_AGGREGATE_CAP_BYTES cap does not apply to the rules layer (independent budgets)', async () => {
    const root = await makeGitRepo();
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    // Larger than the 48 KiB instruction aggregate cap, but under the 160 KiB
    // rules cap -- must survive, proving the two budgets are independent.
    const size = INSTRUCTION_AGGREGATE_CAP_BYTES + 1000;
    await writeFile(join(rulesDir, 'r.md'), 'w'.repeat(size));

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.ruleSegments).toHaveLength(1);
    expect(result.ruleOmissionLine).toBeUndefined();
  });

  it('rule segments and the rules-layer lines render into the composed system prompt (assembleSystemPrompt), after instruction segments', async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, 'CLAUDE.md'), 'INSTRUCTION_CONTENT');
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'unscoped.md'), 'RULE_CONTENT');
    await writeFile(join(rulesDir, 'scoped.md'), '---\npaths:\n  - "src/**"\n---\n\nSCOPED_CONTENT');

    const instructions = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
    const prompt = assembleSystemPrompt({ context, instructions });

    expect(prompt).toContain('--- Rule: ');
    const instructionIdx = prompt.indexOf('INSTRUCTION_CONTENT');
    const ruleIdx = prompt.indexOf('RULE_CONTENT');
    const indexLineIdx = prompt.indexOf('Rules that apply when you touch matching paths');
    expect(ruleIdx).toBeGreaterThan(instructionIdx);
    expect(indexLineIdx).toBeGreaterThan(ruleIdx);
    expect(prompt).not.toContain('SCOPED_CONTENT');
  });
});

describe('composeSdkSystemPromptAppend', () => {
  it('returns undefined when there are no segments and no definition system prompt', () => {
    expect(composeSdkSystemPromptAppend({ segments: [] }, undefined)).toBeUndefined();
  });

  it('returns only the definition system prompt when there are no segments', () => {
    expect(composeSdkSystemPromptAppend({ segments: [] }, 'OPERATOR_PROMPT')).toBe('OPERATOR_PROMPT');
  });

  it('renders segments using the same "--- Instructions: <origin> ---" delimiter as assembleSystemPrompt, ordered before the definition system prompt', () => {
    const result = composeSdkSystemPromptAppend(
      { segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }] },
      'OPERATOR_MARKER',
    );
    expect(result).toContain('--- Instructions: /repo/AGENTS.md ---\nREPO_MARKER');
    const repoIdx = result!.indexOf('REPO_MARKER');
    const operatorIdx = result!.indexOf('OPERATOR_MARKER');
    expect(operatorIdx).toBeGreaterThan(repoIdx);
  });

  it('omits the definition system prompt section when it is an empty string (matches assembleSystemPrompt)', () => {
    const result = composeSdkSystemPromptAppend(
      { segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }] },
      '',
    );
    expect(result).toBe('--- Instructions: /repo/AGENTS.md ---\nREPO_MARKER');
  });

  // Issue #1343 Phase A (R1): this function's own aggregate-capping logic
  // (#1342 CodeRabbit follow-up) moved to loadInstructions -- the SDK arm now
  // receives an ALREADY-capped LoadInstructionsResult the same way the
  // openai-api arm does, so composeSdkSystemPromptAppend no longer caps
  // anything itself. loadInstructions's own aggregate-cap tests (above)
  // cover that behavior; this describe block only pins that rule segments
  // and the two rules-layer lines render the same way assembleSystemPrompt
  // renders them (mirrored through the shared renderInstructionsBody).
  it('renders rule segments using the "--- Rule: <origin> ---" delimiter, after instruction segments and before the definition system prompt', () => {
    const result = composeSdkSystemPromptAppend(
      {
        segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }],
        ruleSegments: [{ origin: '/repo/.claude/rules/unscoped.md', content: 'RULE_MARKER' }],
      },
      'OPERATOR_MARKER',
    );
    expect(result).toContain('--- Rule: /repo/.claude/rules/unscoped.md ---\nRULE_MARKER');
    const instructionIdx = result!.indexOf('REPO_MARKER');
    const ruleIdx = result!.indexOf('RULE_MARKER');
    const operatorIdx = result!.indexOf('OPERATOR_MARKER');
    expect(ruleIdx).toBeGreaterThan(instructionIdx);
    expect(operatorIdx).toBeGreaterThan(ruleIdx);
  });

  it('renders ruleOmissionLine and ruleIndexLine verbatim when present', () => {
    const result = composeSdkSystemPromptAppend(
      {
        segments: [],
        ruleOmissionLine: 'rules omitted for size: big.md',
        ruleIndexLine: 'Rules that apply when you touch matching paths: scoped.md (paths: src/**)',
      },
      undefined,
    );
    expect(result).toContain('rules omitted for size: big.md');
    expect(result).toContain('Rules that apply when you touch matching paths: scoped.md (paths: src/**)');
  });
});
