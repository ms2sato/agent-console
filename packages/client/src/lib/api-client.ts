import { hc } from 'hono/client';
import type { AppType } from '@agent-console/server/api-type';

// Create typed client - the base URL is '/api' because Vite proxies /api to the server
const client = hc<AppType>('/api');

// For IDE performance optimization (as recommended by Hono docs)
export type Client = typeof client;
export const api = client;
