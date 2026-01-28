import { Hono } from 'hono';
import { homedir } from 'node:os';
import { sessions } from './sessions.js';
import { repositories } from './repositories.js';
import { agents } from './agents.js';
import { jobs } from './jobs.js';
import { settings } from './settings.js';
import { system } from './system.js';
import { getSystemCapabilities } from '../services/system-capabilities-service.js';

const api = new Hono();

// API info
api.get('/', (c) => {
  return c.json({ message: 'Agent Console API' });
});

// Get server config
api.get('/config', (c) => {
  const systemCapabilities = getSystemCapabilities();
  return c.json({
    homeDir: homedir(),
    capabilities: systemCapabilities.getCapabilities(),
    serverPid: process.pid,
  });
});

// Mount domain-specific routers
api.route('/sessions', sessions);
api.route('/repositories', repositories);
api.route('/agents', agents);
api.route('/jobs', jobs);
api.route('/settings', settings);
api.route('/system', system);

export { api };
