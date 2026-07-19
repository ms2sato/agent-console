import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

const serverPort = process.env.PORT || 3457;

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routeFileIgnorePattern: '.*\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (_proxyReq, req) => {
            console.log('[vite proxy /ws] upgrade dispatched:', req?.url);
          });
          proxy.on('error', (err) => {
            console.error('[vite proxy /ws] error:', err);
          });
          proxy.on('open', () => {
            console.log('[vite proxy /ws] upstream socket open');
          });
          proxy.on('close', () => {
            console.log('[vite proxy /ws] proxy close event');
          });
        },
      },
    },
  },
});
