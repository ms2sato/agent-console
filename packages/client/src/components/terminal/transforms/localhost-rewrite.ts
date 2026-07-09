import type { LinkRange } from '../link-detection';
import type { LinkTransform } from '../row-transforms';
import { isRemoteAccess, bracketHostForUrl, type UserAccessibleLocation } from '../../../lib/user-accessible-host';

/**
 * Rewrite terminal URL links that point at the server's own loopback address so
 * a remote browser can click them.
 *
 * When AgentConsole is accessed from a remote host, a URL printed as
 * `http://localhost:3000/...` is unreachable from the user's machine. This
 * transform rewrites only the href to `<browser scheme>//<browser host>:<source
 * port><path/query/hash>` — the display text is untouched, and a `title`
 * reveals the substitution on hover. Only the primary URL's authority is
 * considered; URLs embedded inside a query string are naturally left alone
 * because they are not the parsed URL's host.
 */

const REWRITE_SOURCE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export interface LocalhostRewrite {
  href: string;
  title: string;
}

/**
 * Return the rewritten href + hover title for a loopback-hosted URL when the
 * browser is on a remote host, or null when no rewrite applies (non-loopback
 * host, browser also on loopback, or an unparseable URL).
 */
export function rewriteLocalhostHref(
  href: string,
  loc: UserAccessibleLocation = window.location,
): LocalhostRewrite | null {
  let url: URL;
  try {
    // link-detection's regex is permissive, so the href may not be a valid URL.
    url = new URL(href);
  } catch {
    return null;
  }
  // Exact hostname match: `localhost.evil.com` / `example.com` are untouched.
  if (!REWRITE_SOURCE_HOSTS.has(url.hostname)) return null;
  // Browser itself is on loopback -> the original URL already works locally.
  if (!isRemoteAccess(loc)) return null;

  // Browser scheme (avoids mixed-content blocking under HTTPS), browser host
  // (bracket-wrapped for IPv6), source port + path/query/hash preserved.
  const port = url.port ? `:${url.port}` : '';
  const rewritten = `${loc.protocol}//${bracketHostForUrl(loc.hostname)}${port}${url.pathname}${url.search}${url.hash}`;
  return { href: rewritten, title: `original: ${href} -> rewritten to: ${rewritten}` };
}

/**
 * Build a link transform that rewrites loopback hrefs against `loc`. When `loc`
 * is omitted, each call resolves `window.location` lazily via
 * {@link rewriteLocalhostHref}'s default argument, so no `window` access happens
 * at module load time.
 */
export function createLocalhostRewriteTransform(loc?: UserAccessibleLocation): LinkTransform {
  return (links: LinkRange[]) =>
    links.map((link) => {
      const rewrite = rewriteLocalhostHref(link.href, loc);
      return rewrite ? { ...link, href: rewrite.href, title: rewrite.title } : link;
    });
}

export const localhostRewriteTransform: LinkTransform = createLocalhostRewriteTransform();
