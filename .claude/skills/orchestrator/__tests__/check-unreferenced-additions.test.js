import { describe, it, expect } from 'bun:test';
import { checkUnreferencedAdditions } from '../check-unreferenced-additions.js';

const ROOT = '/repo';

/**
 * Injected fs over a flat map of repo-relative file path -> content. Directories
 * are derived from the file paths, so a test states only the files it cares about.
 */
function makeFakeFs(files) {
  const abs = Object.fromEntries(Object.entries(files).map(([p, c]) => [`${ROOT}/${p}`, c]));
  const dirChildren = new Map();
  for (const path of Object.keys(abs)) {
    const parts = path.split('/');
    for (let i = 2; i <= parts.length; i++) {
      const dir = parts.slice(0, i - 1).join('/');
      const name = parts[i - 1];
      if (!dirChildren.has(dir)) dirChildren.set(dir, new Set());
      dirChildren.get(dir).add(name);
    }
  }
  const enoent = path => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    readFileSync(path) {
      if (!(path in abs)) throw enoent(path);
      return abs[path];
    },
    readdirSync(path) {
      if (!dirChildren.has(path)) throw enoent(path);
      return [...dirChildren.get(path)];
    },
    lstatSync(path) {
      if (path in abs) return { isDirectory: () => false };
      if (dirChildren.has(path)) return { isDirectory: () => true };
      throw enoent(path);
    },
  };
}

const NEW_SCRIPT = '.claude/skills/orchestrator/new-thing.js';
const NEW_SKILL = '.claude/skills/new-skill/SKILL.md';

describe('checkUnreferencedAdditions', () => {
  it('returns no findings for an empty addedFiles list', () => {
    expect(checkUnreferencedAdditions([], ROOT, makeFakeFs({}))).toEqual({ unreferenced: [] });
  });

  it('ignores added files outside the subject patterns', () => {
    const fake = makeFakeFs({ 'CLAUDE.md': '' });
    const added = ['docs/new.md', 'scripts/new.js', '.claude/rules/new.md', '.claude/skills/orchestrator/__tests__/new.test.js', '.claude/skills/orchestrator/new.test.js', '.claude/skills/orchestrator/notes.md'];
    expect(checkUnreferencedAdditions(added, ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('passes a script named in core-responsibilities.md', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/core-responsibilities.md': 'Run `node .claude/skills/orchestrator/new-thing.js` after merge.',
    });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('fails a script named nowhere, with the fixed suggestion list including its own SKILL.md', () => {
    const fake = makeFakeFs({ [NEW_SCRIPT]: '', 'CLAUDE.md': 'nothing relevant' });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake)).toEqual({
      unreferenced: [
        {
          file: NEW_SCRIPT,
          key: 'new-thing.js',
          suggestions: [
            '.claude/skills/orchestrator/core-responsibilities.md',
            '.claude/skills/orchestrator/sprint-lifecycle.md',
            '.claude/skills/orchestrator/SKILL.md',
            '.claude/rules/',
          ],
        },
      ],
    });
  });

  it('fails a SKILL.md named nowhere, keyed by its directory name, without a self-suggestion', () => {
    const fake = makeFakeFs({ [NEW_SKILL]: '# new-skill', 'CLAUDE.md': '' });
    const { unreferenced } = checkUnreferencedAdditions([NEW_SKILL], ROOT, fake);
    expect(unreferenced).toHaveLength(1);
    expect(unreferenced[0].key).toBe('new-skill');
    expect(unreferenced[0].suggestions).toEqual([
      '.claude/skills/orchestrator/core-responsibilities.md',
      '.claude/skills/orchestrator/sprint-lifecycle.md',
      '.claude/rules/',
    ]);
  });

  it('does not count a subject as its own reference', () => {
    const fake = makeFakeFs({ [NEW_SCRIPT]: "// import './new-thing.js' lives here", [NEW_SKILL]: 'new-skill describes new-skill' });
    const { unreferenced } = checkUnreferencedAdditions([NEW_SCRIPT, NEW_SKILL], ROOT, fake);
    expect(unreferenced.map(u => u.file)).toEqual([NEW_SCRIPT, NEW_SKILL]);
  });

  it('does not count a test file as a reference', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/__tests__/new-thing.test.js': "import '../new-thing.js';",
      '.claude/skills/orchestrator/other.test.js': "import './new-thing.js';",
    });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake).unreferenced).toHaveLength(1);
  });

  it('counts a script referenced only by an import in another skill script', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/runner.js': "import { x } from './new-thing.js';",
    });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('counts a multi-line import (closing `} from` line) in another skill script', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/runner.js': "import {\n  a,\n} from './new-thing.js';",
    });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('does not count a mere comment mention in another skill script', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/runner.js': '// see new-thing.js for details',
    });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake).unreferenced).toHaveLength(1);
  });

  it('counts a SKILL.md referenced only by an agent file', () => {
    const fake = makeFakeFs({
      [NEW_SKILL]: '',
      '.claude/agents/backend-specialist.md': 'Load the new-skill skill first.',
    });
    expect(checkUnreferencedAdditions([NEW_SKILL], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('counts a SKILL.md referenced by a different skill SKILL.md', () => {
    const fake = makeFakeFs({
      [NEW_SKILL]: '',
      '.claude/skills/orchestrator/SKILL.md': 'Also load new-skill.',
    });
    expect(checkUnreferencedAdditions([NEW_SKILL], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('does not read docs/ as a reference source', () => {
    const fake = makeFakeFs({ [NEW_SCRIPT]: '', 'docs/design/x.md': 'new-thing.js is described here' });
    expect(checkUnreferencedAdditions([NEW_SCRIPT], ROOT, fake).unreferenced).toHaveLength(1);
  });

  // Plain-substring match: the key `foo.js` is found inside `foo.js.bak`. The
  // chosen behaviour is "referenced" (a rare false pass over a false block).
  it('treats a longer name containing the key as a reference (substring match)', () => {
    const fake = makeFakeFs({
      '.claude/skills/orchestrator/foo.js': '',
      '.claude/skills/orchestrator/core-responsibilities.md': 'restore foo.js.bak first',
    });
    expect(checkUnreferencedAdditions(['.claude/skills/orchestrator/foo.js'], ROOT, fake)).toEqual({ unreferenced: [] });
  });

  it('reports only the unreferenced subject when one of two is referenced', () => {
    const fake = makeFakeFs({
      [NEW_SCRIPT]: '',
      '.claude/skills/orchestrator/other-thing.js': '',
      '.claude/skills/orchestrator/sprint-lifecycle.md': 'run other-thing.js',
    });
    const { unreferenced } = checkUnreferencedAdditions([NEW_SCRIPT, '.claude/skills/orchestrator/other-thing.js'], ROOT, fake);
    expect(unreferenced.map(u => u.file)).toEqual([NEW_SCRIPT]);
  });
});
