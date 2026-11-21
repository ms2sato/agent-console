import { beforeEach, afterEach } from 'bun:test';

/**
 * Makes `window.isSecureContext` true for each test in the calling file.
 *
 * happy-dom leaves `isSecureContext` undefined, which `copyToClipboard` reads as
 * a non-secure page and routes to its `execCommand` fallback. Tests that stub
 * `navigator.clipboard.writeText` to observe the modern path call this to match
 * a real `http://localhost` / HTTPS page, and the original descriptor is
 * restored after each test so other files see happy-dom's default.
 */
export function useSecureContext(): void {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { value: true, writable: true, configurable: true });
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(window, 'isSecureContext', original);
    } else {
      Reflect.deleteProperty(window, 'isSecureContext');
    }
  });
}
