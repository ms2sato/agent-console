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

export function truncateToBytes(input: string, maxBytes: number): TruncateResult {
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) {
    return { text: input, truncated: false };
  }
  let end = maxBytes;
  // Back off if the boundary lands inside a multibyte sequence.
  while (end > 0 && isContinuationByte(bytes[end])) {
    end--;
  }
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}
