import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';

describe('route directory hygiene', () => {
  it('should not contain test files under src/routes/', async () => {
    const glob = new Glob('**/*.test.{ts,tsx}');
    const routesDir = new URL('../routes/', import.meta.url).pathname;
    const testFiles: string[] = [];
    for await (const file of glob.scan(routesDir)) {
      testFiles.push(file);
    }
    expect(testFiles).toEqual([]);
  });
});
