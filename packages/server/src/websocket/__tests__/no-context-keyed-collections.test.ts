/**
 * Pin: no collection under packages/server/src is keyed by hono's per-event `WSContext`.
 * hono/bun builds a new WSContext for each of open / message / close, so such a collection never matches across
 * callbacks. Key by `socketKey(ws)` (socket-key.ts) and keep the context as the value.
 *
 * `\b` before the collection name excludes `ReadonlySet<WSContext>` (a read-only view of send handles);
 * `ReadonlyMap<WSContext` is listed explicitly so a keyed read-only map is still caught.
 */
import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(import.meta.dir, '../../');
const KEYED_BY_CONTEXT = /\b(Map|Set|WeakMap|WeakSet|ReadonlyMap)<\s*WSContext\b/g;

/** Matches over the whole text (a type argument may wrap onto the next line); reports the start line of each match. */
function findKeyedByContext(text: string): { line: number; snippet: string }[] {
  const found: { line: number; snippet: string }[] = [];
  for (const match of text.matchAll(KEYED_BY_CONTEXT)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.push({ line, snippet: match[0].replace(/\s+/g, ' ') });
  }
  return found;
}

async function findOffenders(root: string): Promise<string[]> {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
    if (file.split('/').includes('__tests__')) continue;
    const text = await Bun.file(path.join(root, file)).text();
    for (const { line, snippet } of findKeyedByContext(text)) offenders.push(`${file}:${line}: ${snippet}`);
  }
  return offenders;
}

describe('no collection is keyed by WSContext', () => {
  it('finds no Map / Set / WeakMap / WeakSet / ReadonlyMap with WSContext in the key position', async () => {
    expect(await findOffenders(SRC_ROOT)).toEqual([]);
  });

  it('positive control: the pattern finds scratch text (and skips the read-only Set view)', () => {
    for (const text of ['const a = new Map<WSContext, X>();', 'private s = new Set<WSContext>();', 'WeakMap< WSContext, 1>']) {
      expect(findKeyedByContext(text)).toHaveLength(1);
    }
    expect(findKeyedByContext('get(): ReadonlySet<WSContext> {')).toEqual([]);
    expect(findKeyedByContext('new Map<SocketKey, WSContext>()')).toEqual([]);
  });

  it('positive control: a type argument wrapped onto the next line is found, with the start line of the match', () => {
    const text = 'const ok = 1;\nconst m = new Map<\n  WSContext,\n  number\n>();\n';
    expect(findKeyedByContext(text)).toEqual([{ line: 2, snippet: 'Map< WSContext' }]);
  });
});
