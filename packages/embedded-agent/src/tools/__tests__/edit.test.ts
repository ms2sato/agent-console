import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { editTool } from '../edit.js';

describe('editTool', () => {
  let locationPath: string;

  beforeEach(async () => {
    locationPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-edit-'));
  });

  afterEach(async () => {
    await fsPromises.rm(locationPath, { recursive: true, force: true });
  });

  it('replaces a single match', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there' },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('1 replacement');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello there');
  });

  it('rejects when old_string has zero matches', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'nonexistent', new_string: 'x' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('not-found');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('rejects an ambiguous multi-match old_string when replace_all is not set', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'foo bar foo baz foo');

    const result = await editTool.execute(
      { file_path: target, old_string: 'foo', new_string: 'qux' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('ambiguous');
    expect(result.result).toContain('3');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('foo bar foo baz foo');
  });

  it('replaces every occurrence when replace_all is true', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'foo bar foo baz foo');

    const result = await editTool.execute(
      { file_path: target, old_string: 'foo', new_string: 'qux', replace_all: true },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('3 replacements');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('qux bar qux baz qux');
  });

  it('replace_all true with exactly one match still succeeds', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there', replace_all: true },
      { locationPath },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toContain('1 replacement');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello there');
  });

  it('rejects a no-op edit where old_string === new_string', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'world' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('no-op');
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('does not match when old_string differs only by whitespace (byte-exact matching)', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello  world'); // two spaces

    const result = await editTool.execute(
      { file_path: target, old_string: 'hello world', new_string: 'hi world' }, // one space
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('not-found');
  });

  it('rejects a path outside locationPath with the verbatim confinement message', async () => {
    const result = await editTool.execute(
      { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBe('Access outside session location is not permitted.');
  });

  it('rejects a path under ctx.attachmentRoots (#1570: edit.ts never forwards attachmentRoots)', async () => {
    const attachmentRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attach-'));
    try {
      const target = path.join(attachmentRoot, 'upload.txt');
      await fsPromises.writeFile(target, 'a');

      const result = await editTool.execute(
        { file_path: target, old_string: 'a', new_string: 'b' },
        { locationPath, attachmentRoots: [attachmentRoot] },
      );

      expect(result.ok).toBe(false);
      expect(result.result).toBe('Access outside session location is not permitted.');
    } finally {
      await fsPromises.rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a missing file_path argument', async () => {
    const result = await editTool.execute({ old_string: 'a', new_string: 'b' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('file_path is required and must be a string');
  });

  it('rejects a missing old_string argument', async () => {
    const result = await editTool.execute({ file_path: 'a.txt', new_string: 'b' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('old_string is required and must be a string');
  });

  it('rejects a missing new_string argument', async () => {
    const result = await editTool.execute({ file_path: 'a.txt', old_string: 'a' }, { locationPath });

    expect(result.ok).toBe(false);
    expect(result.result).toBe('new_string is required and must be a string');
  });

  it('rejects a non-boolean replace_all argument', async () => {
    const result = await editTool.execute(
      { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBe('replace_all must be a boolean');
  });

  it('rejects an empty old_string instead of hanging (regression: countOccurrences infinite loop)', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');

    const result = await editTool.execute(
      { file_path: target, old_string: '', new_string: 'x' },
      { locationPath },
    );

    expect(result).toEqual({ ok: false, result: 'old_string must not be empty' });
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  it('rejects a non-existent file with a distinct failure shape', async () => {
    const result = await editTool.execute(
      { file_path: 'does-not-exist.txt', old_string: 'a', new_string: 'b' },
      { locationPath },
    );

    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/^Failed to read file: /);
  });

  it('formats a "Failed to write file" message when the write-back fails', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');
    // Read succeeds (file itself keeps its own permissions), but the directory
    // loses write permission, so atomicWrite's temp-file creation fails --
    // exercising the write-back catch branch distinct from the read-failure one.
    await fsPromises.chmod(locationPath, 0o555);

    try {
      const result = await editTool.execute(
        { file_path: target, old_string: 'world', new_string: 'there' },
        { locationPath },
      );

      expect(result.ok).toBe(false);
      expect(result.result).toMatch(/^Failed to write file: /);
    } finally {
      await fsPromises.chmod(locationPath, 0o755);
    }
  });

  it('returns {ok:false, result:"aborted"} without editing when the signal is already aborted', async () => {
    const target = path.join(locationPath, 'a.txt');
    await fsPromises.writeFile(target, 'hello world');
    const controller = new AbortController();
    controller.abort();

    const result = await editTool.execute(
      { file_path: target, old_string: 'world', new_string: 'there' },
      { locationPath },
      controller.signal,
    );

    expect(result).toEqual({ ok: false, result: 'aborted' });
    await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('hello world');
  });

  // Memory layer (epic #1636 Phase 2): edit.ts forwards memoryRoot -- and
  // ONLY memoryRoot; the #1570 attachmentRoots rejection above stays true.
  // Reach: mutating edit.ts back to `resolveConfinedPath(filePath,
  // ctx.locationPath)` fails the first pin; mutating it to forward
  // `ctx.attachmentRoots` fails the #1570 pin above -- both measured.
  it('edits a file under ctx.memoryRoot, outside locationPath (memory layer)', async () => {
    const memoryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-memory-'));
    try {
      const target = path.join(memoryRoot, 'MEMORY.md');
      await fsPromises.writeFile(target, '# Memory Index\n- [A](a.md) — a\n');

      const result = await editTool.execute(
        { file_path: target, old_string: '- [A](a.md) — a\n', new_string: '- [A](a.md) — a\n- [B](b.md) — b\n' },
        { locationPath, memoryRoot },
      );

      expect(result.ok).toBe(true);
      await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('# Memory Index\n- [A](a.md) — a\n- [B](b.md) — b\n');
    } finally {
      await fsPromises.rm(memoryRoot, { recursive: true, force: true });
    }
  });

  it('a path under ctx.attachmentRoots stays rejected even when memoryRoot is ALSO set (the two roots are not one list)', async () => {
    const memoryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-memory-'));
    const attachmentRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attach-'));
    try {
      const target = path.join(attachmentRoot, 'upload.txt');
      await fsPromises.writeFile(target, 'a');
      const result = await editTool.execute(
        { file_path: target, old_string: 'a', new_string: 'b' },
        { locationPath, attachmentRoots: [attachmentRoot], memoryRoot },
      );
      expect(result.ok).toBe(false);
      expect(result.result).toBe('Access outside session location is not permitted.');
    } finally {
      await Promise.all([memoryRoot, attachmentRoot].map((d) => fsPromises.rm(d, { recursive: true, force: true })));
    }
  });

  // Memory layer, concurrency mitigation 2 (docs/design/embedded-agent-worker.md
  // "Concurrent writers"): two Edits racing on one MEMORY.md through the
  // real atomicWrite. The index-append convention anchors `old_string` on
  // the file's current tail, so it is a compare-and-swap on the anchor.
  describe('two Edits on one file (memory-index append convention)', () => {
    const INDEX = '# Memory Index\n- [A](a.md) — a\n';
    const TAIL = '- [A](a.md) — a\n';

    it('sequential, anchor MOVED: a second Edit anchored on a tail line the first Edit rewrote is rejected with the verbatim zero-match message, and the file is the first Edit\'s whole result', async () => {
      // The compare-and-swap is on the anchor BYTES: it fires when another
      // writer changed the anchored line (here: the first Edit rewrote the
      // tail line's hook while appending). Reach: mutating `countOccurrences`
      // to report 1 when it finds 0 makes the loser "succeed" -- fails the
      // rejection pin AND the final-content pin -- measured.
      const target = path.join(locationPath, 'MEMORY.md');
      await fsPromises.writeFile(target, INDEX);

      const first = await editTool.execute(
        { file_path: target, old_string: TAIL, new_string: `- [A](a.md) — a (revised)\n- [B](b.md) — b\n` },
        { locationPath },
      );
      expect(first.ok).toBe(true);

      // The second writer re-read BEFORE the first landed (its anchor is the
      // old tail line), and now finds that line gone.
      const second = await editTool.execute(
        { file_path: target, old_string: TAIL, new_string: `${TAIL}- [C](c.md) — c\n` },
        { locationPath },
      );
      expect(second.ok).toBe(false);
      expect(second.result).toBe('not-found: old_string does not match any content in the file');
      await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe('# Memory Index\n- [A](a.md) — a (revised)\n- [B](b.md) — b\n');
    });

    it('sequential, pure APPEND by the other writer: the stale tail anchor still matches (substring, not EOF), so the second line is inserted after it -- both lines survive, none is lost', async () => {
      // Recorded as a measured limit of mitigation 2, not a defect: `Edit`
      // has no end-of-file anchor, so another writer's append never removes
      // an earlier tail from the file. The outcome is a reorder (the late
      // line lands before the earlier writer's), never a lost line -- which
      // is the property the convention actually needs. A lost line needs
      // both writers to have read the SAME content before either renamed
      // (the concurrent case below), or a `Write` rewrite. Reach: mutating
      // `Edit` to replace the LAST occurrence only (EOF-anchored semantics)
      // would still pass this pin; mutating `countOccurrences` to 0 fails
      // it -- measured.
      const target = path.join(locationPath, 'MEMORY.md');
      await fsPromises.writeFile(target, INDEX);

      const first = await editTool.execute(
        { file_path: target, old_string: TAIL, new_string: `${TAIL}- [B](b.md) — b\n` },
        { locationPath },
      );
      expect(first.ok).toBe(true);
      const second = await editTool.execute(
        { file_path: target, old_string: TAIL, new_string: `${TAIL}- [C](c.md) — c\n` },
        { locationPath },
      );
      expect(second.ok).toBe(true);
      await expect(fsPromises.readFile(target, 'utf-8')).resolves.toBe(`${INDEX}- [C](c.md) — c\n- [B](b.md) — b\n`);
    });

    it('concurrent (Promise.all): the file is never torn -- it ends as exactly one writer\'s WHOLE result, and no temp file is left behind', async () => {
      // Both Edits read the same content before either renames, so both
      // may report ok (that is the accepted lost-update class); what the
      // pin guards is that the file is one whole outcome, never a mix. Reach
      // MEASURED HONESTLY: replacing atomicWrite's temp+rename with a direct
      // `Bun.write(resolvedPath, content)` did NOT fail this pin at this
      // file size (a small single write is not observably torn) -- the pin's
      // reach is the whole-file-outcome and temp-cleanup assertions, not
      // atomicity itself, which no deterministic test at this size can
      // measure. Mutating atomicWrite to skip the temp-file cleanup on a
      // forced rename failure is covered by atomic-write.test.ts.
      const target = path.join(locationPath, 'MEMORY.md');
      await fsPromises.writeFile(target, INDEX);

      const [b, c] = await Promise.all([
        editTool.execute({ file_path: target, old_string: TAIL, new_string: `${TAIL}- [B](b.md) — b\n` }, { locationPath }),
        editTool.execute({ file_path: target, old_string: TAIL, new_string: `${TAIL}- [C](c.md) — c\n` }, { locationPath }),
      ]);
      expect(b.ok || c.ok).toBe(true);

      const finalContent = await fsPromises.readFile(target, 'utf-8');
      const wholeOutcomes = [
        `${INDEX}- [B](b.md) — b\n`,
        `${INDEX}- [C](c.md) — c\n`,
        `${INDEX}- [B](b.md) — b\n- [C](c.md) — c\n`,
        `${INDEX}- [C](c.md) — c\n- [B](b.md) — b\n`,
      ];
      expect(wholeOutcomes).toContain(finalContent);
      const leftovers = (await fsPromises.readdir(locationPath)).filter((n) => n.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });
});
