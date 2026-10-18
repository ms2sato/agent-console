import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  FileTreeEntrySchema,
  FileTreeResponseSchema,
  FileContentResponseSchema,
  FileViewerServerMessageSchema,
  type FileViewerServerMessage,
  type FileTreeEntry,
  type FileTreeResponse,
  type FileContentResponse,
} from '../file-viewer';

// Key-set pins. The types are derived from the schemas, so the schema is the
// only place a field is edited; a field added to (or removed from) a schema
// alone is a `tsc` failure (TS2344) naming the difference. `Assert<Equals<...>>`
// is the form that fails under drift (a `declare const x: never` form would
// type-check under it). Adding a `size` to the tree entry is the drift the
// design forbids for v1, and fails `_FileTreeEntryKeys`.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _FileTreeEntryKeys = Assert<Equals<keyof FileTreeEntry, 'name' | 'kind'>>;
export type _FileTreeResponseKeys = Assert<Equals<keyof FileTreeResponse, 'path' | 'entries'>>;
export type _FileContentResponseKeys = Assert<
  Equals<keyof FileContentResponse, 'path' | 'kind' | 'content' | 'size' | 'truncated' | 'language'>
>;

export type _FilesChangedKeys = Assert<
  Equals<keyof Extract<FileViewerServerMessage, { type: 'files-changed' }>, 'type' | 'paths' | 'overflow'>
>;
export type _WatchUnavailableKeys = Assert<
  Equals<keyof Extract<FileViewerServerMessage, { type: 'watch-unavailable' }>, 'type' | 'reason'>
>;

const ok = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;

describe('FileTreeEntrySchema', () => {
  it.each(['dir', 'file', 'symlink'] as const)('accepts kind %s', (kind) => {
    expect(ok(FileTreeEntrySchema, { name: 'a', kind })).toBe(true);
  });

  it('rejects an unknown kind, an empty name and a missing field', () => {
    expect(ok(FileTreeEntrySchema, { name: 'a', kind: 'fifo' })).toBe(false);
    expect(ok(FileTreeEntrySchema, { name: '', kind: 'file' })).toBe(false);
    expect(ok(FileTreeEntrySchema, { name: 'a' })).toBe(false);
  });

  it('rejects an extra key, including a size (v1 carries none)', () => {
    expect(ok(FileTreeEntrySchema, { name: 'a', kind: 'file', size: 3 })).toBe(false);
    expect(ok(FileTreeEntrySchema, { name: 'a', kind: 'symlink', target: 'b' })).toBe(false);
  });
});

describe('FileTreeResponseSchema', () => {
  it('accepts the root listing (empty path) and an empty directory', () => {
    expect(ok(FileTreeResponseSchema, { path: '', entries: [{ name: '.git', kind: 'dir' }] })).toBe(true);
    expect(ok(FileTreeResponseSchema, { path: 'empty', entries: [] })).toBe(true);
  });

  it('rejects an extra key and an entry with an extra key', () => {
    expect(ok(FileTreeResponseSchema, { path: '', entries: [], truncated: false })).toBe(false);
    expect(ok(FileTreeResponseSchema, { path: '', entries: [{ name: 'a', kind: 'file', size: 1 }] })).toBe(false);
  });
});

describe('FileContentResponseSchema', () => {
  const text = { path: 'a.ts', kind: 'text', content: 'x', size: 1, truncated: false, language: 'typescript' };
  const binary = { path: 'a.bin', kind: 'binary', size: 9, truncated: false, language: 'text' };

  it('accepts text (including the empty file) and binary', () => {
    expect(ok(FileContentResponseSchema, text)).toBe(true);
    expect(ok(FileContentResponseSchema, { ...text, content: '', size: 0 })).toBe(true);
    expect(ok(FileContentResponseSchema, { ...text, truncated: true })).toBe(true);
    expect(ok(FileContentResponseSchema, binary)).toBe(true);
  });

  it('rejects text without content', () => {
    const { content: _content, ...withoutContent } = text;
    expect(ok(FileContentResponseSchema, withoutContent)).toBe(false);
  });

  it('rejects binary that carries content, even an empty string (decision: the schema enforces it)', () => {
    expect(ok(FileContentResponseSchema, { ...binary, content: 'x' })).toBe(false);
    expect(ok(FileContentResponseSchema, { ...binary, content: '' })).toBe(false);
  });

  it('rejects binary marked truncated (nothing is cut when there is no content)', () => {
    expect(ok(FileContentResponseSchema, { ...binary, truncated: true })).toBe(false);
  });

  it('rejects a negative or fractional size, an unknown kind and a missing field', () => {
    expect(ok(FileContentResponseSchema, { ...text, size: -1 })).toBe(false);
    expect(ok(FileContentResponseSchema, { ...text, size: 1.5 })).toBe(false);
    expect(ok(FileContentResponseSchema, { ...text, kind: 'too-large' })).toBe(false);
    const { language: _language, ...withoutLanguage } = text;
    expect(ok(FileContentResponseSchema, withoutLanguage)).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(ok(FileContentResponseSchema, { ...text, mtime: 1 })).toBe(false);
    expect(ok(FileContentResponseSchema, { ...binary, mtime: 1 })).toBe(false);
  });
});

describe('FileViewerServerMessageSchema', () => {
  const changed = { type: 'files-changed', paths: ['sub/a.ts'], overflow: false };

  it('accepts files-changed, including an empty paths array (never sent, but a valid shape)', () => {
    expect(ok(FileViewerServerMessageSchema, changed)).toBe(true);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: [] })).toBe(true);
  });

  it('accepts overflow with the full 200 paths', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `d/f${i}.ts`);
    expect(ok(FileViewerServerMessageSchema, { type: 'files-changed', paths, overflow: true })).toBe(true);
  });

  it.each(['permission-denied', 'watch-failed'] as const)('accepts watch-unavailable with reason %s', (reason) => {
    expect(ok(FileViewerServerMessageSchema, { type: 'watch-unavailable', reason })).toBe(true);
  });

  it('rejects an empty path, a backslash or drive-letter path, an absolute path and a `..` segment, in any element', () => {
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['/abs'] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: [''] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['C:\\repo\\file'] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['a\\..\\b'] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['ok.ts', '/abs'] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['../up.ts'] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['a/../b.ts'] })).toBe(false);
  });

  it('accepts a name that merely contains two dots (a segment rule, not a substring rule)', () => {
    expect(ok(FileViewerServerMessageSchema, { ...changed, paths: ['a..b.ts', '..hidden/x'] })).toBe(true);
  });

  it('rejects an unknown reason, a missing field, an extra field on either member and an unknown type', () => {
    expect(ok(FileViewerServerMessageSchema, { type: 'watch-unavailable', reason: 'unknown' })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { type: 'watch-unavailable' })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { type: 'files-changed', paths: [] })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { ...changed, extra: 1 })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { type: 'watch-unavailable', reason: 'watch-failed', extra: 1 })).toBe(false);
    expect(ok(FileViewerServerMessageSchema, { type: 'refresh' })).toBe(false);
  });
});
