import '@testing-library/react';
import { vi, beforeEach } from 'vitest';

// Mock fetch for API tests
global.fetch = vi.fn();

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
});
