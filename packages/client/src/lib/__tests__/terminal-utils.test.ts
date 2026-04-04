import { describe, it, expect } from 'bun:test';
import { isScrolledToBottom, stripScrollbackClear, stripSystemMessages, type TerminalScrollInfo } from '../terminal-utils';

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

  describe('stripSystemMessages', () => {
    it('should strip [internal:timer] lines', () => {
      const input = 'normal output\n[internal:timer] some timer info\nmore output';
      expect(stripSystemMessages(input)).toBe('normal output\nmore output');
    });

    it('should strip [internal:process] lines', () => {
      const input = 'hello\n[internal:process] process started\nworld';
      expect(stripSystemMessages(input)).toBe('hello\nworld');
    });

    it('should strip [internal:message] lines', () => {
      const input = 'before\n[internal:message] incoming message\nafter';
      expect(stripSystemMessages(input)).toBe('before\nafter');
    });

    it('should preserve non-system output', () => {
      const input = 'line 1\nline 2\nline 3';
      expect(stripSystemMessages(input)).toBe('line 1\nline 2\nline 3');
    });

    it('should handle multiple system messages mixed with normal output', () => {
      const input = 'start\n[internal:timer] t1\nmiddle\n[internal:process] p1\n[internal:message] m1\nend';
      expect(stripSystemMessages(input)).toBe('start\nmiddle\nend');
    });

    it('should handle data with no system messages (passthrough)', () => {
      const input = 'just regular terminal output';
      expect(stripSystemMessages(input)).toBe(input);
    });

    it('should not strip [internal:*] at the very beginning without leading newline', () => {
      // The regex requires a leading \n, so a line at position 0 is not stripped
      const input = '[internal:timer] first line\nnormal line';
      expect(stripSystemMessages(input)).toBe('[internal:timer] first line\nnormal line');
    });

    it('should handle empty string', () => {
      expect(stripSystemMessages('')).toBe('');
    });

    it('should strip [internal:reviewed] and [internal:review-comment] lines', () => {
      const input = 'output\n[internal:reviewed] review done\n[internal:review-comment] comment here\nmore';
      expect(stripSystemMessages(input)).toBe('output\nmore');
    });

    it('should strip [internal:*] with ANSI codes before the bracket', () => {
      const input = 'normal\n\x1b[1m\x1b[33m[internal:timer]\x1b[0m timestamp=123 intent=inform\nmore';
      expect(stripSystemMessages(input)).toBe('normal\nmore');
    });

    it('should strip [internal:*] wrapped entirely in ANSI codes', () => {
      const input = 'normal\n\x1b[90m[internal:timer] timestamp=123 intent=inform\x1b[0m\nmore';
      expect(stripSystemMessages(input)).toBe('normal\nmore');
    });

    it('should strip [internal:*] with complex ANSI SGR sequences', () => {
      const input = 'before\n\x1b[1;33m[internal:process]\x1b[0m process started pid=42\nafter';
      expect(stripSystemMessages(input)).toBe('before\nafter');
    });

    it('should strip [Reply Instructions] block (plain text)', () => {
      const input =
        'output\n[Reply Instructions] To reply, use the send_session_message MCP tool with:\n- toSessionId: "abc"\n- fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable\nmore';
      expect(stripSystemMessages(input)).toBe('output\nmore');
    });

    it('should strip [Reply Instructions] block with ANSI codes', () => {
      const input =
        'output\n\x1b[90m[Reply Instructions] To reply, use the send_session_message MCP tool with:\x1b[0m\n\x1b[90m- toSessionId: "abc"\x1b[0m\n\x1b[90m- fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable\x1b[0m\nmore';
      expect(stripSystemMessages(input)).toBe('output\nmore');
    });

    it('should strip combined [internal:*] and [Reply Instructions] block', () => {
      const input =
        'start\n\x1b[33m[internal:message]\x1b[0m incoming from=sess1\n\x1b[90m[Reply Instructions] To reply:\x1b[0m\n\x1b[90m- toSessionId: "sess1"\x1b[0m\n\x1b[90m- fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable\x1b[0m\nend';
      expect(stripSystemMessages(input)).toBe('start\nend');
    });

    it('should not strip [Reply Instructions] at position 0 without leading newline', () => {
      const input = '[Reply Instructions] first line\nnormal line';
      expect(stripSystemMessages(input)).toBe('[Reply Instructions] first line\nnormal line');
    });
  });

  describe('stripScrollbackClear', () => {
    it('should strip CSI 3J from a string', () => {
      const input = 'hello\x1b[3Jworld';
      expect(stripScrollbackClear(input)).toBe('helloworld');
    });

    it('should replace CSI 2J with CSI H + CSI J', () => {
      const input = 'hello\x1b[2Jworld';
      expect(stripScrollbackClear(input)).toBe('hello\x1b[H\x1b[Jworld');
    });

    it('should replace CSI 2J alongside other sequences', () => {
      const input = '\x1b[2J\x1b[H\x1b[0m';
      expect(stripScrollbackClear(input)).toBe('\x1b[H\x1b[J\x1b[H\x1b[0m');
    });

    it('should handle multiple occurrences', () => {
      const input = '\x1b[3Jfoo\x1b[3Jbar\x1b[3J';
      expect(stripScrollbackClear(input)).toBe('foobar');
    });

    it('should return empty string unchanged', () => {
      expect(stripScrollbackClear('')).toBe('');
    });

    it('should return string without the sequence unchanged', () => {
      const input = 'no escape sequences here';
      expect(stripScrollbackClear(input)).toBe(input);
    });

    it('should handle both CSI 2J and CSI 3J in same string', () => {
      const input = '\x1b[2J\x1b[3Jfoo';
      expect(stripScrollbackClear(input)).toBe('\x1b[H\x1b[Jfoo');
    });

    it('should handle multiple CSI 2J occurrences', () => {
      const input = '\x1b[2Jfoo\x1b[2Jbar';
      expect(stripScrollbackClear(input)).toBe('\x1b[H\x1b[Jfoo\x1b[H\x1b[Jbar');
    });
  });
});
