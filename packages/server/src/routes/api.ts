import { Hono } from 'hono';
import { homedir } from 'node:os';
import { sessions } from './sessions.js';
import { workers } from './workers.js';
import { repositories } from './repositories.js';
import { worktrees } from './worktrees.js';
import { agents } from './agents.js';
import { jobs } from './jobs.js';
import { settings } from './settings.js';
import { system } from './system.js';
import { getSystemCapabilities } from '../services/system-capabilities-service.js';

const api = new Hono()
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
  // Multiple .route() calls with the same base path are merged by Hono
  .route('/sessions', sessions)
  .route('/sessions', workers)
  .route('/repositories', repositories)
  .route('/repositories', worktrees)
  .route('/agents', agents)
  .route('/jobs', jobs)
  .route('/settings', settings)
  .route('/system', system);

export type AppType = typeof api;
export { api };
