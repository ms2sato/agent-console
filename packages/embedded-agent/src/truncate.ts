/**
 * UTF-8-safe byte truncation shared by the AGENTS.md reader (32 KiB) and the
 * tool-result emitter (16 KiB). Truncation never splits a multibyte character:
 * the cut backs off to the nearest UTF-8 code-point boundary.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** A UTF-8 continuation byte matches 10xxxxxx. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Backs `maxBytes` off to the nearest UTF-8 code-point boundary within `bytes`,
 * so a cut never splits a multibyte character. Requires `bytes` to include at
 * least one byte past `maxBytes` (the byte at index `maxBytes` itself) to
 * detect whether the boundary lands mid-sequence; callers reading a bounded
 * slice of a larger source (e.g. a file) should over-read by a few bytes.
 */
export function trimToUtf8Boundary(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length <= maxBytes) {
    return bytes;
  }
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end--;
  }
  return bytes.subarray(0, end);
}

export function truncateToBytes(input: string, maxBytes: number): TruncateResult {
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) {
    return { text: input, truncated: false };
  }
  return { text: decoder.decode(trimToUtf8Boundary(bytes, maxBytes)), truncated: true };
}
