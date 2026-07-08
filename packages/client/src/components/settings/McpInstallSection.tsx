import { useEffect, useRef, useState } from 'react';
import { getServerPort } from '../../lib/server-info';
import { buildMcpInstallCommand } from '../../lib/mcp-install-url';
import { logger } from '../../lib/logger';

/**
 * Settings-page section that shows the exact `claude mcp add ...` command
 * needed to register this Agent Console server's MCP endpoint with the
 * Claude Code CLI. The port and host are derived at runtime so the command
 * works in dev, production single-port, and reverse-proxied deploys.
 */
export function McpInstallSection() {
  const serverPort = getServerPort();
  const [copied, setCopied] = useState(false);
  // Timer handle for the "Copied!" -> "Copy" label revert. Held in a ref so
  // we can clear a still-pending timer on rapid re-clicks or on unmount,
  // avoiding a "state update on unmounted component" warning.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Defensive: if serverPort was never set (e.g. test setup skipped init),
  // don't render — better than showing a broken command.
  if (serverPort === null) return null;

  const command = buildMcpInstallCommand(serverPort);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy MCP install command:', err);
    }
  };

  return (
    <div className="card mb-6">
      <h2 className="text-lg font-medium mb-2">Install MCP server in Claude Code</h2>
      <p className="text-sm text-gray-500 mb-3">
        Register Agent Console&apos;s MCP tools with the Claude Code CLI on any
        machine that can reach this server. All Claude Code instances (including
        those spawned by Agent Console) will automatically discover the tools.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 px-3 py-2 bg-slate-800 text-slate-200 rounded font-mono text-sm break-all">
          {command}
        </code>
        <button
          onClick={handleCopy}
          className="btn btn-primary text-sm shrink-0"
          aria-label="Copy install command"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
