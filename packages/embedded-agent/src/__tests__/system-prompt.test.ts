// The sibling engine's own literal is `openai-api` (#1364; formerly
// `native-loop`) -- production `system-prompt.ts` only names it in a
// comment, so no assertion here changes.
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleSystemPrompt,
  composeSdkSystemPromptAppend,
  loadInstructions,
  loadOptInInstructions,
  parseRuleFrontmatter,
  parseRulesLayerCapBytes,
  parseSkillFrontmatter,
  parseSkillsLayerCapBytes,
  parseMemoryLayerCapBytes,
  parseMemoryLayerMaxEntries,
  formatMemoryHeader,
  MEMORY_ABSENT_INDEX_LINE,
  MEMORY_LAYER_CAP_BYTES,
  MEMORY_INDEX_READ_CAP_BYTES,
  MEMORY_LAYER_MAX_ENTRIES,
  MEMORY_DECLARATION_MAX_NAMES,
  INSTRUCTION_PER_FILE_CAP_BYTES,
  INSTRUCTION_AGGREGATE_CAP_BYTES,
  RULES_LAYER_CAP_BYTES,
  rulesLayerBytesUsed,
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

  it('picks AGENTS.md when both are present, and warn-logs the choice (Architect en-passant: console.debug/log write to STDOUT in Bun, the subprocess NDJSON protocol channel; console.warn writes to stderr instead)', async () => {
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
      expect(warnSpy).toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
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

  it('dedupes correctly even when cwd is reached via a symlink (Architect F1: realpath both sides of the comparison)', async () => {
    const realDir = await makeTempDir();
    await writeFile(join(realDir, 'CLAUDE.md'), 'CLAUDE_MD_CONTENT');
    const container = await makeTempDir();
    const symlinkedCwd = join(container, 'link-to-real-dir');
    await symlink(realDir, symlinkedCwd);
    tempDirs.push(symlinkedCwd);

    const result = await loadInstructions({
      cwd: symlinkedCwd,
      instructionsList: ['CLAUDE.md'],
      xdgConfigHome: await isolatedXdgConfigHome(),
    });

    // Chain layer's origin is `<symlinkedCwd>/CLAUDE.md` (no realpath in the
    // chain walk); the opt-in layer's origin is already realpath'd to
    // `<realDir>/CLAUDE.md` by resolveConfinedPath. The two strings differ
    // even though they name the same file -- only a realpath-normalized
    // comparison on BOTH sides catches this as a duplicate.
    expect(result.segments).toHaveLength(1);
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
// composition (the identity preamble first, then instruction segments
// formatted the same way assembleSystemPrompt renders them, followed by the
// definition system prompt if present).
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

  it('does not split a comma inside a brace-expansion glob within a quoted inline-array item (Architect F2)', () => {
    const content = '---\npaths: ["**/*.{ts,tsx}", "src/**"]\n---\n\nBody.\n';
    expect(parseRuleFrontmatter(content, '/r/x.md')).toEqual(['**/*.{ts,tsx}', 'src/**']);
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
    expect(result.scopedRules).toEqual([]);
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

    // Phase B (#1343 R1): the SAME scoped rule, exposed structurally instead
    // of only summarized into ruleIndexLine -- deliberately WITHOUT content
    // (see ScopedRule's own doc comment for why).
    expect(result.scopedRules).toEqual([
      { name: 'scoped.md', origin: join(rulesDir, 'scoped.md'), globs: ['src/**'] },
    ]);
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

describe('parseSkillFrontmatter', () => {
  it('parses name and description from a well-formed frontmatter block', () => {
    const content = '---\nname: browser-qa\ndescription: Manual browser QA via Chrome DevTools MCP.\n---\n\nBody.';
    expect(parseSkillFrontmatter(content, '/skills/browser-qa/SKILL.md', 'browser-qa')).toEqual({
      name: 'browser-qa',
      description: 'Manual browser QA via Chrome DevTools MCP.',
    });
  });

  it('strips quotes around name/description values', () => {
    const content = '---\nname: "quoted-name"\ndescription: \'quoted description\'\n---\n';
    expect(parseSkillFrontmatter(content, '/x/SKILL.md', 'fallback')).toEqual({
      name: 'quoted-name',
      description: 'quoted description',
    });
  });

  it('falls back to the directory name and empty description, with a warning, when there is no frontmatter at all', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseSkillFrontmatter('# Just a heading\n', '/skills/no-frontmatter/SKILL.md', 'no-frontmatter')).toEqual({
        name: 'no-frontmatter',
        description: '',
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the directory name, with a warning, when frontmatter is present but has no "name" key', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseSkillFrontmatter(
        '---\ndescription: only a description\n---\n',
        '/skills/missing-name/SKILL.md',
        'missing-name',
      );
      expect(result).toEqual({ name: 'missing-name', description: 'only a description' });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('renders a name-only entry, with a warning (not a crash), when frontmatter is present but has no "description" key', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseSkillFrontmatter('---\nname: no-description\n---\n', '/skills/no-description/SKILL.md', 'no-description');
      expect(result).toEqual({ name: 'no-description', description: '' });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('treats an empty "name:" value the same as a missing key (falls back, warns)', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseSkillFrontmatter('---\nname:\ndescription: has a description\n---\n', '/x/SKILL.md', 'fallback-dir');
      expect(result).toEqual({ name: 'fallback-dir', description: 'has a description' });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadInstructions — skills layer', () => {
  async function makeGitRepo(): Promise<string> {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    return root;
  }

  async function writeSkill(root: string, dirName: string, frontmatter: string): Promise<void> {
    const dir = join(root, '.claude', 'skills', dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), frontmatter);
  }

  it('produces no skills layer when there is no .claude/skills directory at all', async () => {
    const root = await makeGitRepo();
    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
    expect(result.skillIndexLine).toBeUndefined();
    expect(result.skillOmissionLine).toBeUndefined();
  });

  it('produces no skills layer when cwd is outside any git repository (routine, silent)', async () => {
    const cwd = await makeTempDir();
    await writeSkill(cwd, 'a-skill', '---\nname: a-skill\ndescription: A skill.\n---\n');
    const result = await loadInstructions({ cwd, xdgConfigHome: await isolatedXdgConfigHome() });
    expect(result.skillIndexLine).toBeUndefined();
  });

  it("lists every discovered skill's name and description in one index line", async () => {
    const root = await makeGitRepo();
    await writeSkill(root, 'browser-qa', '---\nname: browser-qa\ndescription: Manual browser QA.\n---\n');
    await writeSkill(root, 'orchestrator', '---\nname: orchestrator\ndescription: Owner-facing role.\n---\n');

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.skillIndexLine).toBeDefined();
    expect(result.skillIndexLine).toContain('browser-qa');
    expect(result.skillIndexLine).toContain('Manual browser QA.');
    expect(result.skillIndexLine).toContain('orchestrator');
    expect(result.skillIndexLine).toContain('Owner-facing role.');
    expect(result.skillOmissionLine).toBeUndefined();
  });

  it('discovers a SKILL.md nested more than one level under .claude/skills (recursive, not fixed-depth)', async () => {
    const root = await makeGitRepo();
    await writeSkill(root, join('parent', 'nested-skill'), '---\nname: nested-skill\ndescription: Nested one level deeper.\n---\n');

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.skillIndexLine).toContain('nested-skill');
    expect(result.skillIndexLine).toContain('Nested one level deeper.');
  });

  it('handles a skill missing "description" frontmatter gracefully: name-only entry, warn-logged, no crash', async () => {
    const root = await makeGitRepo();
    await writeSkill(root, 'no-desc', '---\nname: no-desc\n---\n');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
      expect(result.skillIndexLine).toContain('no-desc');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back gracefully (directory name, no crash) when a SKILL.md\'s frontmatter does not close within the bounded prefix read', async () => {
    const root = await makeGitRepo();
    // The closing "---" sits well past the 4 KiB bounded read
    // (tryReadSkillFrontmatterPrefix), so the truncated prefix never matches
    // FRONTMATTER_RE -- this must take the SAME graceful path a
    // no-frontmatter-at-all file takes, not throw or hang.
    const oversizedDescription = 'x'.repeat(8 * 1024);
    await writeSkill(
      root,
      'huge-frontmatter',
      `---\nname: huge-frontmatter\ndescription: ${oversizedDescription}\n---\n`,
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
      expect(result.skillIndexLine).toContain('huge-frontmatter');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops skill entries whole, largest-first, once the total exceeds SKILLS_LAYER_CAP_BYTES, and declares the exact dropped names in-band', async () => {
    const root = await makeGitRepo();
    // Each individual description stays comfortably under the 4 KiB bounded
    // frontmatter read (tryReadSkillFrontmatterPrefix), so every file's
    // frontmatter parses in full; only their COMBINED formatted size crosses
    // SKILLS_LAYER_CAP_BYTES (16 KiB default), forcing exactly one drop --
    // the distinctly largest entry.
    const fillerDescription = 'y'.repeat(3000);
    for (let i = 0; i < 5; i++) {
      await writeSkill(root, `filler-${i}`, `---\nname: filler-${i}\ndescription: ${fillerDescription}\n---\n`);
    }
    const bigDescription = 'x'.repeat(3500);
    await writeSkill(root, 'big-skill', `---\nname: big-skill\ndescription: ${bigDescription}\n---\n`);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

      expect(result.skillIndexLine).toContain('filler-0');
      expect(result.skillIndexLine).not.toContain('big-skill');
      expect(result.skillOmissionLine).toBe('skills omitted for size: big-skill');
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('big-skill'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the aggregate INSTRUCTION_AGGREGATE_CAP_BYTES cap and RULES_LAYER_CAP_BYTES do not apply to the skills layer (independent budgets)', async () => {
    const root = await makeGitRepo();
    await writeSkill(root, 'ordinary-skill', '---\nname: ordinary-skill\ndescription: A short description.\n---\n');
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'r.md'), 'w'.repeat(INSTRUCTION_AGGREGATE_CAP_BYTES + 1000));

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(result.skillIndexLine).toContain('ordinary-skill');
    expect(result.skillOmissionLine).toBeUndefined();
  });

  it('skill index and omission lines render into the composed system prompt (assembleSystemPrompt), after the rules layer', async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, 'CLAUDE.md'), 'INSTRUCTION_CONTENT');
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'unscoped.md'), 'RULE_CONTENT');
    await writeSkill(root, 'demo-skill', '---\nname: demo-skill\ndescription: Demo skill description.\n---\n');

    const instructions = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
    const prompt = assembleSystemPrompt({ context, instructions });

    const instructionIdx = prompt.indexOf('INSTRUCTION_CONTENT');
    const ruleIdx = prompt.indexOf('RULE_CONTENT');
    const skillIdx = prompt.indexOf('demo-skill');
    expect(ruleIdx).toBeGreaterThan(instructionIdx);
    expect(skillIdx).toBeGreaterThan(ruleIdx);
    expect(prompt).toContain('Demo skill description.');
  });

  it('skill index and omission lines render into composeSdkSystemPromptAppend the same way (no engine branch)', async () => {
    const root = await makeGitRepo();
    await writeSkill(root, 'sdk-demo-skill', '---\nname: sdk-demo-skill\ndescription: SDK-visible too.\n---\n');

    const instructions = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });
    const result = composeSdkSystemPromptAppend({ context, instructions });

    expect(result).toContain('sdk-demo-skill');
    expect(result).toContain('SDK-visible too.');
  });
});

// ---------------------------------------------------------------------------
// rulesLayerBytesUsed (Issue #1343 Phase B, R1): how much of
// RULES_LAYER_CAP_BYTES the eager unscoped layer already consumed -- what
// main.ts subtracts to compute RuleActivator's remaining lazy-activation
// budget.
// ---------------------------------------------------------------------------

describe('rulesLayerBytesUsed', () => {
  it('is 0 when ruleSegments is absent (hand-built fixture)', () => {
    expect(rulesLayerBytesUsed({ segments: [] })).toBe(0);
  });

  it('is 0 when ruleSegments is an empty array', () => {
    expect(rulesLayerBytesUsed({ segments: [], ruleSegments: [] })).toBe(0);
  });

  it('sums the UTF-8 byte length of every ruleSegments entry', () => {
    const result = rulesLayerBytesUsed({
      segments: [],
      ruleSegments: [
        { origin: '/a.md', content: 'abc' }, // 3 bytes
        { origin: '/b.md', content: 'éé' }, // 2 code points, 2 bytes each in UTF-8 = 4 bytes
      ],
    });
    expect(result).toBe(7);
  });

  it('matches the real loadInstructions result for a repo with unscoped rules', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'unscoped.md'), 'RULE_CONTENT');

    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome() });

    expect(rulesLayerBytesUsed(result)).toBe(new TextEncoder().encode('RULE_CONTENT').length);
  });
});

// Architect N1: a bare `Number(env) || default` lets a negative override
// through unclamped (Number('-5') is truthy), which would drop every rule
// on the first over-budget check. parseRulesLayerCapBytes clamps.
describe('parseRulesLayerCapBytes', () => {
  it('uses the default when the env value is undefined', () => {
    expect(parseRulesLayerCapBytes(undefined)).toBe(160 * 1024);
  });

  it('uses a positive numeric override verbatim', () => {
    expect(parseRulesLayerCapBytes('4096')).toBe(4096);
  });

  it('falls back to the default for a negative value', () => {
    expect(parseRulesLayerCapBytes('-5')).toBe(160 * 1024);
  });

  it('falls back to the default for zero', () => {
    expect(parseRulesLayerCapBytes('0')).toBe(160 * 1024);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(parseRulesLayerCapBytes('not-a-number')).toBe(160 * 1024);
  });
});

// Same clamping rule as parseRulesLayerCapBytes (shared parseCapBytesEnv),
// applied to the skills layer's own, much smaller default budget.
describe('parseSkillsLayerCapBytes', () => {
  it('uses the default when the env value is undefined', () => {
    expect(parseSkillsLayerCapBytes(undefined)).toBe(16 * 1024);
  });

  it('uses a positive numeric override verbatim', () => {
    expect(parseSkillsLayerCapBytes('4096')).toBe(4096);
  });

  it('falls back to the default for a negative value', () => {
    expect(parseSkillsLayerCapBytes('-5')).toBe(16 * 1024);
  });

  it('falls back to the default for zero', () => {
    expect(parseSkillsLayerCapBytes('0')).toBe(16 * 1024);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(parseSkillsLayerCapBytes('not-a-number')).toBe(16 * 1024);
  });
});

describe('composeSdkSystemPromptAppend', () => {
  // Issue #1694 (C5): the SDK append carries the SAME identity preamble the
  // openai-api arm gets, through the single writer `buildPreamble`. Before
  // this change a claude-sdk worker without Bash (the default enabledTools)
  // had no identity source at all -- the preamble stated the ids only on the
  // openai-api arm. Reach measured: removing `buildPreamble(params.context)`
  // from `composeSdkSystemPromptAppend`'s section list (and equally,
  // reverting to the pre-#1694 "undefined when nothing to append" shape)
  // fails five tests in this block (identity present, byte-identical
  // prefix, Repository ID rule, preamble-then-definition, empty-string
  // definition) plus two in sdk-engine.test.ts; rendering the preamble
  // LAST instead of first fails the four ordering-sensitive ones (prefix,
  // preamble-then-definition, segment order, empty-string definition).
  it('renders the identity preamble (session, worker, repository id) even with no segments and no definition system prompt', () => {
    const result = composeSdkSystemPromptAppend({ context, instructions: { segments: [] } });
    expect(result).toContain('embedded agent running inside agent-console');
    expect(result).toContain('Session ID: sess-1');
    expect(result).toContain('Worker ID: work-1');
    expect(result).toContain('Repository ID: repo-1');
    expect(result).toContain('fromSessionId');
    // Never undefined any more: the preamble alone is a non-empty append.
    expect(typeof result).toBe('string');
  });

  it('renders the preamble through the same single writer as assembleSystemPrompt (byte-identical prefix on both arms)', () => {
    const instructions: LoadInstructionsResult = {
      segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }],
    };
    const openai = assembleSystemPrompt({ context, instructions, definitionSystemPrompt: 'OPERATOR_MARKER' });
    const sdk = composeSdkSystemPromptAppend({ context, instructions, definitionSystemPrompt: 'OPERATOR_MARKER' });
    // Both arms produce the identical string from the identical params --
    // one writer, no per-engine preamble variant.
    expect(sdk).toBe(openai);
    const preambleEnd = openai.indexOf('\n\n--- Instructions:');
    expect(preambleEnd).toBeGreaterThan(0);
    expect(sdk.slice(0, preambleEnd)).toContain('Session ID: sess-1');
  });

  it('omits the Repository ID line when repositoryId is absent (same rule as assembleSystemPrompt)', () => {
    const result = composeSdkSystemPromptAppend({
      context: { sessionId: 's', workerId: 'w', cwd: '/c' },
      instructions: { segments: [] },
    });
    expect(result).toContain('Session ID: s');
    expect(result).not.toContain('Repository ID:');
  });

  it('returns the preamble followed by only the definition system prompt when there are no segments', () => {
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: { segments: [] },
      definitionSystemPrompt: 'OPERATOR_PROMPT',
    });
    expect(result.endsWith('\n\nOPERATOR_PROMPT')).toBe(true);
    expect(result.indexOf('Session ID: sess-1')).toBeLessThan(result.indexOf('OPERATOR_PROMPT'));
  });

  it('renders segments using the same "--- Instructions: <origin> ---" delimiter as assembleSystemPrompt, after the preamble and before the definition system prompt', () => {
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: { segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }] },
      definitionSystemPrompt: 'OPERATOR_MARKER',
    });
    expect(result).toContain('--- Instructions: /repo/AGENTS.md ---\nREPO_MARKER');
    const preambleIdx = result.indexOf('Session ID: sess-1');
    const repoIdx = result.indexOf('REPO_MARKER');
    const operatorIdx = result.indexOf('OPERATOR_MARKER');
    expect(repoIdx).toBeGreaterThan(preambleIdx);
    expect(operatorIdx).toBeGreaterThan(repoIdx);
  });

  it('omits the definition system prompt section when it is an empty string (matches assembleSystemPrompt)', () => {
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: { segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }] },
      definitionSystemPrompt: '',
    });
    expect(result.endsWith('\n\n--- Instructions: /repo/AGENTS.md ---\nREPO_MARKER')).toBe(true);
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
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: {
        segments: [{ origin: '/repo/AGENTS.md', content: 'REPO_MARKER' }],
        ruleSegments: [{ origin: '/repo/.claude/rules/unscoped.md', content: 'RULE_MARKER' }],
      },
      definitionSystemPrompt: 'OPERATOR_MARKER',
    });
    expect(result).toContain('--- Rule: /repo/.claude/rules/unscoped.md ---\nRULE_MARKER');
    const instructionIdx = result.indexOf('REPO_MARKER');
    const ruleIdx = result.indexOf('RULE_MARKER');
    const operatorIdx = result.indexOf('OPERATOR_MARKER');
    expect(ruleIdx).toBeGreaterThan(instructionIdx);
    expect(operatorIdx).toBeGreaterThan(ruleIdx);
  });

  it('renders ruleOmissionLine and ruleIndexLine verbatim when present', () => {
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: {
        segments: [],
        ruleOmissionLine: 'rules omitted for size: big.md',
        ruleIndexLine: 'Rules that apply when you touch matching paths: scoped.md (paths: src/**)',
      },
    });
    expect(result).toContain('rules omitted for size: big.md');
    expect(result).toContain('Rules that apply when you touch matching paths: scoped.md (paths: src/**)');
  });

  it('renders skillOmissionLine and skillIndexLine verbatim, after the rules-layer lines', () => {
    const result = composeSdkSystemPromptAppend({
      context,
      instructions: {
        segments: [],
        ruleIndexLine: 'Rules that apply when you touch matching paths: scoped.md (paths: src/**)',
        skillOmissionLine: 'skills omitted for size: big-skill.md',
        skillIndexLine: 'Skills available (open the named SKILL.md to read full instructions): demo -- A demo skill.',
      },
    });
    expect(result).toContain('skills omitted for size: big-skill.md');
    expect(result).toContain('Skills available (open the named SKILL.md to read full instructions): demo -- A demo skill.');
    const ruleIdx = result.indexOf('Rules that apply');
    const skillOmissionIdx = result.indexOf('skills omitted');
    const skillIndexIdx = result.indexOf('Skills available');
    expect(skillOmissionIdx).toBeGreaterThan(ruleIdx);
    expect(skillIndexIdx).toBeGreaterThan(skillOmissionIdx);
  });
});

// ---------------------------------------------------------------------------
// Memory layer (epic #1636 Phase 2, PR-3a). Every pin below was reach-measured
// by mutating system-prompt.ts and watching the pin fail; the measurement is
// recorded in each test's own comment (workflow.md, "Every pin's reach is
// measured, not predicted").
// ---------------------------------------------------------------------------
describe('loadInstructions — memory layer (epic #1636 Phase 2)', () => {
  async function makeMemoryDir(): Promise<string> {
    return makeTempDir();
  }

  async function loadWithMemory(memoryDir: string | undefined) {
    const cwd = await makeTempDir();
    return loadInstructions({ cwd, xdgConfigHome: await isolatedXdgConfigHome(), memoryDir });
  }

  const INDEX_LINE = '- [Sprint state](sprint-state.md) — where the sprint stands';

  it('is empty and silent when memoryDir is absent (no segment, no declarations, no warn)', async () => {
    // Reach: mutating `loadInstructions` to call `loadMemoryLayer('')` when
    // memoryDir is absent (rendering a header for an empty path) fails
    // `memorySegment` toBeUndefined -- measured.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(undefined);
      expect(result.memorySegment).toBeUndefined();
      expect(result.memoryOmissionLine).toBeUndefined();
      expect(result.memoryUnreadableLine).toBeUndefined();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).toLowerCase().includes('memory'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('renders the verbatim header even when MEMORY.md does not exist yet, with the absent-index line in place of the index', async () => {
    // Reach: mutating `loadMemoryLayer` to return `{}` on ENOENT (an absent
    // layer instead of an absent index) fails the header assertion;
    // mutating the absent line's text fails the second -- both measured.
    const memoryDir = await makeMemoryDir();
    const result = await loadWithMemory(memoryDir);
    expect(result.memorySegment).toBe(`${formatMemoryHeader(memoryDir)}\n${MEMORY_ABSENT_INDEX_LINE}`);
    expect(result.memorySegment).toContain(`--- Memory: ${memoryDir} ---`);
    expect(result.memorySegment).toContain('(no MEMORY.md yet — create it with your first entry)');
    expect(result.memoryUnreadableLine).toBeUndefined();
  });

  it('the header text equals the spec\'s fenced block VERBATIM (independent literal copy, path substituted)', () => {
    // The literal below is copied from docs/design/embedded-agent-worker.md
    // "The header text" by hand, NOT derived from formatMemoryHeader -- so a
    // paraphrase in production cannot ship green. Reach: changing a single
    // character of `formatMemoryHeader` ("follow." -> "follow:") fails this
    // pin and ONLY this pin -- measured; the fragment pin below stays green
    // under that mutation, which is exactly why this literal exists.
    const expected =
      '--- Memory: /data/memory/def-1 ---\n' +
      'This directory is your persistent memory for this agent definition on this repository. It is shared with every user who runs this definition on this repository (on a single-user install that is only you): record knowledge about the work, never one person\'s private details. MEMORY.md is its index; its current contents follow. Each memory is one file holding one fact, with frontmatter (name, description, metadata.type: user | feedback | project | reference). After writing a file, add a one-line pointer to MEMORY.md: `- [Title](file.md) — hook` — if MEMORY.md does not exist yet, create it with Write containing that line; otherwise re-read MEMORY.md first, then append the line with Edit anchored on the file\'s current tail (never overwrite an existing MEMORY.md with Write; other sessions may be writing it too). Read a topic file with Read when its hook is relevant; never put memory content in MEMORY.md itself.';
    expect(formatMemoryHeader('/data/memory/def-1')).toBe(expected);
  });

  it('the header text carries the load-bearing fragments (a readable subset of the verbatim pin above)', () => {
    // Pins the load-bearing sentences the WRITE half depends on, so a
    // paraphrase of the convention cannot ship silently. Reach: dropping
    // any one of the fragments from `formatMemoryHeader` fails exactly
    // its own assertion -- measured on the "never overwrite an existing" fragment.
    const header = formatMemoryHeader('/data/memory/def-1');
    expect(header.startsWith('--- Memory: /data/memory/def-1 ---\n')).toBe(true);
    expect(header).toContain(
      'It is shared with every user who runs this definition on this repository (on a single-user install that is only you)',
    );
    expect(header).toContain('metadata.type: user | feedback | project | reference');
    expect(header).toContain('`- [Title](file.md) — hook`');
    expect(header).toContain('if MEMORY.md does not exist yet, create it with Write containing that line');
    expect(header).toContain("append the line with Edit anchored on the file's current tail");
    expect(header).toContain('never overwrite an existing MEMORY.md with Write');
  });

  it('renders the MEMORY.md index content under the header when the file exists', async () => {
    // Reach: mutating the segment to omit `body` fails -- measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), `# Memory Index\n\n${INDEX_LINE}\n`);
    await writeFile(join(memoryDir, 'sprint-state.md'), '---\nname: sprint-state\n---\nbody');
    const result = await loadWithMemory(memoryDir);
    expect(result.memorySegment).toBe(`${formatMemoryHeader(memoryDir)}\n# Memory Index\n\n${INDEX_LINE}`);
    expect(result.memoryOmissionLine).toBeUndefined();
    expect(result.memoryUnreadableLine).toBeUndefined();
  });

  it('drops whole index lines largest-first over MEMORY_LAYER_CAP_BYTES and declares the dropped link targets in-band (never a truncation mid-line)', async () => {
    // The index is 5 ordinary lines plus one line whose hook alone exceeds
    // the whole 16 KiB budget, so exactly that one line must go -- and its
    // link target, not its title or hook, is what the declaration names.
    // Reach: mutating `dropLargestUntilFits`'s call to pass `0` as the byte
    // length keeps every line and fails the omission assertion; mutating
    // the declaration to name the whole line instead of the target fails
    // the toBe -- both measured.
    const memoryDir = await makeMemoryDir();
    const bigHook = 'h'.repeat(MEMORY_LAYER_CAP_BYTES + 1);
    const lines = [
      '# Memory Index',
      '- [One](one.md) — first',
      '- [Two](two.md) — second',
      `- [Huge](huge.md) — ${bigHook}`,
      '- [Three](three.md) — third',
    ];
    await writeFile(join(memoryDir, 'MEMORY.md'), `${lines.join('\n')}\n`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      expect(result.memoryOmissionLine).toBe('memory index lines omitted for size: huge.md');
      expect(result.memorySegment).toContain('- [One](one.md) — first');
      expect(result.memorySegment).toContain('- [Three](three.md) — third');
      expect(result.memorySegment).not.toContain('huge.md');
      expect(result.memorySegment).not.toContain('hhhh');
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('huge.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('bounded index read (MEMORY_INDEX_READ_CAP_BYTES)', () => {
    // Polarity, measured: mutating the loader back to an unbounded
    // `tryReadTextFile` read (and `indexTruncated = false`) fails the
    // READ_CAP+1 and mid-line declaration pins and the 1 MB case -- whose
    // drop loop then took 95 s (the quadratic cost the bound exists for,
    // measured on this host) against its 5 s ceiling; bounded, the same
    // case runs in well under a second. The size == READ_CAP boundary pin
    // passes in both worlds by design (it fixes the bound's LOWER edge).
    // ASCII-only so `.length` equals the UTF-8 byte length in this block.
    const LINE = '- [E](e.md) - 0123456789'; // 24 bytes + newline = 25

    /** Exactly `total` bytes of complete index lines ending in a newline. */
    function indexOfExactly(total: number): string {
      const header = '# Memory Index\n';
      let body = header;
      while (body.length + LINE.length + 1 <= total) body += `${LINE}\n`;
      // Pad the last line so the total lands exactly on `total` bytes.
      const remaining = total - body.length;
      if (remaining > 0) body += `${'- [P](p.md) - '.padEnd(remaining - 1, 'p')}\n`;
      return body;
    }

    it('size == READ_CAP: nothing is declared and nothing discarded (boundary)', async () => {
      const memoryDir = await makeMemoryDir();
      const content = indexOfExactly(MEMORY_INDEX_READ_CAP_BYTES);
      expect(new TextEncoder().encode(content).length).toBe(MEMORY_INDEX_READ_CAP_BYTES);
      await writeFile(join(memoryDir, 'MEMORY.md'), content);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadWithMemory(memoryDir);
        expect(result.memoryOmissionLine ?? '').not.toContain('truncated');
        // The whole index survives the 16 KiB budget? No -- it is 4x over,
        // so lines are dropped by the ordinary largest-first policy; what
        // this pin fixes is that the READ was complete: the last line of the
        // file (the padded `p.md` one) was seen by the drop loop.
        expect(result.memoryOmissionLine).toBeDefined();
        expect(result.memoryOmissionLine).toContain('memory index lines omitted for size');
        // The padded final line is the shortest, so largest-first keeps it:
        // its presence in the SEGMENT proves the read reached the file's end.
        expect(result.memorySegment).toContain('p.md');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('size == READ_CAP + 1 at a line boundary: declares 1 byte not read and discards nothing', async () => {
      const memoryDir = await makeMemoryDir();
      await writeFile(join(memoryDir, 'MEMORY.md'), `${indexOfExactly(MEMORY_INDEX_READ_CAP_BYTES)}x`);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadWithMemory(memoryDir);
        expect(result.memoryOmissionLine).toContain(
          `memory index truncated for size: 1 bytes past the first ${MEMORY_INDEX_READ_CAP_BYTES} not read`,
        );
        expect(result.memorySegment).toContain('p.md'); // the last complete line was still read (and, being shortest, kept)
        expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('truncated for size'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('cut mid-line: the partial last segment is discarded and counted with the unread remainder', async () => {
      const memoryDir = await makeMemoryDir();
      // A small index whose LAST line straddles the read cap: the prefix
      // holds `- [TAIL](tail.md) — ` plus part of the hook; the rest is past
      // the cap.
      const head = indexOfExactly(MEMORY_INDEX_READ_CAP_BYTES - 10);
      const straddler = `- [TAIL](tail.md) - ${'t'.repeat(40)}\n`;
      await writeFile(join(memoryDir, 'MEMORY.md'), head + straddler);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await loadWithMemory(memoryDir);
        // 10 bytes of the straddler were read (the partial segment), the
        // remaining straddler.length - 10 bytes were not; both are declared.
        const expectedUnread = straddler.length - 10 + 10;
        expect(result.memoryOmissionLine).toContain(
          `memory index truncated for size: ${expectedUnread} bytes past the first ${MEMORY_INDEX_READ_CAP_BYTES} not read`,
        );
        expect(result.memorySegment).not.toContain('tail.md');
        expect(result.memoryOmissionLine).not.toContain('tail.md');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a ~1 MB index still renders the header plus surviving lines, with the truncation declared', async () => {
      const memoryDir = await makeMemoryDir();
      const lines: string[] = ['# Memory Index'];
      for (let i = 0; lines.length * 25 < 1024 * 1024; i++) lines.push(LINE);
      await writeFile(join(memoryDir, 'MEMORY.md'), `${lines.join('\n')}\n`);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const started = Date.now();
        const result = await loadWithMemory(memoryDir);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result.memorySegment).toContain(formatMemoryHeader(memoryDir));
        expect(result.memorySegment).toContain(LINE);
        expect(result.memoryOmissionLine).toMatch(/memory index truncated for size: \d+ bytes past the first \d+ not read/);
        // What survived fits the KEEP budget (sum of line bytes, the cap's
        // own accounting), not merely the READ cap.
        const body = result.memorySegment!.slice(formatMemoryHeader(memoryDir).length + 1);
        const lineBytes = body.split('\n').reduce((sum, l) => sum + new TextEncoder().encode(l).length, 0);
        expect(lineBytes).toBeLessThanOrEqual(MEMORY_LAYER_CAP_BYTES);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('counts dropped lines that lack the convention\'s link shape instead of naming them', async () => {
    // Reach: mutating the unshaped branch to push the raw line into
    // `targets` fails the toBe -- measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), `# Memory Index\nfree text ${'z'.repeat(MEMORY_LAYER_CAP_BYTES + 1)}\n`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      expect(result.memoryOmissionLine).toBe(
        'memory index lines omitted for size: 1 line(s) without a link target',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('declares a file the running user cannot read (memory files unreadable), never skipping it silently', async () => {
    // umask-077 residue: a topic file another user wrote with 0600. Skipped
    // when running as root (root reads everything; the access check cannot
    // fail). Reach: mutating the loop to `continue` on an access failure
    // without recording it fails the toBe -- measured.
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) return;
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), `# Memory Index\n- [Locked](locked.md) — hidden\n`);
    await writeFile(join(memoryDir, 'locked.md'), 'secret');
    await chmod(join(memoryDir, 'locked.md'), 0o000);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      expect(result.memoryUnreadableLine).toBe('memory files unreadable: locked.md');
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('memory files unreadable: locked.md'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await chmod(join(memoryDir, 'locked.md'), 0o600);
    }
  });

  it('an unreadable MEMORY.md is declared the same way AND renders as the absent-index line', async () => {
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) return;
    // Reach: mutating the non-ENOENT read failure to render `''` as the
    // body instead of the absent line fails the segment assertion --
    // measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), '# Memory Index\n');
    await chmod(join(memoryDir, 'MEMORY.md'), 0o000);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      expect(result.memorySegment).toBe(`${formatMemoryHeader(memoryDir)}\n${MEMORY_ABSENT_INDEX_LINE}`);
      expect(result.memoryUnreadableLine).toBe('memory files unreadable: MEMORY.md');
    } finally {
      warnSpy.mockRestore();
      await chmod(join(memoryDir, 'MEMORY.md'), 0o600);
    }
  });

  it('declares regular files no index line points at (memory files not in the index) -- the recoverable form of a lost index update', async () => {
    // `./`-prefixed targets count as indexed; MEMORY.md itself is never
    // "not in the index". Reach: mutating `indexedTargets` to be empty
    // fails (indexed.md would be declared); mutating the MEMORY.md
    // exclusion fails (MEMORY.md would be declared) -- both measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(
      join(memoryDir, 'MEMORY.md'),
      '# Memory Index\n- [A](indexed.md) — a\n- [B](./dot-indexed.md) — b\n',
    );
    await writeFile(join(memoryDir, 'indexed.md'), 'a');
    await writeFile(join(memoryDir, 'dot-indexed.md'), 'b');
    await writeFile(join(memoryDir, 'orphan-2.md'), 'lost');
    await writeFile(join(memoryDir, 'orphan-1.md'), 'lost');
    await mkdir(join(memoryDir, 'a-directory'));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      expect(result.memoryUnreadableLine).toBe('memory files not in the index: orphan-1.md, orphan-2.md');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stops the access-check scan at MEMORY_LAYER_MAX_ENTRIES and declares the unchecked count', async () => {
    // 500 checked + 3 past the cap. The three past the cap are named so
    // they sort LAST (the scan takes the first N sorted names): they are
    // not in the index and must NOT appear in the not-in-index declaration
    // -- proving they were neither access-checked nor index-matched, not
    // merely that a count was printed. Reach: mutating `checked` to
    // `files` (no slice) fails both assertions -- measured.
    const memoryDir = await makeMemoryDir();
    const indexLines: string[] = [];
    const writes: Promise<void>[] = [];
    for (let i = 0; i < MEMORY_LAYER_MAX_ENTRIES - 1; i++) {
      const name = `entry-${String(i).padStart(4, '0')}.md`;
      indexLines.push(`- [E${i}](${name}) — e`);
      writes.push(writeFile(join(memoryDir, name), 'x'));
    }
    for (const name of ['zz-past-cap-1.md', 'zz-past-cap-2.md', 'zz-past-cap-3.md']) {
      writes.push(writeFile(join(memoryDir, name), 'x'));
    }
    await Promise.all(writes);
    await writeFile(join(memoryDir, 'MEMORY.md'), `# Memory Index\n${indexLines.join('\n')}\n`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      const total = MEMORY_LAYER_MAX_ENTRIES + 3;
      expect(result.memoryUnreadableLine).toBe(`memory directory has ${total} files; 3 not checked`);
      expect(result.memoryUnreadableLine).not.toContain('zz-past-cap');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('every declaration lists at most MEMORY_DECLARATION_MAX_NAMES names plus a count', async () => {
    // 25 orphans: exactly 20 named, "and 5 more (25 total)". Reach:
    // mutating `formatMemoryDeclaration` to skip the slice fails -- measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), '# Memory Index\n');
    const names: string[] = [];
    for (let i = 0; i < MEMORY_DECLARATION_MAX_NAMES + 5; i++) {
      names.push(`orphan-${String(i).padStart(2, '0')}.md`);
    }
    await Promise.all(names.map((n) => writeFile(join(memoryDir, n), 'x')));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await loadWithMemory(memoryDir);
      const shown = names.slice(0, MEMORY_DECLARATION_MAX_NAMES).join(', ');
      expect(result.memoryUnreadableLine).toBe(
        `memory files not in the index: ${shown}, and 5 more (${MEMORY_DECLARATION_MAX_NAMES + 5} total)`,
      );
      expect(result.memoryUnreadableLine).not.toContain('orphan-24.md');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('declarations are warn-logged to stderr, never written to stdout (the NDJSON channel)', async () => {
    // Reach: mutating the declaration log to `console.log` fails the
    // stdout assertion -- measured.
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), '# Memory Index\n');
    await writeFile(join(memoryDir, 'orphan.md'), 'x');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await loadWithMemory(memoryDir);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('memory files not in the index: orphan.md'))).toBe(true);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('the memory layer\'s budget is independent of the instructions aggregate cap, the rules cap, and the skills cap', async () => {
    // Reach: mutating `loadMemoryLayer` to use `SKILLS_LAYER_CAP_BYTES`
    // does NOT fail this pin (same default) -- recorded as a known limit;
    // the independence proven here is from the aggregate cap only, which
    // a `INSTRUCTION_AGGREGATE_CAP_BYTES + 1000`-byte rule file exhausts
    // without touching the memory index.
    const root = await makeTempDir();
    await mkdir(join(root, '.git'));
    const rulesDir = join(root, '.claude', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'r.md'), 'w'.repeat(INSTRUCTION_AGGREGATE_CAP_BYTES + 1000));
    const memoryDir = await makeMemoryDir();
    await writeFile(join(memoryDir, 'MEMORY.md'), `# Memory Index\n${INDEX_LINE}\n`);
    await writeFile(join(memoryDir, 'sprint-state.md'), 'x');
    const result = await loadInstructions({ cwd: root, xdgConfigHome: await isolatedXdgConfigHome(), memoryDir });
    expect(result.memorySegment).toContain(INDEX_LINE);
    expect(result.memoryOmissionLine).toBeUndefined();
  });
});

describe('parseMemoryLayerCapBytes / parseMemoryLayerMaxEntries', () => {
  // Same clamp as the rules/skills parsers (Architect N1): a non-positive
  // or non-numeric override falls back to the default. Reach: mutating the
  // shared clamp to `Number(raw) || default` fails the '-5' cases -- measured.
  it('defaults to 16 KiB / 500', () => {
    expect(parseMemoryLayerCapBytes(undefined)).toBe(16 * 1024);
    expect(parseMemoryLayerMaxEntries(undefined)).toBe(500);
  });

  it('honours a positive override', () => {
    expect(parseMemoryLayerCapBytes('4096')).toBe(4096);
    expect(parseMemoryLayerMaxEntries('10')).toBe(10);
  });

  it('falls back on a negative, zero, or non-numeric override', () => {
    expect(parseMemoryLayerCapBytes('-5')).toBe(16 * 1024);
    expect(parseMemoryLayerCapBytes('0')).toBe(16 * 1024);
    expect(parseMemoryLayerCapBytes('not-a-number')).toBe(16 * 1024);
    expect(parseMemoryLayerMaxEntries('-5')).toBe(500);
    expect(parseMemoryLayerMaxEntries('0')).toBe(500);
    expect(parseMemoryLayerMaxEntries('nope')).toBe(500);
  });
});

describe('memory layer — position in the rendered order (single writer: renderInstructionsBody)', () => {
  const fixture: LoadInstructionsResult = {
    segments: [{ origin: '/repo/AGENTS.md', content: 'INSTRUCTION_MARKER' }],
    ruleSegments: [{ origin: '/repo/.claude/rules/a.md', content: 'RULE_MARKER' }],
    ruleIndexLine: 'Rules that apply when you touch matching paths: scoped.md (paths: src/**)',
    skillOmissionLine: 'skills omitted for size: big-skill',
    skillIndexLine: 'Skills available (open the named SKILL.md to read full instructions): demo -- A demo skill.',
    memoryUnreadableLine: 'memory files unreadable: locked.md',
    memoryOmissionLine: 'memory index lines omitted for size: huge.md',
    memorySegment: '--- Memory: /data/memory/def ---\nHEADER\n- [One](one.md) — MEMORY_INDEX_MARKER',
  };

  function assertOrder(rendered: string): void {
    const idx = (s: string) => {
      const i = rendered.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const skillsIdx = idx('Skills available');
    const unreadableIdx = idx('memory files unreadable');
    const omissionIdx = idx('memory index lines omitted');
    const segmentIdx = idx('--- Memory: /data/memory/def ---');
    const definitionIdx = idx('DEFINITION_PROMPT_MARKER');
    expect(unreadableIdx).toBeGreaterThan(skillsIdx);
    expect(omissionIdx).toBeGreaterThan(unreadableIdx);
    expect(segmentIdx).toBeGreaterThan(omissionIdx);
    expect(definitionIdx).toBeGreaterThan(segmentIdx);
  }

  it('assembleSystemPrompt: after the skills index, unreadable -> omission -> segment, before definitionSystemPrompt', () => {
    // Reach: swapping the omission/segment push order in
    // `renderInstructionsBody` fails; moving the memory pushes above the
    // skills index fails; appending the memory segment after the definition
    // prompt in `assembleSystemPrompt` fails -- all three measured.
    assertOrder(assembleSystemPrompt({ context, instructions: fixture, definitionSystemPrompt: 'DEFINITION_PROMPT_MARKER' }));
  });

  it('composeSdkSystemPromptAppend: the identical order (same single writer)', () => {
    assertOrder(composeSdkSystemPromptAppend({ context, instructions: fixture, definitionSystemPrompt: 'DEFINITION_PROMPT_MARKER' }));
  });
});
