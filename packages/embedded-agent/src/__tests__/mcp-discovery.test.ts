import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyArgSubstitution,
  discoverProjectMcpServers,
  readUserLocalMcpNames,
} from '../mcp-discovery.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-mcp-discovery-'));
  tempDirs.push(dir);
  return dir;
}

async function writeMcpJson(dir: string, content: unknown | string): Promise<void> {
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  await writeFile(join(dir, '.mcp.json'), body);
}

describe('discoverProjectMcpServers', () => {
  it('returns an empty server list when .mcp.json is absent (routine, no error)', async () => {
    const dir = await makeTempDir();
    const result = await discoverProjectMcpServers(dir, []);
    expect(result).toEqual({ servers: [] });
  });

  it('returns an empty server list for {}', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, {});
    const result = await discoverProjectMcpServers(dir, []);
    expect(result).toEqual({ servers: [] });
  });

  it('returns an empty server list for {"mcpServers":{}}', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: {} });
    const result = await discoverProjectMcpServers(dir, []);
    expect(result).toEqual({ servers: [] });
  });

  it('reports mcpJsonError, never throws, on malformed JSON', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, '{ not valid json');
    const result = await discoverProjectMcpServers(dir, []);
    expect(result.servers).toEqual([]);
    expect(result.mcpJsonError).toBeDefined();
  });

  it('marks an entry missing both command and url as invalid, without dropping it', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: { broken: { env: { X: '1' } } } });
    const result = await discoverProjectMcpServers(dir, []);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ name: 'broken', decision: 'invalid', hash: '' });
  });

  it('rejects a server named exactly "agent-console" or "console" as reserved', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, {
      mcpServers: {
        'agent-console': { command: 'evil' },
        console: { command: 'also-evil' },
      },
    });
    const result = await discoverProjectMcpServers(dir, []);
    expect(result.servers).toHaveLength(2);
    for (const server of result.servers) {
      expect(server.decision).toBe('rejected-reserved');
    }
  });

  it('reads decision "allowed" when the name+hash pair matches the allow list', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: { x: { command: 'run-x' } } });
    const discovery = await discoverProjectMcpServers(dir, []);
    const hash = discovery.servers[0].hash;

    const result = await discoverProjectMcpServers(dir, [{ name: 'x', hash }]);
    expect(result.servers[0].decision).toBe('allowed');
  });

  it('reads decision "pending" for an undeclared server', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: { x: { command: 'run-x' } } });
    const result = await discoverProjectMcpServers(dir, []);
    expect(result.servers[0].decision).toBe('pending');
  });

  /**
   * Branch-swap property (test-trigger.md's polarity instruction for this
   * script): the SAME name with DIFFERENT content must never read "allowed"
   * just because an older hash for that name was once approved.
   *
   * Polarity measured directly: a name-only equality check (ignoring hash)
   * WOULD read this scenario as "allowed" -- demonstrated below via a
   * hand-rolled name-only predicate -- while the real implementation reads
   * "pending". This is the concrete reach measurement the AC asks for.
   */
  it('treats a changed hash for the same server name as pending, not allowed (branch-swap)', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: { x: { command: 'run-x', args: ['--old'] } } });
    const before = await discoverProjectMcpServers(dir, []);
    const oldHash = before.servers[0].hash;

    await writeMcpJson(dir, { mcpServers: { x: { command: 'run-x', args: ['--new'] } } });
    const allowed = [{ name: 'x', hash: oldHash }];
    const after = await discoverProjectMcpServers(dir, allowed);
    const entry = after.servers.find((s) => s.name === 'x');

    expect(entry?.hash).not.toBe(oldHash);
    expect(entry?.decision).toBe('pending');

    // Polarity measurement: a name-only predicate WOULD wrongly read this as
    // allowed -- the real implementation additionally compares `hash` and
    // does not.
    const nameOnlyWouldAllow = allowed.some((a) => a.name === entry?.name);
    expect(nameOnlyWouldAllow).toBe(true);
    expect(entry?.decision).not.toBe('allowed');
  });

  it('hashes identically regardless of key order or JSON whitespace', async () => {
    const dirA = await makeTempDir();
    await writeMcpJson(dirA, '{"mcpServers":{"x":{"command":"run","args":["a"],"env":{"B":"2","A":"1"}}}}');
    const dirB = await makeTempDir();
    await writeMcpJson(
      dirB,
      `{
        "mcpServers": {
          "x": { "env": { "A": "1", "B": "2" }, "args": ["a"], "command": "run" }
        }
      }`,
    );

    const resultA = await discoverProjectMcpServers(dirA, []);
    const resultB = await discoverProjectMcpServers(dirB, []);
    expect(resultA.servers[0].hash).toBe(resultB.servers[0].hash);
  });

  it('hashes identically whether "type: stdio" is explicit or omitted', async () => {
    const dirA = await makeTempDir();
    await writeMcpJson(dirA, { mcpServers: { x: { command: 'run' } } });
    const dirB = await makeTempDir();
    await writeMcpJson(dirB, { mcpServers: { x: { type: 'stdio', command: 'run' } } });

    const resultA = await discoverProjectMcpServers(dirA, []);
    const resultB = await discoverProjectMcpServers(dirB, []);
    expect(resultA.servers[0].hash).toBe(resultB.servers[0].hash);
  });

  it('normalizes an http entry', async () => {
    const dir = await makeTempDir();
    await writeMcpJson(dir, { mcpServers: { remote: { url: 'https://example.com/mcp' } } });
    const result = await discoverProjectMcpServers(dir, []);
    expect(result.servers[0].config).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(result.servers[0].decision).toBe('pending');
  });
});

describe('applyArgSubstitution', () => {
  it('returns args unchanged and no warnings when there is nothing to substitute', () => {
    const result = applyArgSubstitution('srv', ['--flag', 'value'], {});
    expect(result).toEqual({ args: ['--flag', 'value'], warnings: [] });
  });

  it('passes through undefined args unchanged', () => {
    const result = applyArgSubstitution('srv', undefined, {});
    expect(result).toEqual({ args: undefined, warnings: [] });
  });

  it('substitutes a set ${VAR}', () => {
    const result = applyArgSubstitution('srv', ['${TOKEN}'], { TOKEN: 'secret' });
    expect(result.args).toEqual(['secret']);
    expect(result.warnings).toEqual([]);
  });

  it('leaves an unset ${VAR} literal and warns, naming the server and variable', () => {
    const result = applyArgSubstitution('srv', ['${TOKEN}'], {});
    expect(result.args).toEqual(['${TOKEN}']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('srv');
    expect(result.warnings[0]).toContain('TOKEN');
  });

  it('uses the actual value over the default when ${VAR:-default} is set', () => {
    const result = applyArgSubstitution('srv', ['${TOKEN:-fallback}'], { TOKEN: 'real' });
    expect(result.args).toEqual(['real']);
    expect(result.warnings).toEqual([]);
  });

  it('uses the default, with no warning, when ${VAR:-default} is unset', () => {
    const result = applyArgSubstitution('srv', ['${TOKEN:-fallback}'], {});
    expect(result.args).toEqual(['fallback']);
    expect(result.warnings).toEqual([]);
  });

  it('uses an empty default, with no warning, for ${VAR:-} when unset', () => {
    const result = applyArgSubstitution('srv', ['${TOKEN:-}'], {});
    expect(result.args).toEqual(['']);
    expect(result.warnings).toEqual([]);
  });

  it('substitutes multiple placeholders within one arg string', () => {
    const result = applyArgSubstitution('srv', ['${A}-${B}'], { A: '1', B: '2' });
    expect(result.args).toEqual(['1-2']);
  });

  it('substitutes across multiple args, collecting one warning per unresolved placeholder', () => {
    const result = applyArgSubstitution('srv', ['${A}', '${B}'], { A: '1' });
    expect(result.args).toEqual(['1', '${B}']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('B');
  });
});

describe('readUserLocalMcpNames', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });

  async function writeClaudeJson(dir: string, content: unknown | string): Promise<void> {
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(dir, '.claude.json'), body);
    process.env.CLAUDE_CONFIG_DIR = dir;
  }

  it('reports unavailable when the file does not exist', async () => {
    const dir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = dir;
    const result = await readUserLocalMcpNames('/work');
    expect(result).toEqual({ names: new Set(), unavailable: true });
  });

  it('reports unavailable on malformed JSON', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, '{ not json');
    const result = await readUserLocalMcpNames('/work');
    expect(result.unavailable).toBe(true);
  });

  it('reads top-level (User-scope) mcpServers names', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, { mcpServers: { alpha: {}, beta: {} } });
    const result = await readUserLocalMcpNames('/work');
    expect(result.unavailable).toBe(false);
    expect(result.names).toEqual(new Set(['alpha', 'beta']));
  });

  it('reads projects[cwd].mcpServers (Local-scope) names, matched by exact cwd string', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, {
      projects: {
        '/work/matching': { mcpServers: { gamma: {} } },
        '/work/other': { mcpServers: { delta: {} } },
      },
    });
    const result = await readUserLocalMcpNames('/work/matching');
    expect(result.names).toEqual(new Set(['gamma']));
  });

  it('unions User-scope and Local-scope names', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, {
      mcpServers: { alpha: {} },
      projects: { '/work': { mcpServers: { gamma: {} } } },
    });
    const result = await readUserLocalMcpNames('/work');
    expect(result.names).toEqual(new Set(['alpha', 'gamma']));
  });

  it('treats an entirely absent mcpServers/projects as zero names, not a failure', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, { unrelated: true });
    const result = await readUserLocalMcpNames('/work');
    expect(result).toEqual({ names: new Set(), unavailable: false });
  });

  it('reports unavailable when top-level mcpServers is malformed (not an object)', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, { mcpServers: 'not-an-object' });
    const result = await readUserLocalMcpNames('/work');
    expect(result.unavailable).toBe(true);
  });

  it('reports unavailable when projects is malformed (not an object)', async () => {
    const dir = await makeTempDir();
    await writeClaudeJson(dir, { projects: 'not-an-object' });
    const result = await readUserLocalMcpNames('/work');
    expect(result.unavailable).toBe(true);
  });
});
