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

describe('vite dev proxy for WebSocket upgrades', () => {
  it('keeps the original Host on /ws because the upgrade guard compares the browser Origin host with Host', () => {
    const proxy = config.server?.proxy as Record<string, { changeOrigin?: boolean }> | undefined;
    expect(proxy).toBeDefined();
    expect(proxy!['/ws']).toBeDefined();
    expect(proxy!['/ws'].changeOrigin ?? false).toBe(false);
  });
});
