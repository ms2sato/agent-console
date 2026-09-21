import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjectAgents } from '../agents-discovery.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-agents-discovery-'));
  tempDirs.push(dir);
  return dir;
}

async function makeGitRepo(): Promise<string> {
  const root = await makeTempDir();
  await mkdir(join(root, '.git'));
  return root;
}

async function writeAgentFile(dir: string, fileName: string, content: string): Promise<void> {
  const agentsDir = join(dir, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, fileName), content);
}

describe('discoverProjectAgents', () => {
  it('returns no agents when there is no .claude/agents directory anywhere in the chain', async () => {
    const root = await makeGitRepo();
    const result = await discoverProjectAgents(root, new Set());
    expect(result.agents).toEqual({});
  });

  it('discovers one agent file at cwd (== git root)', async () => {
    const root = await makeGitRepo();
    await writeAgentFile(
      root,
      'reviewer.md',
      '---\nname: reviewer\ndescription: reviews code\n---\nYou review code.',
    );
    const result = await discoverProjectAgents(root, new Set());
    expect(Object.keys(result.agents)).toEqual(['reviewer']);
    expect(result.agents.reviewer).toMatchObject({
      description: 'reviews code',
      prompt: 'You review code.',
    });
  });

  it('discovers an agent file at the git root when cwd is a nested subdirectory', async () => {
    const root = await makeGitRepo();
    const cwd = join(root, 'packages', 'server');
    await mkdir(cwd, { recursive: true });
    await writeAgentFile(
      root,
      'root-agent.md',
      '---\nname: root-agent\ndescription: from root\n---\nRoot prompt.',
    );

    const result = await discoverProjectAgents(cwd, new Set());
    expect(Object.keys(result.agents)).toEqual(['root-agent']);
  });

  it('lets the level nearest cwd win on a duplicate name across levels', async () => {
    const root = await makeGitRepo();
    const cwd = join(root, 'packages', 'server');
    await mkdir(cwd, { recursive: true });
    await writeAgentFile(root, 'dup.md', '---\nname: dup\ndescription: root version\n---\nRoot body.');
    await writeAgentFile(cwd, 'dup.md', '---\nname: dup\ndescription: nested version\n---\nNested body.');

    const result = await discoverProjectAgents(cwd, new Set());
    expect(Object.keys(result.agents)).toEqual(['dup']);
    expect(result.agents.dup.description).toBe('nested version');
    expect(result.agents.dup.prompt).toBe('Nested body.');
  });

  describe('skip rules', () => {
    it('skips a file with no "name" frontmatter key', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'no-name.md', '---\ndescription: no name here\n---\nBody.');
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents).toEqual({});
      expect(result.warnings.some((w) => w.includes('missing "name"'))).toBe(true);
    });

    it('skips a name starting with "-"', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'dash.md', '---\nname: -bad\ndescription: d\n---\nBody.');
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents).toEqual({});
      expect(result.warnings.some((w) => w.includes('starts with "-"'))).toBe(true);
    });

    it('skips a name containing ":"', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'colon.md', '---\nname: ns:agent\ndescription: d\n---\nBody.');
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents).toEqual({});
      expect(result.warnings.some((w) => w.includes('contains ":"'))).toBe(true);
    });

    it('skips a file missing "description"', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'no-desc.md', '---\nname: no-desc\n---\nBody.');
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents).toEqual({});
      expect(result.warnings.some((w) => w.includes('missing "description"'))).toBe(true);
    });

    it('skips a file with no frontmatter block at all (malformed / missing closing delimiter)', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'malformed.md', '---\nname: malformed\ndescription: no closing delimiter\nBody without a closing marker.');
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents).toEqual({});
      expect(result.warnings.some((w) => w.includes('no frontmatter block found'))).toBe(true);
    });
  });

  describe('mcpServers frontmatter filtering', () => {
    it('keeps only plain-string entries present in allowedServerNames, dropping an inline object entry and a disallowed name', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(
        root,
        'mcp-agent.md',
        [
          '---',
          'name: mcp-agent',
          'description: uses mcp',
          'mcpServers:',
          '  - allowed-server',
          '  - { command: "evil" }',
          '  - not-allowed-server',
          '---',
          'Body.',
        ].join('\n'),
      );
      const result = await discoverProjectAgents(root, new Set(['allowed-server']));
      expect(result.agents['mcp-agent'].mcpServers).toEqual(['allowed-server']);
      expect(result.warnings.some((w) => w.includes('inline object'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('not-allowed-server'))).toBe(true);
    });

    it('omits mcpServers entirely when every entry is dropped', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(
        root,
        'mcp-agent.md',
        ['---', 'name: mcp-agent', 'description: d', 'mcpServers:', '  - not-allowed', '---', 'Body.'].join('\n'),
      );
      const result = await discoverProjectAgents(root, new Set());
      expect('mcpServers' in result.agents['mcp-agent']).toBe(false);
    });
  });

  describe('tools and model frontmatter', () => {
    it('parses a comma-separated tools list and a model value', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(
        root,
        'toolsy.md',
        '---\nname: toolsy\ndescription: d\ntools: Read, Bash\nmodel: sonnet\n---\nBody.',
      );
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents.toolsy.tools).toEqual(['Read', 'Bash']);
      expect(result.agents.toolsy.model).toBe('sonnet');
    });

    it('parses a multi-line YAML tools list', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(
        root,
        'toolsy.md',
        '---\nname: toolsy\ndescription: d\ntools:\n  - Read\n  - Grep\n---\nBody.',
      );
      const result = await discoverProjectAgents(root, new Set());
      expect(result.agents.toolsy.tools).toEqual(['Read', 'Grep']);
    });

    it('omits tools/model when absent', async () => {
      const root = await makeGitRepo();
      await writeAgentFile(root, 'bare.md', '---\nname: bare\ndescription: d\n---\nBody.');
      const result = await discoverProjectAgents(root, new Set());
      expect('tools' in result.agents.bare).toBe(false);
      expect('model' in result.agents.bare).toBe(false);
    });
  });

  /**
   * Byte-cap overflow: whole definitions dropped, farthest-from-cwd first,
   * never truncated. Default AGENTS_LAYER_CAP_BYTES is 64 KiB; three ~30 KB
   * definitions across three chain levels (root=farthest, mid, leaf=cwd)
   * total ~90 KB, over budget. Dropping the farthest (root, ~30 KB) alone
   * brings the total to ~60 KB, under budget -- so exactly one drop is
   * expected.
   */
  it('drops whole agent definitions, farthest-from-cwd first, until under the byte budget', async () => {
    const root = await makeGitRepo();
    const mid = join(root, 'packages');
    const leaf = join(mid, 'server');
    await mkdir(leaf, { recursive: true });

    const bigDescription = 'X'.repeat(30_000);
    await writeAgentFile(root, 'r.md', `---\nname: r\ndescription: ${bigDescription}\n---\nBody.`);
    await writeAgentFile(mid, 'm.md', `---\nname: m\ndescription: ${bigDescription}\n---\nBody.`);
    await writeAgentFile(leaf, 'l.md', `---\nname: l\ndescription: ${bigDescription}\n---\nBody.`);

    const result = await discoverProjectAgents(leaf, new Set());
    expect(Object.keys(result.agents).sort()).toEqual(['l', 'm']);
    expect(result.warnings.some((w) => w.includes('Dropped agent definition "r"'))).toBe(true);
  });
});
