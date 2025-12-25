import { describe, expect, it } from 'bun:test';
import { calculateHistoryUpdate } from './terminal-history-utils';

describe('calculateHistoryUpdate', () => {
  describe('initial load', () => {
    it('should return initial type when no previous history', () => {
      const result = calculateHistoryUpdate('', 'hello\nworld\n');

      expect(result.type).toBe('initial');
      expect(result.newData).toBe('hello\nworld\n');
      expect(result.shouldScrollToBottom).toBe(true);
    });

    it('should return initial type for empty new data', () => {
      const result = calculateHistoryUpdate('', '');

      expect(result.type).toBe('initial');
      expect(result.newData).toBe('');
      expect(result.shouldScrollToBottom).toBe(true);
    });
  });

  describe('diff update (tab switch scenario)', () => {
    it('should detect append-only update and return only the diff', () => {
      const lastData = 'hello\nworld\n';
      const newData = 'hello\nworld\nfoo\nbar\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('foo\nbar\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should handle single character append', () => {
      const lastData = 'hello';
      const newData = 'hello!';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('!');
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should handle ANSI escape sequences in append', () => {
      const lastData = '\x1b[32mhello\x1b[0m\n';
      const newData = '\x1b[32mhello\x1b[0m\n\x1b[31mworld\x1b[0m\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('\x1b[31mworld\x1b[0m\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should return empty diff when no new content', () => {
      const lastData = 'hello\nworld\n';
      const newData = 'hello\nworld\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('');
      expect(result.shouldScrollToBottom).toBe(false);
    });
  });

  describe('full rewrite (history changed)', () => {
    it('should detect non-append update and return full data', () => {
      const lastData = 'hello\nworld\n';
      const newData = 'goodbye\ncruel\nworld\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('full');
      expect(result.newData).toBe('goodbye\ncruel\nworld\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should handle history cleared and rewritten', () => {
      const lastData = 'old content\n';
      const newData = 'new content\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('full');
      expect(result.newData).toBe('new content\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should handle history becoming shorter', () => {
      const lastData = 'hello\nworld\nfoo\n';
      const newData = 'hello\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('full');
      expect(result.newData).toBe('hello\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty previous data with empty new data', () => {
      const result = calculateHistoryUpdate('', '');

      expect(result.type).toBe('initial');
      expect(result.newData).toBe('');
      expect(result.shouldScrollToBottom).toBe(true);
    });

    it('should handle very long history data', () => {
      const lastData = 'a'.repeat(10000);
      const newData = 'a'.repeat(10000) + 'b'.repeat(5000);
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('b'.repeat(5000));
      expect(result.shouldScrollToBottom).toBe(false);
    });

    it('should handle unicode characters', () => {
      const lastData = '日本語\n';
      const newData = '日本語\n中文\n';
      const result = calculateHistoryUpdate(lastData, newData);

      expect(result.type).toBe('diff');
      expect(result.newData).toBe('中文\n');
      expect(result.shouldScrollToBottom).toBe(false);
    });
  });
});
