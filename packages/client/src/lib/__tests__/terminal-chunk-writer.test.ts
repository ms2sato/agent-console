import { describe, it, expect, mock } from 'bun:test';
import {
  findSafeSplitPoint,
  writeDataInChunks,
  writeFullHistory,
  DEFAULT_CHUNK_SIZE,
  type ChunkableTerminal,
} from '../terminal-chunk-writer';

/**
 * Helper to create a mock terminal for testing.
 */
function createMockTerminal(): ChunkableTerminal & {
  writtenData: string[];
  writeCallCount: number;
} {
  const writtenData: string[] = [];
  return {
    writtenData,
    writeCallCount: 0,
    write: mock((data: string, callback?: () => void) => {
      writtenData.push(data);
      // Simulate async completion
      if (callback) {
        setTimeout(callback, 0);
      }
    }),
    clear: mock(() => {}),
    scrollToBottom: mock(() => {}),
  };
}

describe('terminal-chunk-writer', () => {
  describe('DEFAULT_CHUNK_SIZE', () => {
    it('should be 100KB', () => {
      expect(DEFAULT_CHUNK_SIZE).toBe(100 * 1024);
    });
  });

  describe('findSafeSplitPoint', () => {
    describe('basic split behavior', () => {
      it('should return targetIndex when no ANSI sequence nearby', () => {
        const data = 'Hello, World! This is plain text.';
        expect(findSafeSplitPoint(data, 10)).toBe(10);
      });

      it('should return data.length when targetIndex exceeds data length', () => {
        const data = 'Short';
        expect(findSafeSplitPoint(data, 100)).toBe(5);
      });

      it('should return data.length when targetIndex equals data length', () => {
        const data = 'Exact';
        expect(findSafeSplitPoint(data, 5)).toBe(5);
      });
    });

    describe('complete ANSI CSI sequences', () => {
      it('should split at targetIndex when complete ANSI sequence ends before it', () => {
        // Cursor up sequence: \x1b[1A followed by text
        const data = '\x1b[1AHello World';
        // Sequence ends at index 4, target at 8 - safe to split at 8
        expect(findSafeSplitPoint(data, 8)).toBe(8);
      });

      it('should split at targetIndex when SGR color sequence is complete', () => {
        // Red color: \x1b[31m
        const data = '\x1b[31mRed Text';
        // Sequence ends at index 5, target at 7
        expect(findSafeSplitPoint(data, 7)).toBe(7);
      });

      it('should split at targetIndex when 24-bit color sequence is complete', () => {
        // RGB color: \x1b[38;2;255;0;0m (length 16)
        const data = '\x1b[38;2;255;0;0mColored text';
        // Sequence ends at index 16, target at 20
        expect(findSafeSplitPoint(data, 20)).toBe(20);
      });
    });

    describe('incomplete ANSI CSI sequences', () => {
      it('should split before incomplete ANSI sequence', () => {
        // Incomplete sequence at end: \x1b[1 (missing command byte)
        const data = 'Text\x1b[1';
        // Target at 6, but sequence starting at 4 is incomplete
        expect(findSafeSplitPoint(data, 6)).toBe(4);
      });

      it('should split before ESC when at exact targetIndex position', () => {
        const data = 'Text\x1b[1A';
        // ESC at index 4, target at 5 (inside sequence)
        expect(findSafeSplitPoint(data, 5)).toBe(8); // Include complete sequence
      });

      it('should split after complete sequence that extends past targetIndex', () => {
        // Sequence starts before targetIndex but completes after
        const data = 'AB\x1b[1ACD';
        // ESC at index 2, sequence ends at 6, target at 4
        expect(findSafeSplitPoint(data, 4)).toBe(6);
      });
    });

    describe('cursor movement sequences', () => {
      it('should handle cursor up sequence: \\x1b[1A', () => {
        const data = 'Line1\x1b[1ALine2';
        // Don't split inside the escape sequence
        expect(findSafeSplitPoint(data, 7)).toBe(9); // After the sequence
      });

      it('should handle cursor down sequence: \\x1b[1B', () => {
        const data = 'Line1\x1b[1BLine2';
        expect(findSafeSplitPoint(data, 7)).toBe(9);
      });

      it('should handle erase line sequence: \\x1b[2K', () => {
        const data = 'Text\x1b[2KMore';
        expect(findSafeSplitPoint(data, 6)).toBe(8);
      });

      it('should handle cursor position sequence: \\x1b[10;20H', () => {
        const data = 'Text\x1b[10;20HMore';
        // 'Text' (0-3) + ESC (4) + '[' (5) + '10;20' (6-10) + 'H' (11) = sequence ends at 12
        expect(findSafeSplitPoint(data, 8)).toBe(12);
      });
    });

    describe('edge cases', () => {
      it('should handle ESC at the very beginning', () => {
        const data = '\x1b[1AText';
        // Sequence complete at index 4, target at 2
        expect(findSafeSplitPoint(data, 2)).toBe(4);
      });

      it('should handle multiple consecutive sequences', () => {
        const data = '\x1b[1A\x1b[2KText';
        // First sequence ends at 4, second ends at 8
        expect(findSafeSplitPoint(data, 6)).toBe(8);
      });

      it('should handle non-CSI escape sequence (ESC followed by single char)', () => {
        // ESC M = Reverse Index (not CSI)
        const data = 'Text\x1bMMore';
        // This is a 2-char escape sequence, target at 6
        expect(findSafeSplitPoint(data, 6)).toBe(6);
      });

      it('should handle empty string', () => {
        expect(findSafeSplitPoint('', 0)).toBe(0);
        expect(findSafeSplitPoint('', 10)).toBe(0);
      });

      it('should respect maxLookback limit (50 chars)', () => {
        // ESC at position 0, many chars between, target at 60
        // The lookback only goes 50 chars, so ESC at 0 won't be found
        const data = '\x1b[1A' + 'X'.repeat(100);
        // Target at 60, lookback starts at 59, goes to 10 - won't find ESC at 0-3
        expect(findSafeSplitPoint(data, 60)).toBe(60);
      });

      it('should find ESC within lookback range', () => {
        // ESC at position 40, target at 45
        const data = 'X'.repeat(40) + '\x1b[1AYYYYY';
        // Target at 45, lookback from 44 to 0 will find ESC at 40
        // Sequence ends at 44
        expect(findSafeSplitPoint(data, 45)).toBe(45);
      });
    });

    describe('parameter variations', () => {
      it('should handle sequence with no parameters: \\x1b[m (reset)', () => {
        const data = 'Text\x1b[mMore';
        expect(findSafeSplitPoint(data, 6)).toBe(7);
      });

      it('should handle sequence with multiple parameters: \\x1b[1;31;40m', () => {
        const data = 'Text\x1b[1;31;40mBold Red';
        // 'Text' (0-3) + ESC (4) + '[' (5) + '1;31;40' (6-12) + 'm' (13) = sequence ends at 14
        expect(findSafeSplitPoint(data, 10)).toBe(14);
      });

      it('should handle sequence with large numbers: \\x1b[999H', () => {
        const data = 'Text\x1b[999H';
        expect(findSafeSplitPoint(data, 8)).toBe(10);
      });
    });
  });

  describe('writeDataInChunks', () => {
    describe('small data handling', () => {
      it('should write small data directly without chunking', async () => {
        const terminal = createMockTerminal();
        const data = 'Hello, World!';

        await writeDataInChunks(terminal, data);

        expect(terminal.writtenData).toHaveLength(1);
        expect(terminal.writtenData[0]).toBe(data);
      });

      it('should write data equal to chunk size in one write', async () => {
        const terminal = createMockTerminal();
        const data = 'X'.repeat(100);

        await writeDataInChunks(terminal, data, 100);

        expect(terminal.writtenData).toHaveLength(1);
        expect(terminal.writtenData[0]).toBe(data);
      });
    });

    describe('large data chunking', () => {
      it('should chunk data larger than chunkSize', async () => {
        const terminal = createMockTerminal();
        const data = 'A'.repeat(250);

        await writeDataInChunks(terminal, data, 100);

        expect(terminal.writtenData.length).toBeGreaterThan(1);
        expect(terminal.writtenData.join('')).toBe(data);
      });

      it('should preserve data integrity across chunks', async () => {
        const terminal = createMockTerminal();
        // Create data with various characters
        const data = 'Hello\nWorld\tTest'.repeat(20);

        await writeDataInChunks(terminal, data, 50);

        expect(terminal.writtenData.join('')).toBe(data);
      });

      it('should not break ANSI sequences at chunk boundaries', async () => {
        const terminal = createMockTerminal();
        // Create data where ANSI sequence falls near chunk boundary
        const prefix = 'X'.repeat(95);
        const ansiSeq = '\x1b[31m'; // 5 chars
        const suffix = 'Red text here';
        const data = prefix + ansiSeq + suffix;

        await writeDataInChunks(terminal, data, 100);

        // Verify the ANSI sequence is not split
        const fullOutput = terminal.writtenData.join('');
        expect(fullOutput).toBe(data);

        // Verify no chunk ends with partial ANSI sequence
        for (const chunk of terminal.writtenData) {
          // A chunk should not end with ESC without completing the sequence
          if (chunk.includes('\x1b')) {
            const lastEscPos = chunk.lastIndexOf('\x1b');
            const afterEsc = chunk.substring(lastEscPos);
            // If it starts an ANSI sequence, it should complete it
            if (afterEsc.startsWith('\x1b[')) {
              // Check that it has a terminating character
              const hasTerminator = /\x1b\[[0-9;]*[A-Za-z]/.test(afterEsc);
              expect(hasTerminator).toBe(true);
            }
          }
        }
      });
    });

    describe('zero-progress safeguard', () => {
      it('should always make progress even with problematic data', async () => {
        const terminal = createMockTerminal();
        // This tests the safeguard for malformed sequences
        const data = 'Normal text here';

        await writeDataInChunks(terminal, data, 5);

        expect(terminal.writtenData.join('')).toBe(data);
        // Should have made progress in multiple chunks
        expect(terminal.writtenData.length).toBeGreaterThan(1);
      });
    });

    describe('custom chunk size', () => {
      it('should respect custom chunk size', async () => {
        const terminal = createMockTerminal();
        const data = 'X'.repeat(100);

        await writeDataInChunks(terminal, data, 25);

        // Should create 4 chunks of 25 chars each
        expect(terminal.writtenData).toHaveLength(4);
        for (const chunk of terminal.writtenData) {
          expect(chunk.length).toBeLessThanOrEqual(25);
        }
      });
    });
  });

  describe('writeFullHistory', () => {
    it('should call terminal.clear() first', async () => {
      const terminal = createMockTerminal();
      const data = 'History content';

      await writeFullHistory(terminal, data);

      expect(terminal.clear).toHaveBeenCalledTimes(1);
    });

    it('should write the data', async () => {
      const terminal = createMockTerminal();
      const data = 'History content';

      await writeFullHistory(terminal, data);

      expect(terminal.writtenData.join('')).toBe(data);
    });

    it('should call terminal.scrollToBottom() after writing', async () => {
      const terminal = createMockTerminal();
      const data = 'History content';

      await writeFullHistory(terminal, data);

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('should handle empty data', async () => {
      const terminal = createMockTerminal();

      await writeFullHistory(terminal, '');

      expect(terminal.clear).toHaveBeenCalledTimes(1);
      expect(terminal.writtenData).toHaveLength(1);
      expect(terminal.writtenData[0]).toBe('');
      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('should handle large data with chunking', async () => {
      const terminal = createMockTerminal();
      const data = 'X'.repeat(DEFAULT_CHUNK_SIZE * 2 + 1000);

      await writeFullHistory(terminal, data);

      expect(terminal.clear).toHaveBeenCalledTimes(1);
      expect(terminal.writtenData.join('')).toBe(data);
      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
    });
  });
});
