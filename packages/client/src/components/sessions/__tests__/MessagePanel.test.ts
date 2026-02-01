import { describe, it, expect } from 'bun:test';
import { canSend } from '../MessagePanel';

describe('MessagePanel logic', () => {
  describe('canSend', () => {
    it('should return true when all conditions are met', () => {
      expect(canSend('worker1', 'Hello', false)).toBe(true);
    });

    it('should return false when content is empty', () => {
      expect(canSend('worker1', '', false)).toBe(false);
    });

    it('should return false when content is only whitespace', () => {
      expect(canSend('worker1', '   ', false)).toBe(false);
    });

    it('should return false when targetWorkerId is empty', () => {
      expect(canSend('', 'Hello', false)).toBe(false);
    });

    it('should return false when sending is true', () => {
      expect(canSend('worker1', 'Hello', true)).toBe(false);
    });

    it('should return false when both content is empty and sending is true', () => {
      expect(canSend('worker1', '', true)).toBe(false);
    });

    it('should return false when targetWorkerId is empty and content is valid', () => {
      expect(canSend('', 'Hello', false)).toBe(false);
    });

    it('should return true when content has leading/trailing whitespace but is not empty', () => {
      expect(canSend('worker1', '  Hello  ', false)).toBe(true);
    });

    it('should return false when all conditions fail', () => {
      expect(canSend('', '', true)).toBe(false);
    });
  });
});
