import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import path from 'node:path';

describe('no test files directly in routes/', () => {
  it('should not have test files outside __tests__/ directories', async () => {
    const routesDir = path.resolve(import.meta.dir, '../routes');
    const glob = new Glob('**/*.{test,spec}.{ts,tsx}');

    const testFiles: string[] = [];
    for await (const file of glob.scan(routesDir)) {
      const isInTestsDir = file.includes('__tests__/');
      const isSpecFile = file.endsWith('.spec.ts') || file.endsWith('.spec.tsx');

      // Flag .spec files anywhere (project uses .test naming) and .test files outside __tests__/
      if (!isInTestsDir || isSpecFile) {
        testFiles.push(file);
      }
    }

    if (testFiles.length > 0) {
      throw new Error(
        `Invalid route test files found: ${testFiles.join(', ')}. ` +
          'Use *.test.ts(x) under src/__tests__/routes/ or a routes/__tests__/ subdirectory.',
      );
    }
  });
});
