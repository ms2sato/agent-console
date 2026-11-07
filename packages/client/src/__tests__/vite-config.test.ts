import { describe, it, expect } from 'bun:test';
import config from '../../vite.config';

describe('vite dev proxy', () => {
  it('keeps the original Host on /api so the server same-origin guard can compare it with Origin', () => {
    const proxy = config.server?.proxy as Record<string, { changeOrigin?: boolean }> | undefined;
    expect(proxy).toBeDefined();
    expect(proxy!['/api']).toBeDefined();
    expect(proxy!['/api'].changeOrigin).toBe(false);
  });
});
