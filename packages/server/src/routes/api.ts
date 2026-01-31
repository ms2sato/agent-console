import { Hono } from 'hono';
import { homedir } from 'node:os';
import { sessions } from './sessions.js';
import { repositories } from './repositories.js';
import { agents } from './agents.js';
import { jobs } from './jobs.js';
import { settings } from './settings.js';
import { system } from './system.js';
import { getSystemCapabilities } from '../services/system-capabilities-service.js';
import type { AppBindings } from '../app-context.js';

const api = new Hono<AppBindings>()
  // API info
  .get('/', (c) => {
    return c.json({ message: 'Agent Console API' });
  })
  // Get server config
  .get('/config', (c) => {
    const systemCapabilities = getSystemCapabilities();
    return c.json({
      homeDir: homedir(),
      capabilities: systemCapabilities.getCapabilities(),
      serverPid: process.pid,
    });
  })
  // Mount domain-specific routers
  .route('/sessions', sessions)
  .route('/repositories', repositories)
  .route('/agents', agents)
  .route('/jobs', jobs)
  .route('/settings', settings)
  .route('/system', system);

export type AppType = typeof api;
export { api };
