/**
 * Interface representing the minimal terminal properties needed for chunked writing.
 * This allows for easy mocking in tests without depending on the full xterm.js Terminal type.
 */
export interface ChunkableTerminal {
  write: (data: string, callback?: () => void) => void;
  clear: () => void;
  scrollToBottom: () => void;
}

/**
 * Default chunk size for chunked terminal writes (100KB).
 * This balances performance with memory usage and prevents buffer overflow.
 * xterm.js has ~50MB buffer limit and 5-35 MB/s throughput, so 100KB chunks
 * provide good performance while staying well within limits.
 */
export const DEFAULT_CHUNK_SIZE = 100 * 1024;

/**
 * Find a safe split point in the data that doesn't break ANSI escape sequences.
 *
 * ANSI CSI (Control Sequence Introducer) sequences have the format:
 * ESC [ <parameters> <command>
 * Where:
 * - ESC is \x1b (27 decimal)
 * - [ is the CSI introducer
 * - <parameters> are optional digits and semicolons (0-9, ;)
 * - <command> is a single letter (A-Z, a-z) that terminates the sequence
 *
 * This function ensures we don't split in the middle of such sequences.
 *
 * @param data - The string data to find a split point in
 * @param targetIndex - The ideal split point (typically chunk size)
 * @returns The actual safe split point that doesn't break ANSI sequences
 */
export function findSafeSplitPoint(data: string, targetIndex: number): number {
  // If target is beyond data length, return data length
  if (targetIndex >= data.length) {
    return data.length;
  }

  // Look backwards from targetIndex to find if we're inside an ANSI escape sequence
  // An ANSI CSI sequence starts with \x1b[ and ends with a letter
  // We need to check if there's an incomplete sequence before targetIndex

  // Search backwards for ESC character, but limit search to reasonable distance
  // (ANSI sequences are typically short, < 20 chars)
  const maxLookback = Math.min(targetIndex, 50);
  let escapeStart = -1;

  for (let i = targetIndex - 1; i >= targetIndex - maxLookback; i--) {
    if (data[i] === '\x1b') {
      escapeStart = i;
      break;
    }
  }

  // No escape sequence found nearby - safe to split at targetIndex
  if (escapeStart === -1) {
    return targetIndex;
  }

  // Check if the escape sequence starting at escapeStart is complete by targetIndex
  // Look for the terminating letter
  let seqEnd = escapeStart + 1;

  // Skip the '[' if present (CSI sequence)
  if (seqEnd < data.length && data[seqEnd] === '[') {
    seqEnd++;

    // Skip parameters (digits, semicolons, and intermediate bytes)
    // Parameters: 0x30-0x3F (0-9, :, ;, <, =, >, ?)
    // Intermediate bytes: 0x20-0x2F (space through /)
    while (seqEnd < data.length) {
      const charCode = data.charCodeAt(seqEnd);
      if ((charCode >= 0x30 && charCode <= 0x3f) ||
          (charCode >= 0x20 && charCode <= 0x2f)) {
        seqEnd++;
      } else {
        break;
      }
    }

    // Check if we found the terminating byte (0x40-0x7E: @-~)
    if (seqEnd < data.length) {
      const termChar = data.charCodeAt(seqEnd);
      if (termChar >= 0x40 && termChar <= 0x7e) {
        // Sequence is complete, include it
        seqEnd++; // Include the terminating character

        // If the complete sequence ends before or at targetIndex, we can split at targetIndex
        if (seqEnd <= targetIndex) {
          return targetIndex;
        }
        // Otherwise, split after the complete sequence
        return seqEnd;
      }
    }

    // Sequence is incomplete - split before it
    return escapeStart;
  }

  // Not a CSI sequence (could be other escape sequence like ESC followed by single char)
  // For safety, if there's another char after ESC, include it; otherwise split before ESC
  if (escapeStart + 1 < data.length && escapeStart + 2 <= targetIndex) {
    return targetIndex;
  }
  return escapeStart;
}

/**
 * Write data to terminal in chunks with backpressure handling.
 *
 * This prevents buffer overflow and UI degradation when writing large amounts
 * of data to xterm.js. Each chunk is written and we wait for xterm.js to signal
 * completion before writing the next chunk.
 *
 * @param terminal - The xterm.js terminal instance
 * @param data - The data to write
 * @param chunkSize - Size of each chunk in bytes (default: 100KB)
 * @returns Promise that resolves when all data is written
 */
export async function writeDataInChunks(
  terminal: ChunkableTerminal,
  data: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<void> {
  // For small data, write directly without chunking
  if (data.length <= chunkSize) {
    return new Promise<void>((resolve) => {
      terminal.write(data, resolve);
    });
  }

  let offset = 0;

  while (offset < data.length) {
    // Calculate the target end of this chunk
    const targetEnd = Math.min(offset + chunkSize, data.length);

    // Find a safe split point that doesn't break ANSI sequences
    let actualEnd = findSafeSplitPoint(data, targetEnd);

    // Safeguard: ensure we always make progress to prevent infinite loops
    // This can happen with malformed ANSI sequences longer than maxLookback
    if (actualEnd <= offset) {
      actualEnd = Math.min(offset + 1, data.length);
    }

    // Extract the chunk
    const chunk = data.substring(offset, actualEnd);

    // Write chunk and wait for completion (backpressure)
    await new Promise<void>((resolve) => {
      terminal.write(chunk, resolve);
    });

    offset = actualEnd;
  }
}

/**
 * Write full history to terminal, clearing existing content first.
 *
 * For large data, this function splits the data into chunks to prevent
 * buffer overflow and UI degradation. It ensures ANSI escape sequences
 * are not broken at chunk boundaries and uses backpressure to avoid
 * overwhelming xterm.js.
 *
 * xterm.js has approximately:
 * - ~50MB buffer limit
 * - 5-35 MB/s processing throughput
 *
 * By default, chunks are 100KB which provides good performance while
 * staying well within these limits.
 */
export async function writeFullHistory(terminal: ChunkableTerminal, data: string): Promise<void> {
  terminal.clear();

  await writeDataInChunks(terminal, data);

  terminal.scrollToBottom();
}
