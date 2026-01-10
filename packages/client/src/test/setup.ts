import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register happy-dom globals (window, document, etc.)
GlobalRegistrator.register();

// Ensure localStorage is available globally (Happy DOM provides it via window)
if (typeof globalThis.localStorage === 'undefined' && typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
}
