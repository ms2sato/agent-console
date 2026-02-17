import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { generateTaskId } from '../id';

describe('generateTaskId', () => {
  it('should return a string', () => {
    const id = generateTaskId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should return a UUID when crypto.randomUUID is available', () => {
    const id = generateTaskId();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(uuidPattern);
  });

  describe('non-secure context fallback', () => {
    let originalCrypto: Crypto;

    beforeEach(() => {
      originalCrypto = globalThis.crypto;
      // Simulate non-secure context: crypto exists but without randomUUID
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    });

    it('should return a fallback ID when crypto.randomUUID is not available', () => {
      const id = generateTaskId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should return a fallback ID matching timestamp-hex format', () => {
      const id = generateTaskId();
      // Format: {timestamp}-{hex}
      const fallbackPattern = /^\d+-[0-9a-f]+$/;
      expect(id).toMatch(fallbackPattern);
    });

    it('should generate unique fallback IDs', () => {
      const id1 = generateTaskId();
      const id2 = generateTaskId();
      expect(id1).not.toBe(id2);
    });
  });
});
