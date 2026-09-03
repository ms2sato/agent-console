import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleActivator } from '../rule-activation.js';
import type { ScopedRule } from '../system-prompt.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-rule-activation-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes a rule file to real disk and returns its ScopedRule descriptor.
 * `name` is the rule's identity (what `RuleActivator` treats as an opaque
 * key) -- the file written to disk is `<name>.md`, mirroring how
 * `loadRulesLayer` derives a rule's `name` from its filename, but this
 * helper keeps the two spellings separate on purpose so assertions below can
 * read `['r']` rather than `['r.md']`.
 */
async function writeRule(dir: string, name: string, globs: string[], content: string): Promise<ScopedRule> {
  const origin = join(dir, `${name}.md`);
  await writeFile(origin, content);
  return { name, origin, globs };
}

describe('RuleActivator.matchScopedRules — R3 match table', () => {
  it('Read: matches on args.path', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: 'src/x.ts' })).toEqual(['r']);
  });

  it('Write: matches on args.file_path', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Write', { file_path: 'src/x.ts' })).toEqual(['r']);
  });

  it('Edit: matches on args.file_path', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Edit', { file_path: 'src/x.ts' })).toEqual(['r']);
  });

  it('Glob: matches on args.path treated as a directory candidate, when present', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Glob', { pattern: '*.ts', path: 'src' })).toEqual(['r']);
  });

  it('Glob: no candidate at all when args.path is absent -- never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Glob', { pattern: '*.ts' })).toEqual([]);
  });

  it('Grep: matches on args.path treated as a directory candidate, when present', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Grep', { pattern: 'foo', path: 'src' })).toEqual(['r']);
  });

  it('Grep: no candidate at all when args.path is absent -- never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Grep', { pattern: 'foo' })).toEqual([]);
  });

  it('Bash never matches, regardless of what its args happen to contain', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Bash', { command: 'ls', path: 'src/x.ts', file_path: 'src/x.ts' })).toEqual(
      [],
    );
  });

  it('TodoWrite never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('TodoWrite', { path: 'src/x.ts' })).toEqual([]);
  });

  it('an MCP-style tool name never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('close_session', { path: 'src/x.ts' })).toEqual([]);
  });

  it('Compact never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Compact', { path: 'src/x.ts' })).toEqual([]);
  });
});

describe('RuleActivator.matchScopedRules — R3 SDK-arm extension (#1343 Phase B)', () => {
  it('Read: matches on args.file_path when args.path is absent (the native claude CLI shape)', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { file_path: 'src/x.ts' })).toEqual(['r']);
  });

  it('Read: still matches on args.path when present (openai-api shape, regression-guard)', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: 'src/x.ts' })).toEqual(['r']);
  });

  it('Read: args.path wins over args.file_path when both are present (pinned tie-break, not expected in production)', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const outsideRule = await writeRule(dir, 'outside', ['lib/**'], 'C2');
    const activator = new RuleActivator({
      scopedRules: [rule, outsideRule],
      gitRoot: dir,
      cwd: dir,
      remainingBudgetBytes: 1000,
    });
    // `path` (src/x.ts) matches `r`; `file_path` (lib/x.ts) would match
    // `outside` instead -- only `r` is returned, confirming `path` was the
    // one actually consulted.
    expect(activator.matchScopedRules('Read', { path: 'src/x.ts', file_path: 'lib/x.ts' })).toEqual(['r']);
  });

  it('NotebookEdit: matches on args.notebook_path', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('NotebookEdit', { notebook_path: 'src/x.ipynb' })).toEqual(['r']);
  });

  it('NotebookEdit: no candidate at all when notebook_path is absent -- never matches', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('NotebookEdit', { cell_id: 'abc' })).toEqual([]);
  });
});

describe('RuleActivator.matchScopedRules — path resolution', () => {
  it('resolves a relative candidate against cwd', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: 'src/x.ts' })).toEqual(['r']);
  });

  it('resolves an already-absolute candidate directly', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: join(dir, 'src', 'x.ts') })).toEqual(['r']);
  });

  it('a candidate outside the git root matches nothing', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: join(outside, 'x.ts') })).toEqual([]);
  });

  it('supports brace-expansion globs (e.g. **/*.{ts,tsx})', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*.{ts,tsx}'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', { path: 'a/b.tsx' })).toEqual(['r']);
    expect(activator.matchScopedRules('Read', { path: 'a/b.ts' })).toEqual(['r']);
    expect(activator.matchScopedRules('Read', { path: 'a/b.js' })).toEqual([]);
  });

  it('a non-object args value never produces a candidate', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(activator.matchScopedRules('Read', null)).toEqual([]);
    expect(activator.matchScopedRules('Read', 'not-an-object')).toEqual([]);
    expect(activator.matchScopedRules('Read', undefined)).toEqual([]);
  });
});

describe('RuleActivator — once-only activation', () => {
  it('a rule matched and activated once is excluded from a later matchScopedRules call for the same name', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'CONTENT');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });

    const firstMatch = activator.matchScopedRules('Read', { path: 'src/x.ts' });
    expect(firstMatch).toEqual(['r']);
    const block = await activator.activate(firstMatch);
    expect(block?.text).toContain('[rule activated: r]');

    const secondMatch = activator.matchScopedRules('Read', { path: 'src/y.ts' });
    expect(secondMatch).toEqual([]);
  });
});

describe('RuleActivator.activate — block format', () => {
  it('pins the exact block format for a single activated rule', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**', 'lib/**'], 'THE CONTENT');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });

    const block = await activator.activate(['r']);

    expect(block).not.toBeNull();
    expect(block?.text).toBe(
      `[rule activated: r]\n--- Rule (applies to: src/**, lib/**): ${rule.origin} ---\nTHE CONTENT`,
    );
    expect(block?.skippedForSize).toEqual([]);
    expect(block?.activatedNames).toEqual(['r']);
  });

  it('joins multiple activated rules in NAME order, separated by a blank line', async () => {
    const dir = await makeTempDir();
    const ruleB = await writeRule(dir, 'b', ['b/**'], 'B_CONTENT');
    const ruleA = await writeRule(dir, 'a', ['a/**'], 'A_CONTENT');
    const activator = new RuleActivator({
      scopedRules: [ruleB, ruleA],
      gitRoot: dir,
      cwd: dir,
      remainingBudgetBytes: 1000,
    });

    const block = await activator.activate(['b', 'a']);

    expect(block?.text).toBe(
      `[rule activated: a]\n--- Rule (applies to: a/**): ${ruleA.origin} ---\nA_CONTENT\n\n` +
        `[rule activated: b]\n--- Rule (applies to: b/**): ${ruleB.origin} ---\nB_CONTENT`,
    );
    // Same NAME order as `text`'s blocks, not the caller-given order.
    expect(block?.activatedNames).toEqual(['a', 'b']);
  });

  it('activate([]) returns null', async () => {
    const dir = await makeTempDir();
    const activator = new RuleActivator({ scopedRules: [], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    expect(await activator.activate([])).toBeNull();
  });

  it('activate() of only already-activated names returns null', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['**/*'], 'C');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });
    activator.seedActivated(['r']);
    expect(await activator.activate(['r'])).toBeNull();
  });
});

describe('RuleActivator.activate — budget exhaustion', () => {
  it('a rule larger than the remaining budget is reported in skippedForSize, never activated, and does not consume budget', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'big', ['**/*'], 'x'.repeat(100));
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 50 });

    const block = await activator.activate(['big']);

    expect(block).toEqual({
      text: '[rule not activated for size: big]',
      skippedForSize: ['big'],
      activatedNames: [],
    });

    // Not marked activated -- still returned as a fresh match candidate.
    expect(activator.matchScopedRules('Read', { path: 'big.md' })).toEqual(['big']);
  });

  it('re-attempting a size-skipped name on a later call is harmless (re-reads and re-checks; does not crash or double-count)', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'big', ['**/*'], 'x'.repeat(100));
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 50 });

    const first = await activator.activate(['big']);
    const second = await activator.activate(['big']);

    expect(first?.skippedForSize).toEqual(['big']);
    expect(second?.skippedForSize).toEqual(['big']);
  });

  it('a rule within budget is activated and its bytes are deducted for subsequent calls', async () => {
    const dir = await makeTempDir();
    const ruleSmall = await writeRule(dir, 'small', ['a/**'], 'x'.repeat(10));
    const ruleBig = await writeRule(dir, 'big', ['b/**'], 'y'.repeat(10));
    const activator = new RuleActivator({
      scopedRules: [ruleSmall, ruleBig],
      gitRoot: dir,
      cwd: dir,
      remainingBudgetBytes: 15,
    });

    const firstBlock = await activator.activate(['small']);
    expect(firstBlock?.skippedForSize).toEqual([]);

    const secondBlock = await activator.activate(['big']);
    expect(secondBlock?.skippedForSize).toEqual(['big']);
  });
});

describe('RuleActivator.activate — vanished file', () => {
  it('warn-logs and skips a rule whose file vanished since index time (never activated, never in skippedForSize)', async () => {
    const dir = await makeTempDir();
    const rule: ScopedRule = { name: 'gone', origin: join(dir, 'gone.md'), globs: ['**/*'] };
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const block = await activator.activate(['gone']);
      expect(block).toBeNull();
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('gone'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    // Not activated -- still a fresh match candidate.
    expect(activator.matchScopedRules('Read', { path: 'gone.md' })).toEqual(['gone']);
  });
});

describe('RuleActivator.seedActivated — R4', () => {
  it('pre-marks names as activated without spending budget', async () => {
    const dir = await makeTempDir();
    const rule = await writeRule(dir, 'r', ['src/**'], 'CONTENT');
    const activator = new RuleActivator({ scopedRules: [rule], gitRoot: dir, cwd: dir, remainingBudgetBytes: 1000 });

    activator.seedActivated(['r']);

    expect(activator.matchScopedRules('Read', { path: 'src/x.ts' })).toEqual([]);
    expect(await activator.activate(['r'])).toBeNull();
  });
});
