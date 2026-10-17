import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRY = resolve(import.meta.dir, '../../phase6-analyze-run.ts');
const SID = 'sess-cli';
const FIRST_LABEL = 'Timer calls create / delete / reset';

let dir: string;
let ndjson: string;
let transcript: string;
let journal: string;

function run(args: string[]) {
  const proc = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8' });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'phase6-cli-'));
  ndjson = join(dir, 'run.ndjson');
  transcript = join(dir, 'transcript.jsonl');
  journal = join(dir, 'journal.log');
  const events = [
    { type: 'user-message' },
    { type: 'tool-call', turnId: 't1', callId: 'a', name: 'mcp__agent-console__create_timer', args: { intervalSeconds: 30 } },
    { type: 'tool-result', turnId: 't1', callId: 'a', ok: true, result: 'created' },
    { type: 'context-usage', promptTokens: 50, model: 'm' },
  ];
  writeFileSync(ndjson, `${events.map((e) => JSON.stringify(e)).join('\n')}\n\n`);
  writeFileSync(
    transcript,
    `not json\n${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1_000_000 } } })}\n`,
  );
  writeFileSync(
    journal,
    [
      'plain text line',
      JSON.stringify({ msg: 'Process started', sessionId: SID, processId: 'p', time: 1000 }),
      JSON.stringify({ msg: 'Process exited', processId: 'p', time: 2000 }),
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('phase6-analyze-run CLI', () => {
  it('prints the table and exits 0 on a complete read', () => {
    const r = run(['--ndjson', ndjson, '--transcript', transcript, '--session-id', SID]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(FIRST_LABEL);
    expect(r.stdout).toContain('| Metric | Run |');
    expect(r.stdout).toContain('3.0 USD');
    expect(r.stderr).toContain('note: skipped 1 non-JSON transcript lines');
  });

  it('adds the server-clock rows with a journal and notes skipped lines', () => {
    const r = run(['--ndjson', ndjson, '--transcript', transcript, '--journal', journal, '--session-id', SID]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Processes finished within 2 s | 1 of 1');
    expect(r.stderr).toContain('skipped 1 non-JSON journal lines');
  });

  it('exits 2 and shows UNAVAILABLE cost for an unreadable transcript', () => {
    const r = run(['--ndjson', ndjson, '--transcript', join(dir, 'missing.jsonl'), '--session-id', SID]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('UNAVAILABLE');
    expect(r.stdout).not.toContain('0 USD');
  });

  it('exits 2 and shows UNAVAILABLE cost for a transcript without assistant records', () => {
    const empty = join(dir, 'empty.jsonl');
    writeFileSync(empty, `${JSON.stringify({ type: 'user' })}\n`);
    const r = run(['--ndjson', ndjson, '--transcript', empty, '--session-id', SID]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('UNAVAILABLE');
  });

  it('exits 2 for an unreadable journal', () => {
    const r = run([
      '--ndjson', ndjson, '--transcript', transcript, '--journal', join(dir, 'nope.log'), '--session-id', SID,
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error: cannot read journal');
  });

  it('exits 2 with no table for malformed NDJSON', () => {
    const bad = join(dir, 'bad.ndjson');
    writeFileSync(bad, '{"type":"user-message"}\n{broken\n');
    const r = run(['--ndjson', bad, '--transcript', transcript, '--session-id', SID]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('error:');
  });

  it('exits 2 with usage when required flags are missing', () => {
    const r = run(['--ndjson', ndjson]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage:');
    expect(r.stdout).toBe('');
  });

  it('writes --json whose rows re-feed --baseline as a delta column', () => {
    const out = join(dir, 'metrics.json');
    const first = run(['--ndjson', ndjson, '--transcript', transcript, '--session-id', SID, '--json', out]);
    expect(first.code).toBe(0);
    const saved = JSON.parse(readFileSync(out, 'utf8'));
    expect(saved.sessionId).toBe(SID);
    expect(saved.rows[0].label).toBe(FIRST_LABEL);

    const bigger = join(dir, 'bigger.ndjson');
    const extra = { type: 'tool-call', turnId: 't1', callId: 'z', name: 'mcp__agent-console__delete_timer', args: {} };
    writeFileSync(bigger, `${readFileSync(ndjson, 'utf8')}${JSON.stringify(extra)}\n`);
    const second = run([
      '--ndjson', bigger, '--transcript', transcript, '--session-id', SID, '--baseline', out,
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('| Metric | Run | Delta vs baseline |');
    expect(second.stdout).toContain(`| ${FIRST_LABEL} | 2 (1 / 1 / 0) | +1 |`);
  });
});
