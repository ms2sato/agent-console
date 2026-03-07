import { Hono } from 'hono';
import { sessions } from './sessions.js';
import { workers } from './workers.js';
import { repositories } from './repositories.js';
import { worktrees } from './worktrees.js';
import { agents } from './agents.js';
import { jobs } from './jobs.js';
import { settings } from './settings.js';
import { system } from './system.js';
import { authMiddleware } from '../middleware/auth.js';
import { serverConfig } from '../lib/server-config.js';
import type { AppBindings } from '../app-context.js';

const api = new Hono<AppBindings>()
  // Auth middleware runs on all API routes.
  // In single-user mode, SingleUserMode always returns the server process user.
  .use('*', authMiddleware)
  // API info
  .get('/', (c) => {
    return c.json({ message: 'Agent Console API' });
  })
  // Get server config
  .get('/config', (c) => {
    const { systemCapabilities } = c.get('appContext');
    const authUser = c.get('authUser');
    return c.json({
      homeDir: authUser.homeDir,
      capabilities: systemCapabilities.getCapabilities(),
      serverPid: process.pid,
      authMode: serverConfig.AUTH_MODE,
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
