import { describe, it, expect } from 'bun:test';
import { isScrolledToBottom, type TerminalScrollInfo } from '../terminal-utils';

/**
 * Helper to create a mock terminal with scroll info.
 */
function createMockTerminal(viewportY: number, rows: number, bufferLength: number): TerminalScrollInfo {
  return {
    buffer: {
      active: {
        viewportY,
        length: bufferLength,
      },
    },
    rows,
  };
}

describe('terminal-utils', () => {
  describe('isScrolledToBottom', () => {
    describe('basic scroll position detection', () => {
      it('should return true when at bottom (viewportY + rows === buffer.length)', () => {
        // Terminal with 24 rows, buffer has 100 lines, viewport starts at line 76
        // viewportY(76) + rows(24) = 100 === buffer.length(100)
        const terminal = createMockTerminal(76, 24, 100);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should return true when past bottom (viewportY + rows > buffer.length)', () => {
        // This can happen briefly during terminal operations
        // viewportY(80) + rows(24) = 104 > buffer.length(100)
        const terminal = createMockTerminal(80, 24, 100);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should return false when scrolled up (viewportY + rows < buffer.length)', () => {
        // User scrolled up to see history
        // viewportY(50) + rows(24) = 74 < buffer.length(100)
        const terminal = createMockTerminal(50, 24, 100);
        expect(isScrolledToBottom(terminal)).toBe(false);
      });

      it('should return false when at the very top', () => {
        // User scrolled all the way up
        // viewportY(0) + rows(24) = 24 < buffer.length(100)
        const terminal = createMockTerminal(0, 24, 100);
        expect(isScrolledToBottom(terminal)).toBe(false);
      });
    });

    describe('boundary cases', () => {
      it('should return true for single screen (buffer fits in viewport)', () => {
        // When buffer content fits in one screen, user is always at bottom
        // viewportY(0) + rows(24) = 24 >= buffer.length(10)
        const terminal = createMockTerminal(0, 24, 10);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should return true for exact single screen (buffer equals viewport)', () => {
        // Buffer exactly fills viewport
        // viewportY(0) + rows(24) = 24 >= buffer.length(24)
        const terminal = createMockTerminal(0, 24, 24);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should return true for empty buffer', () => {
        // No content yet
        // viewportY(0) + rows(24) = 24 >= buffer.length(0)
        const terminal = createMockTerminal(0, 24, 0);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should return false when just one line above bottom', () => {
        // User scrolled up by just one line
        // viewportY(75) + rows(24) = 99 < buffer.length(100)
        const terminal = createMockTerminal(75, 24, 100);
        expect(isScrolledToBottom(terminal)).toBe(false);
      });

      it('should handle small terminal (few rows)', () => {
        // Small terminal with only 5 rows
        // viewportY(5) + rows(5) = 10 >= buffer.length(10)
        const terminal = createMockTerminal(5, 5, 10);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });

      it('should handle large buffer with large viewport', () => {
        // Large terminal with many lines
        // viewportY(9950) + rows(50) = 10000 >= buffer.length(10000)
        const terminal = createMockTerminal(9950, 50, 10000);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });
    });

    describe('edge cases with unusual values', () => {
      it('should handle viewportY of 0 with buffer larger than viewport', () => {
        // Just started scrolling up from bottom, now at very top
        const terminal = createMockTerminal(0, 24, 50);
        expect(isScrolledToBottom(terminal)).toBe(false);
      });

      it('should handle minimum viewport size (1 row)', () => {
        // Extremely small terminal
        const terminal = createMockTerminal(99, 1, 100);
        expect(isScrolledToBottom(terminal)).toBe(true);
      });
    });
  });
});
