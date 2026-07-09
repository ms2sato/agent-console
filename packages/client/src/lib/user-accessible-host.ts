/**
 * Helpers for deriving the host the user's browser can actually reach the
 * server (and its sibling ports) at, from `window.location`.
 *
 * When AgentConsole is accessed from a remote machine, `localhost` /
 * `127.0.0.1` on the server side is meaningless to the browser — the
 * user-accessible host is `window.location.hostname` instead. These helpers
 * consolidate that derivation so VSCode remote-URL open, MCP install-command
 * composition, and terminal localhost-URL rewriting all agree on it.
 */

/**
 * Minimal subset of `window.location` used by these helpers. Declared as a
 * subset so callers can unit-test with fabricated objects (no need to stub the
 * global `window`), mirroring `McpInstallLocation` in `mcp-install-url.ts`.
 */
export interface UserAccessibleLocation {
  protocol: string; // e.g. 'http:'
  hostname: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Strip one pair of surrounding brackets from an IPv6 literal, if present. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** The hostname the user's browser reached the server at, verbatim. */
export function getUserAccessibleHost(loc: UserAccessibleLocation = window.location): string {
  return loc.hostname;
}

/**
 * True when the browser is NOT on a loopback host — i.e. AgentConsole is being
 * accessed remotely. IPv6 loopback may be reported bracketed or bare, so one
 * pair of surrounding brackets is stripped before comparison.
 */
export function isRemoteAccess(loc: UserAccessibleLocation = window.location): boolean {
  return !LOOPBACK_HOSTS.has(stripBrackets(loc.hostname));
}

/**
 * Bracket-wrap an IPv6 literal when composing a URL authority ourselves (e.g.
 * `::1` -> `[::1]`). `window.location.hostname` reports IPv6 literals without
 * brackets, but URLs require the bracketed form. Already-bracketed and
 * non-IPv6 hostnames pass through unchanged.
 */
export function bracketHostForUrl(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
