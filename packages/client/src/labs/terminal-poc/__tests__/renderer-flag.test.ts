import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  DEFAULT_TERMINAL_RENDERER,
  getTerminalRenderer,
  setTerminalRenderer,
  subscribeTerminalRenderer,
} from '../renderer-flag';

const STORAGE_KEY = 'terminal-renderer';

describe('renderer-flag', () => {
  let originalLocalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    localStorage.clear();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    }
    localStorage.clear();
  });

  it('returns the build-time default when nothing is stored', () => {
    expect(getTerminalRenderer()).toBe(DEFAULT_TERMINAL_RENDERER);
    expect(DEFAULT_TERMINAL_RENDERER).toBe('legacy');
  });

  it('returns the stored value when it is a valid renderer', () => {
    localStorage.setItem(STORAGE_KEY, 'next');
    expect(getTerminalRenderer()).toBe('next');
  });

  it('falls back to the default when the stored value is invalid', () => {
    localStorage.setItem(STORAGE_KEY, 'bogus');
    expect(getTerminalRenderer()).toBe(DEFAULT_TERMINAL_RENDERER);
  });

  it('set persists the value and get reads it back', () => {
    setTerminalRenderer('next');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('next');
    expect(getTerminalRenderer()).toBe('next');

    setTerminalRenderer('legacy');
    expect(getTerminalRenderer()).toBe('legacy');
  });

  it('notifies subscribers on set and stops after unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeTerminalRenderer(() => {
      notifications += 1;
    });

    setTerminalRenderer('next');
    expect(notifications).toBe(1);

    unsubscribe();
    setTerminalRenderer('legacy');
    expect(notifications).toBe(1); // no further notifications after unsubscribe
  });

  it('falls back to the default when localStorage access throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('SecurityError: localStorage blocked');
        },
        setItem() {
          throw new Error('SecurityError: localStorage blocked');
        },
        clear() {},
      },
    });

    // getItem throws -> caught -> default.
    expect(getTerminalRenderer()).toBe(DEFAULT_TERMINAL_RENDERER);

    // setItem throws -> caught -> subscribers still notified (choice applies to
    // this tab session even though it cannot persist).
    let notified = false;
    const unsubscribe = subscribeTerminalRenderer(() => {
      notified = true;
    });
    expect(() => setTerminalRenderer('next')).not.toThrow();
    expect(notified).toBe(true);
    unsubscribe();
  });
});
