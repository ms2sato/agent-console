import '@testing-library/react';
import { vi, beforeEach } from 'vitest';

// Mock fetch for API tests
globalThis.fetch = vi.fn();

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
});
