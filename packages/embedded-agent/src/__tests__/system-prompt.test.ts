import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleSystemPrompt, readAgentsMd, type SystemPromptContext } from '../system-prompt.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-agentsmd-'));
  tempDirs.push(dir);
  return dir;
}

describe('assembleSystemPrompt', () => {
  it('includes the context preamble with session, worker, cwd, and repository id', () => {
    const prompt = assembleSystemPrompt({ context, agentsMd: null });
    expect(prompt).toContain('embedded agent running inside agent-console');
    expect(prompt).toContain('Session ID: sess-1');
    expect(prompt).toContain('Worker ID: work-1');
    expect(prompt).toContain('Working directory: /work/dir');
    expect(prompt).toContain('Repository ID: repo-1');
    expect(prompt).toContain('fromSessionId');
  });

  it('omits the Repository ID line when repositoryId is absent', () => {
    const prompt = assembleSystemPrompt({
      context: { sessionId: 's', workerId: 'w', cwd: '/c' },
      agentsMd: null,
    });
    expect(prompt).not.toContain('Repository ID:');
  });

  it('wraps AGENTS.md content in a clearly delimited block', () => {
    const prompt = assembleSystemPrompt({ context, agentsMd: 'use tabs' });
    expect(prompt).toContain('--- Repository conventions (AGENTS.md) ---');
    expect(prompt).toContain('use tabs');
    expect(prompt).toContain('--- End of repository conventions ---');
  });

  it('places sections in order: preamble -> AGENTS.md -> definition system prompt', () => {
    const prompt = assembleSystemPrompt({
      context,
      agentsMd: 'REPO_CONVENTIONS_MARKER',
      definitionSystemPrompt: 'OPERATOR_MARKER',
    });
    const preambleIdx = prompt.indexOf('Session ID: sess-1');
    const agentsIdx = prompt.indexOf('REPO_CONVENTIONS_MARKER');
    const operatorIdx = prompt.indexOf('OPERATOR_MARKER');
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThan(preambleIdx);
    expect(operatorIdx).toBeGreaterThan(agentsIdx);
  });

  it('appends the definition system prompt even without AGENTS.md', () => {
    const prompt = assembleSystemPrompt({ context, agentsMd: null, definitionSystemPrompt: 'X' });
    expect(prompt.indexOf('X')).toBeGreaterThan(prompt.indexOf('Session ID'));
    expect(prompt).not.toContain('Repository conventions');
  });
});

describe('readAgentsMd', () => {
  it('reads an existing AGENTS.md at the cwd root', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'AGENTS.md'), 'hello conventions');
    expect(await readAgentsMd(dir)).toBe('hello conventions');
  });

  it('returns null when AGENTS.md is absent', async () => {
    const dir = await makeTempDir();
    expect(await readAgentsMd(dir)).toBeNull();
  });

  it('returns null (never throws) when AGENTS.md is unreadable (a directory)', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'AGENTS.md'));
    expect(await readAgentsMd(dir)).toBeNull();
  });

  it('truncates oversized content to <= 32768 content bytes and appends a notice', async () => {
    const dir = await makeTempDir();
    const oversized = 'x'.repeat(40000);
    await writeFile(join(dir, 'AGENTS.md'), oversized);

    const result = await readAgentsMd(dir);
    expect(result).not.toBeNull();
    const notice = '[AGENTS.md truncated at 32768 bytes]';
    expect(result).toContain(notice);

    const content = result!.slice(0, result!.length - notice.length - 1); // strip "\n" + notice
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(32768);
  });
});
