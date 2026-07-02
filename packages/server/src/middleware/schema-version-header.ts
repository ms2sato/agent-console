/**
 * Schema-version response header middleware.
 *
 * Attaches the build-time wire-schema version to every non-WebSocket HTTP
 * response as `X-Schema-Version`, so a client can detect a server/client
 * schema mismatch from any REST call. Mounted before auth so even 401
 * responses carry the header. WebSocket upgrade routes (`/ws/*`) are skipped
 * because their 101 response headers are immutable.
 */

import { createMiddleware } from 'hono/factory';
import { SCHEMA_VERSION } from '@agent-console/shared';

export const SCHEMA_VERSION_HEADER = 'X-Schema-Version';

export const schemaVersionHeaderMiddleware = createMiddleware(async (c, next) => {
  if (c.req.path.startsWith('/ws/')) {
    return next();
  }
  c.header(SCHEMA_VERSION_HEADER, SCHEMA_VERSION);
  await next();
});
