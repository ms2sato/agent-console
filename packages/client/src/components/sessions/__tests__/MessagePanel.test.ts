import { describe, it, expect } from 'bun:test';
import { canSend, validateFiles } from '../MessagePanel';

describe('MessagePanel logic', () => {
  describe('canSend', () => {
    it('should return true when all conditions are met', () => {
      expect(canSend('worker1', 'Hello', false, 0)).toBe(true);
    });

    it('should return false when content is empty', () => {
      expect(canSend('worker1', '', false, 0)).toBe(false);
    });

    it('should return false when content is only whitespace', () => {
      expect(canSend('worker1', '   ', false, 0)).toBe(false);
    });

    it('should return false when targetWorkerId is empty', () => {
      expect(canSend('', 'Hello', false, 0)).toBe(false);
    });

    it('should return false when sending is true', () => {
      expect(canSend('worker1', 'Hello', true, 0)).toBe(false);
    });

    it('should return false when both content is empty and sending is true', () => {
      expect(canSend('worker1', '', true, 0)).toBe(false);
    });

    it('should return false when targetWorkerId is empty and content is valid', () => {
      expect(canSend('', 'Hello', false, 0)).toBe(false);
    });

    it('should return true when content has leading/trailing whitespace but is not empty', () => {
      expect(canSend('worker1', '  Hello  ', false, 0)).toBe(true);
    });

    it('should return false when all conditions fail', () => {
      expect(canSend('', '', true, 0)).toBe(false);
    });

    it('should return true when content is empty but files are attached', () => {
      expect(canSend('worker1', '', false, 1)).toBe(true);
    });

    it('should return false when files are attached but sending is true', () => {
      expect(canSend('worker1', '', true, 2)).toBe(false);
    });
  });

  describe('validateFiles', () => {
    it('should return null when files are within limits', () => {
      expect(validateFiles({ length: 5, totalSize: 1024 })).toBeNull();
    });

    it('should return null when no files', () => {
      expect(validateFiles({ length: 0, totalSize: 0 })).toBeNull();
    });

    it('should return error when file count exceeds maximum', () => {
      const result = validateFiles({ length: 11, totalSize: 100 });
      expect(result).not.toBeNull();
      expect(result![0]).toBe('Too Many Files');
    });

    it('should return error when total size exceeds maximum', () => {
      const result = validateFiles({ length: 1, totalSize: 11 * 1024 * 1024 });
      expect(result).not.toBeNull();
      expect(result![0]).toBe('File Size Limit');
    });

    it('should check file count before size', () => {
      const result = validateFiles({ length: 11, totalSize: 11 * 1024 * 1024 });
      expect(result![0]).toBe('Too Many Files');
    });

    it('should return null at exact limits', () => {
      expect(validateFiles({ length: 10, totalSize: 10 * 1024 * 1024 })).toBeNull();
    });
  });
});
