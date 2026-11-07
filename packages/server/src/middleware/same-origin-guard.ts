/**
 * Same-origin guard for state-changing /api requests.
 *
 * Rule (first match wins):
 * 1. `Sec-Fetch-Site` present: accept `same-origin` and `none`, refuse anything else.
 * 2. Otherwise `Origin` present: accept when its host (including the port)
 *    equals the request's `Host` header, refuse otherwise. `X-Forwarded-Host`
 *    is deliberately not trusted; behind a reverse proxy the original `Host`
 *    must be forwarded.
 * 3. Neither header present (non-browser callers): accept.
 *
 * GET, HEAD and OPTIONS pass through untouched. Refusals answer a JSON 403
 * (distinct from the 401 of the auth middleware) and are logged at debug only.
 */

import { createMiddleware } from 'hono/factory';
import { rootLogger } from '../lib/logger.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACCEPTED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

export const CROSS_SITE_REFUSED_ERROR = 'Cross-site request refused';

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

export interface CrossSiteHeaders {
  fetchSite: string | undefined;
  origin: string | undefined;
  host: string | undefined;
}

/**
 * Evaluate the header rule above. Returns the refusal reason, or `null` to
 * accept. Shared by the /api guard and the WebSocket upgrade guard.
 */
export function crossSiteRefusal(headers: CrossSiteHeaders): string | null {
  const { fetchSite, origin, host } = headers;
  if (fetchSite !== undefined) {
    return ACCEPTED_FETCH_SITES.has(fetchSite.toLowerCase()) ? null : 'Sec-Fetch-Site not same-origin';
  }
  if (origin !== undefined) {
    if (host === undefined || originHost(origin) !== host.toLowerCase()) {
      return 'Origin does not match Host';
    }
  }
  return null;
}

export function sameOriginGuard() {
  return createMiddleware(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return next();
    }

    const refusal = crossSiteRefusal({
      fetchSite: c.req.header('Sec-Fetch-Site'),
      origin: c.req.header('Origin'),
      host: c.req.header('Host'),
    });

    if (refusal !== null) {
      rootLogger.debug(
        { service: 'same-origin-guard', method: c.req.method, path: c.req.path, reason: refusal },
        'Cross-site request refused',
      );
      return c.json({ error: CROSS_SITE_REFUSED_ERROR }, 403);
    }

    return next();
  });
}
