import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';

describe('route directory hygiene', () => {
  it('should not contain test files directly in route directories (outside __tests__ subdirs)', async () => {
    const glob = new Glob('**/*.test.{ts,tsx}');
    const routesDir = new URL('../routes/', import.meta.url).pathname;
    const testFiles: string[] = [];
    for await (const file of glob.scan(routesDir)) {
      // Allow test files inside __tests__/ subdirectories (colocated pattern).
      // These are already excluded from TanStack Router via routeFileIgnorePattern.
      if (!file.includes('__tests__/')) {
        testFiles.push(file);
      }
    }
    expect(testFiles).toEqual([]);
  });
});
