/**
 * Phase 6 run analyzer: reads a run's worker NDJSON, CLI transcript and
 * (optionally) server journal, and prints the readiness table as Markdown.
 *
 * Usage:
 *   bun scripts/phase6-analyze-run.ts --ndjson <path> --transcript <path>
 *     [--journal <path>] --session-id <id> [--json <out>] [--baseline <metrics.json>]
 *
 * Exit codes: 0 only on a complete read; 2 on bad usage, a malformed or
 * unreadable NDJSON (no table), an unreadable transcript or one without
 * assistant records (table printed, cost rows UNAVAILABLE), or an unreadable
 * journal or baseline. This file is the only place that touches the
 * filesystem; the metrics live in scripts/lib/phase6-run-metrics.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  computeNdjsonMetrics,
  computeServerClock,
  computeTranscriptCost,
  formatDelta,
  formatReadinessRows,
  type ReadinessRow,
  type ServerClockMetrics,
  type TranscriptCost,
} from './lib/phase6-run-metrics.js';

const USAGE =
  'usage: bun scripts/phase6-analyze-run.ts --ndjson <path> --transcript <path> [--journal <path>] --session-id <id> [--json <out>] [--baseline <metrics.json>]';

interface Args {
  ndjson: string;
  transcript: string;
  journal?: string;
  sessionId: string;
  json?: string;
  baseline?: string;
}

function parseArgs(argv: readonly string[]): Args | null {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--') || value === undefined) return null;
    values.set(flag.slice(2), value);
  }
  const ndjson = values.get('ndjson');
  const transcript = values.get('transcript');
  const sessionId = values.get('session-id');
  if (!ndjson || !transcript || !sessionId) return null;
  return {
    ndjson,
    transcript,
    sessionId,
    journal: values.get('journal'),
    json: values.get('json'),
    baseline: values.get('baseline'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

/** Lines that parse as JSON, plus how many non-blank lines did not. */
function parseLenient(lines: readonly string[]): { records: unknown[]; skipped: number } {
  const records: unknown[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function renderTable(rows: readonly ReadinessRow[], baseline?: readonly ReadinessRow[]): string {
  const header = baseline ? '| Metric | Run | Delta vs baseline |' : '| Metric | Run |';
  const divider = baseline ? '| --- | --- | --- |' : '| --- | --- |';
  const lines = [header, divider];
  for (const row of rows) {
    if (!baseline) {
      lines.push(`| ${row.label} | ${row.value} |`);
      continue;
    }
    const base = baseline.find((b) => b.label === row.label);
    const delta =
      row.num !== undefined && base?.num !== undefined ? formatDelta(row.num, base.num) : '-';
    lines.push(`| ${row.label} | ${row.value} | ${delta} |`);
  }
  return lines.join('\n');
}

function readBaselineRows(path: string): ReadinessRow[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const rows =
    typeof parsed === 'object' && parsed !== null ? (parsed as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows)) throw new Error('baseline file has no "rows" array');
  const out: ReadinessRow[] = [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && typeof (row as ReadinessRow).label === 'string') {
      const { label, value, num } = row as ReadinessRow;
      out.push({ label, value: String(value), num: typeof num === 'number' ? num : undefined });
    }
  }
  return out;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }

  let events: unknown[];
  try {
    events = [];
    readLines(args.ndjson).forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        events.push(JSON.parse(line));
      } catch {
        throw new Error(`${args.ndjson}: line ${index + 1} is not valid JSON`);
      }
    });
  } catch (error) {
    console.error(`error: cannot read NDJSON: ${errorMessage(error)}`);
    return 2;
  }

  let exitCode = 0;

  let cost: TranscriptCost;
  try {
    const { records, skipped } = parseLenient(readLines(args.transcript));
    if (skipped > 0) console.error(`note: skipped ${skipped} non-JSON transcript lines`);
    cost = computeTranscriptCost(records);
  } catch (error) {
    cost = { status: 'unavailable', reason: `cannot read transcript: ${errorMessage(error)}` };
  }
  if (cost.status === 'unavailable') {
    console.error(`error: cost unavailable: ${cost.reason}`);
    exitCode = 2;
  }

  let serverClock: ServerClockMetrics | undefined;
  if (args.journal !== undefined) {
    try {
      const lines = readLines(args.journal).filter((line) => line.trim() !== '');
      const { records } = parseLenient(lines.filter((line) => line.startsWith('{')));
      const skipped = lines.length - records.length;
      if (skipped > 0) console.error(`note: skipped ${skipped} non-JSON journal lines`);
      serverClock = computeServerClock(records, args.sessionId);
    } catch (error) {
      console.error(`error: cannot read journal: ${errorMessage(error)}`);
      exitCode = 2;
    }
  }

  let baseline: ReadinessRow[] | undefined;
  if (args.baseline !== undefined) {
    try {
      baseline = readBaselineRows(args.baseline);
    } catch (error) {
      console.error(`error: cannot read baseline: ${errorMessage(error)}`);
      return 2;
    }
  }

  const ndjson = computeNdjsonMetrics(events, args.sessionId);
  const rows = formatReadinessRows({ ndjson, cost, serverClock });
  console.log(renderTable(rows, baseline));

  if (args.json !== undefined) {
    try {
      writeFileSync(
        args.json,
        `${JSON.stringify({ sessionId: args.sessionId, ndjson, cost, serverClock, rows }, null, 2)}\n`,
      );
    } catch (error) {
      console.error(`error: cannot write ${args.json}: ${errorMessage(error)}`);
      exitCode = 2;
    }
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
