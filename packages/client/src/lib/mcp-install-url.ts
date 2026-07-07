/**
 * Minimal shape of `window.location` used by {@link buildMcpInstallCommand}.
 * Declared as a subset so the function can be unit-tested with fabricated
 * objects (no need to stub the global `window`).
 */
export interface McpInstallLocation {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}

/**
 * Build the `claude mcp add ...` command that registers this Agent Console
 * server's MCP endpoint with the Claude Code CLI.
 *
 * The URL is composed to remain copy-pastable across all deploy modes:
 *
 * - **Dev** (vite dev server on 5173, backend on 3457): browser origin is
 *   `http://localhost:5173`, but `/mcp` is not proxied by Vite. Fall through
 *   to `${protocol}//${hostname}:${serverPort}` so the command targets the
 *   backend directly.
 * - **Production single-port** (browser and backend both on e.g. 6340): use
 *   `location.origin` as-is.
 * - **Reverse proxy** (e.g. `https://console.example.com`, browser `port === ''`):
 *   use `location.origin` — the MCP client on the same host reaches the
 *   server via the same reverse proxy.
 */
export function buildMcpInstallCommand(
  serverPort: number,
  location: McpInstallLocation = window.location,
): string {
  const { protocol, hostname, port } = location;
  // Same-origin case:
  //   - Browser port is empty (reverse proxy on default 80/443), OR
  //   - Browser port matches server port (production single-port serving).
  const sameOrigin = port === '' || Number(port) === serverPort;
  const base = sameOrigin
    ? location.origin
    : `${protocol}//${hostname}:${serverPort}`;
  return `claude mcp add --transport http agent-console ${base}/mcp`;
}
