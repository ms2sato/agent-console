import { describe, it, expect } from 'bun:test';
import { buildMcpInstallCommand, type McpInstallLocation } from '../mcp-install-url';

function makeLocation(protocol: string, hostname: string, port: string): McpInstallLocation {
  // Compose `origin` the same way browsers do so tests reflect real behavior.
  const portSuffix = port === '' ? '' : `:${port}`;
  return {
    protocol,
    hostname,
    port,
    origin: `${protocol}//${hostname}${portSuffix}`,
  };
}

describe('buildMcpInstallCommand', () => {
  it('dev mode: vite on 5173 with backend on 3457 targets the backend directly', () => {
    // Vite dev server does not proxy /mcp; the command must point at the backend port.
    const location = makeLocation('http:', 'localhost', '5173');
    const cmd = buildMcpInstallCommand(3457, location);
    expect(cmd).toBe('claude mcp add --transport http agent-console http://localhost:3457/mcp');
  });

  it('production single-port: browser port matches server port, uses window.location.origin', () => {
    const location = makeLocation('http:', 'host.example.com', '6340');
    const cmd = buildMcpInstallCommand(6340, location);
    expect(cmd).toBe('claude mcp add --transport http agent-console http://host.example.com:6340/mcp');
  });

  it('reverse proxy on https default port: browser port is empty, uses window.location.origin', () => {
    const location = makeLocation('https:', 'console.example.com', '');
    const cmd = buildMcpInstallCommand(3457, location);
    expect(cmd).toBe('claude mcp add --transport http agent-console https://console.example.com/mcp');
  });

  it('reverse proxy on http default port: browser port is empty, uses window.location.origin', () => {
    const location = makeLocation('http:', 'internal-console', '');
    const cmd = buildMcpInstallCommand(3457, location);
    expect(cmd).toBe('claude mcp add --transport http agent-console http://internal-console/mcp');
  });

  it('preserves hostname when falling through to backend port (dev over LAN IP)', () => {
    // Access the dev server via LAN IP; the backend is on the same host at 3457.
    const location = makeLocation('http:', '192.168.1.20', '5173');
    const cmd = buildMcpInstallCommand(3457, location);
    expect(cmd).toBe('claude mcp add --transport http agent-console http://192.168.1.20:3457/mcp');
  });
});
