// Minimal structural shapes so the extractor is unit-testable with plain mock
// objects (no need to construct a real DataTransferItemList in happy-dom). A
// browser `DataTransferItemList` / `DataTransferItem` satisfies these
// structurally, so the production call site can pass `clipboardData.items`
// directly.
export interface ImageItemLike {
  readonly type: string;
  getAsFile(): File | null;
}

export interface ImageItemListLike {
  readonly length: number;
  [index: number]: ImageItemLike;
}

/**
 * Extract image `File`s from a clipboard/drag item list, mirroring the
 * production precedence in `Terminal.tsx` (items whose `type` starts with
 * `image/`, via `getAsFile()`, skipping nulls). Index-based iteration is used
 * because `DataTransferItemList` is array-like but not declared iterable in the
 * TS DOM lib.
 */
export function extractImageFiles(items: ImageItemListLike | null | undefined): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
