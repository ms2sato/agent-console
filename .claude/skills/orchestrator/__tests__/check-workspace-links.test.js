import { describe, it, expect } from 'bun:test';
import { checkWorkspaceLinks } from '../check-workspace-links.js';

/**
 * Minimal injected fs: a flat map from path to one of
 *   { kind: 'file', content: string }
 *   { kind: 'dir' }
 *   { kind: 'symlink' }
 * `readFileSync` / `readdirSync` / `lstatSync` are driven entirely off this
 * map, so every test builds its own tree with no real filesystem access.
 */
function makeFakeFs(nodes) {
  function entry(path) {
    const node = nodes[path];
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return node;
  }
  return {
    readFileSync(path) {
      const node = entry(path);
      if (node.kind !== 'file') {
        const err = new Error(`EISDIR: illegal operation, read '${path}'`);
        err.code = 'EISDIR';
        throw err;
      }
      return node.content;
    },
    readdirSync(path) {
      const node = entry(path);
      if (node.kind !== 'dir') {
        const err = new Error(`ENOTDIR: not a directory, scandir '${path}'`);
        err.code = 'ENOTDIR';
        throw err;
      }
      return node.children ?? [];
    },
    lstatSync(path) {
      const node = entry(path);
      return {
        isSymbolicLink: () => node.kind === 'symlink',
        isDirectory: () => node.kind === 'dir',
      };
    },
  };
}

const REPO_ROOT = '/repo';

/** Builds the fake-fs node map for a single workspace member under
 * `/repo/packages/<name>` whose `package.json` declares `deps` (an array of
 * bare names, e.g. `['embedded-agent']`, each expanded to
 * `@agent-console/<name>`), plus one node_modules entry per `linked` name
 * (symlink) and one per `realDir` name (a plain directory standing in for a
 * stale, non-symlink copy). */
function workspaceMember(name, { deps = [], linked = [], realDir = [] } = {}) {
  const pkgDir = `${REPO_ROOT}/packages/${name}`;
  const dependencies = {};
  for (const dep of deps) {
    dependencies[`@agent-console/${dep}`] = '*';
  }
  const nodes = {
    [pkgDir]: { kind: 'dir' },
    [`${pkgDir}/package.json`]: { kind: 'file', content: JSON.stringify({ dependencies }) },
  };
  for (const dep of linked) {
    nodes[`${pkgDir}/node_modules/@agent-console/${dep}`] = { kind: 'symlink' };
  }
  for (const dep of realDir) {
    nodes[`${pkgDir}/node_modules/@agent-console/${dep}`] = { kind: 'dir' };
  }
  return nodes;
}

/** The root `package.json` + `packages/` directory listing shared by every
 * scenario. `rootDeps` defaults to none, matching this repo's own root
 * `package.json` (measured 2026-10-10: `dependencies` is `{}`). */
function baseNodes(memberNames, { rootDeps = [] } = {}) {
  const rootDependencies = {};
  for (const dep of rootDeps) {
    rootDependencies[`@agent-console/${dep}`] = '*';
  }
  return {
    [REPO_ROOT]: { kind: 'dir' },
    [`${REPO_ROOT}/package.json`]: { kind: 'file', content: JSON.stringify({ dependencies: rootDependencies }) },
    [`${REPO_ROOT}/packages`]: { kind: 'dir', children: memberNames },
  };
}

describe('checkWorkspaceLinks', () => {
  it('(a) reports nothing when every declared workspace dep has its symlink', () => {
    const nodes = {
      ...baseNodes(['integration']),
      ...workspaceMember('integration', { deps: ['embedded-agent', 'shared'], linked: ['embedded-agent', 'shared'] }),
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([]);
  });

  it('(b) reports a dep with no node_modules entry at all, naming the package and the expected path', () => {
    const nodes = {
      ...baseNodes(['integration']),
      ...workspaceMember('integration', { deps: ['embedded-agent', 'shared'], linked: ['shared'] }),
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([
      {
        pkg: 'integration',
        dep: 'embedded-agent',
        expectedLink: `${REPO_ROOT}/packages/integration/node_modules/@agent-console/embedded-agent`,
      },
    ]);
  });

  it('(c) reports a dep present as a real directory instead of a symlink, same as an absence', () => {
    const nodes = {
      ...baseNodes(['integration']),
      ...workspaceMember('integration', { deps: ['embedded-agent'], realDir: ['embedded-agent'] }),
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([
      {
        pkg: 'integration',
        dep: 'embedded-agent',
        expectedLink: `${REPO_ROOT}/packages/integration/node_modules/@agent-console/embedded-agent`,
      },
    ]);
  });

  it('(d) reports nothing for a package with no @agent-console/* deps at all', () => {
    const pkgDir = `${REPO_ROOT}/packages/shared`;
    const nodes = {
      ...baseNodes(['shared']),
      [pkgDir]: { kind: 'dir' },
      [`${pkgDir}/package.json`]: {
        kind: 'file',
        content: JSON.stringify({ dependencies: { valibot: '^1.0.0' } }),
      },
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([]);
  });

  it('(e) reports nothing when packages/ has zero workspace members', () => {
    const nodes = baseNodes([]);
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([]);
  });

  it('also checks the repo root\'s own package.json against root node_modules/@agent-console', () => {
    const nodes = {
      ...baseNodes([], { rootDeps: ['shared'] }),
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([
      {
        pkg: 'root',
        dep: 'shared',
        expectedLink: `${REPO_ROOT}/node_modules/@agent-console/shared`,
      },
    ]);
  });

  it('finds @agent-console/* deps in devDependencies as well as dependencies', () => {
    const pkgDir = `${REPO_ROOT}/packages/integration`;
    const nodes = {
      ...baseNodes(['integration']),
      [pkgDir]: { kind: 'dir' },
      [`${pkgDir}/package.json`]: {
        kind: 'file',
        content: JSON.stringify({ devDependencies: { '@agent-console/shared': '*' } }),
      },
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([
      {
        pkg: 'integration',
        dep: 'shared',
        expectedLink: `${pkgDir}/node_modules/@agent-console/shared`,
      },
    ]);
  });

  it('reports every missing dep across multiple workspace members, not just the first', () => {
    const nodes = {
      ...baseNodes(['client', 'integration']),
      ...workspaceMember('client', { deps: ['server', 'shared'], linked: [] }),
      ...workspaceMember('integration', { deps: ['embedded-agent'], linked: ['embedded-agent'] }),
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([
      {
        pkg: 'client',
        dep: 'server',
        expectedLink: `${REPO_ROOT}/packages/client/node_modules/@agent-console/server`,
      },
      {
        pkg: 'client',
        dep: 'shared',
        expectedLink: `${REPO_ROOT}/packages/client/node_modules/@agent-console/shared`,
      },
    ]);
  });

  it('skips a packages/* entry that is not a directory (e.g. a stray file)', () => {
    const nodes = {
      ...baseNodes(['README.md']),
      [`${REPO_ROOT}/packages/README.md`]: { kind: 'file', content: 'not a package' },
    };
    const fakeFs = makeFakeFs(nodes);

    const result = checkWorkspaceLinks(REPO_ROOT, fakeFs);

    expect(result.missing).toEqual([]);
  });

  it('defaults the fs implementation to the real node:fs module', () => {
    // Smoke check for the `= fs` default on the exported signature -- does
    // not touch the real filesystem beyond confirming the call doesn't
    // throw when given a repoRoot with no package.json on disk.
    const result = checkWorkspaceLinks('/path/does/not/exist/on/this/host');
    expect(result.missing).toEqual([]);
  });
});
