import { Hono } from 'hono';
import { serverConfig } from '../lib/server-config.js';

const settings = new Hono();

// ===========================================================================
// Notification Settings
// ===========================================================================

// Get notification configuration status
settings.get('/notifications/status', (c) => {
  const baseUrl = serverConfig.APP_URL;
  return c.json({
    baseUrl,
    isBaseUrlConfigured: baseUrl !== '',
  });
});

// Note: Test notification is done via repository-specific endpoint
// POST /api/repositories/:id/integrations/slack/test

export { settings };
