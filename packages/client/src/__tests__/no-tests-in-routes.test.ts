import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import path from 'node:path';

describe('no test files directly in routes/', () => {
  it('should not have test files outside __tests__/ directories', async () => {
    const routesDir = path.resolve(import.meta.dir, '../routes');
    const glob = new Glob('**/*.{test,spec}.{ts,tsx}');

    const testFiles: string[] = [];
    for await (const file of glob.scan(routesDir)) {
      // Allow test files inside __tests__/ directories
      if (!file.includes('__tests__/')) {
        testFiles.push(file);
      }
    }

    if (testFiles.length > 0) {
      throw new Error(
        `Test files found directly in src/routes/ (outside __tests__/ dirs): ${testFiles.join(', ')}. ` +
          'Move them to src/__tests__/routes/ or into a routes/__tests__/ subdirectory.',
      );
    }
  });
});
