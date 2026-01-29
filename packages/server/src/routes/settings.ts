import { Hono } from 'hono';
import { serverConfig } from '../lib/server-config.js';

// ===========================================================================
// Notification Settings
// ===========================================================================

const settings = new Hono()
  // Get notification configuration status
  .get('/notifications/status', (c) => {
    const baseUrl = serverConfig.APP_URL;
    return c.json({
      baseUrl,
      isBaseUrlConfigured: baseUrl !== '',
    });
  });

// Note: Test notification is done via repository-specific endpoint
// POST /api/repositories/:id/integrations/slack/test

export { settings };
