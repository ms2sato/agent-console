/**
 * Pin (Issue #2242): no collection under packages/server/src is keyed by hono's per-event `WSContext`.
 * hono/bun builds a new WSContext for each of open / message / close, so such a collection never matches across
 * callbacks. Key by `socketKey(ws)` (socket-key.ts) and keep the context as the value.
 *
 * `\b` before the collection name excludes `ReadonlySet<WSContext>` (a read-only view of send handles);
 * `ReadonlyMap<WSContext` is listed explicitly so a keyed read-only map is still caught.
 */
import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(import.meta.dir, '../../');
const KEYED_BY_CONTEXT = /\b(Map|Set|WeakMap|WeakSet|ReadonlyMap)<\s*WSContext\b/;

async function findOffenders(root: string): Promise<string[]> {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
    if (file.split('/').includes('__tests__')) continue;
    const text = await Bun.file(path.join(root, file)).text();
    text.split('\n').forEach((line, i) => {
      if (KEYED_BY_CONTEXT.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return offenders;
}

describe('no collection is keyed by WSContext', () => {
  it('finds no Map / Set / WeakMap / WeakSet / ReadonlyMap with WSContext in the key position', async () => {
    expect(await findOffenders(SRC_ROOT)).toEqual([]);
  });

  it('positive control: the pattern finds a scratch line (and skips the read-only Set view)', () => {
    for (const line of ['const a = new Map<WSContext, X>();', 'private s = new Set<WSContext>();', 'WeakMap< WSContext, 1>']) {
      expect(KEYED_BY_CONTEXT.test(line)).toBe(true);
    }
    expect(KEYED_BY_CONTEXT.test('get(): ReadonlySet<WSContext> {')).toBe(false);
    expect(KEYED_BY_CONTEXT.test('new Map<SocketKey, WSContext>()')).toBe(false);
  });
});
