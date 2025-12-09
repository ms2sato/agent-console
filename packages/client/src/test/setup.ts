import '@testing-library/react';
import { vi, beforeEach, type Mock } from 'vitest';

// Mock fetch for API tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch: Mock<any> = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
});
