import '@testing-library/react';

// Mock fetch for API tests
global.fetch = vi.fn();

// Reset mocks before each test
beforeEach(() => {
  vi.resetAllMocks();
});
