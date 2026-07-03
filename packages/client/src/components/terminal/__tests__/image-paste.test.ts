import { describe, expect, it } from 'bun:test';
import { extractImageFiles } from '../image-paste';
import type { ImageItemLike } from '../image-paste';

function item(type: string, file: File | null): ImageItemLike {
  return { type, getAsFile: () => file };
}

function list(items: ImageItemLike[]) {
  // Array-like shape mirroring DataTransferItemList (length + index access).
  return Object.assign([...items], { length: items.length });
}

const png = new File(['x'], 'a.png', { type: 'image/png' });
const jpg = new File(['y'], 'b.jpg', { type: 'image/jpeg' });
// A non-image item that DOES yield a file — guards that the filter keys on the
// item TYPE, not merely on getAsFile() returning non-null.
const textFile = new File(['t'], 'note.txt', { type: 'text/plain' });

describe('extractImageFiles', () => {
  it('returns [] for null/undefined', () => {
    expect(extractImageFiles(null)).toEqual([]);
    expect(extractImageFiles(undefined)).toEqual([]);
  });

  it('returns [] for an empty list', () => {
    expect(extractImageFiles(list([]))).toEqual([]);
  });

  it('returns [] when only non-image items are present', () => {
    const items = list([item('text/plain', null), item('text/html', null)]);
    expect(extractImageFiles(items)).toEqual([]);
  });

  it('excludes non-image items even when they yield a file', () => {
    const items = list([item('text/plain', textFile), item('image/png', png)]);
    expect(extractImageFiles(items)).toEqual([png]);
  });

  it('extracts a single image file', () => {
    expect(extractImageFiles(list([item('image/png', png)]))).toEqual([png]);
  });

  it('extracts only the image items from a mixed list, preserving order', () => {
    const items = list([
      item('text/plain', null),
      item('image/png', png),
      item('text/html', null),
      item('image/jpeg', jpg),
    ]);
    expect(extractImageFiles(items)).toEqual([png, jpg]);
  });

  it('skips image items whose getAsFile() returns null', () => {
    const items = list([item('image/png', null), item('image/jpeg', jpg)]);
    expect(extractImageFiles(items)).toEqual([jpg]);
  });

  it('matches any image/* subtype prefix', () => {
    const gif = new File(['z'], 'c.gif', { type: 'image/gif' });
    expect(extractImageFiles(list([item('image/gif', gif)]))).toEqual([gif]);
  });
});
