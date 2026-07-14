import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register happy-dom globals (window, document, etc.). `disableIframePageLoading`
// is required for PreviewPanel.tsx (#1097): happy-dom otherwise attempts to
// actually navigate/fetch any <iframe src> mounted during a test (including
// blob: URLs from mocked URL.createObjectURL), which throws an unhandled
// "cannot be parsed as a URL" error from its background navigation logic --
// harmless to the test's assertions, but noisy and unrelated to what the
// test verifies (iframe attributes, not real navigation).
GlobalRegistrator.register({ settings: { disableIframePageLoading: true } });

// Ensure localStorage is available globally (Happy DOM provides it via window)
if (typeof globalThis.localStorage === 'undefined' && typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
}
