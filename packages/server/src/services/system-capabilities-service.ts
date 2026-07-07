import type { VSCodeOpenMode } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';
import { serverConfig, type ServerConfig } from '../lib/server-config.js';

const logger = createLogger('system-capabilities');

/**
 * Subset of server configuration consumed by VS Code capability resolution.
 * Extracted as a Pick so tests can pass a minimal override without going
 * through module-cache resets.
 */
type VSCodeConfig = Pick<ServerConfig, 'VSCODE_OPEN_MODE' | 'VSCODE_REMOTE_HOST' | 'AUTH_MODE'>;

/**
 * Resolve the effective `VSCodeOpenMode`:
 * 1. Explicit `VSCODE_OPEN_MODE` env wins.
 * 2. Otherwise, `AUTH_MODE=multi-user` -> `remote-url-scheme` (server is
 *    typically on a remote host in that deployment).
 * 3. Otherwise, `local-spawn` (single-machine dev / default).
 */
export function resolveVSCodeOpenMode(
  config: Pick<VSCodeConfig, 'VSCODE_OPEN_MODE' | 'AUTH_MODE'>,
): VSCodeOpenMode {
  if (config.VSCODE_OPEN_MODE) {
    return config.VSCODE_OPEN_MODE;
  }
  return config.AUTH_MODE === 'multi-user' ? 'remote-url-scheme' : 'local-spawn';
}

/**
 * System capabilities detected at startup.
 */
export interface SystemCapabilities {
  /**
   * Whether the "Open in VS Code" UI should be surfaced.
   *
   * In `remote-url-scheme` mode this is always `true` (the client's VS Code
   * handles the URL); in `local-spawn` mode it reflects whether a `code`
   * binary was detected on the server host.
   */
  vscode: boolean;
  vscodeOpenMode: VSCodeOpenMode;
  vscodeRemoteHost: string | null;
}

/**
 * Service for detecting system capabilities.
 *
 * Capabilities are detected once at startup and cached for the lifetime
 * of the application. This avoids repeated shell command execution.
 */
export class SystemCapabilitiesService {
  private capabilities: SystemCapabilities | null = null;
  private vscodeCommand: 'code' | 'code-insiders' | null = null;

  constructor(private readonly config: VSCodeConfig = serverConfig) {}

  /**
   * Detect all system capabilities.
   * Should be called once at application startup.
   */
  async detect(): Promise<void> {
    const vscodeResult = await this.detectVSCode();
    const vscodeOpenMode = resolveVSCodeOpenMode(this.config);
    const vscodeRemoteHost = this.config.VSCODE_REMOTE_HOST ?? null;
    const localVscodeAvailable = vscodeResult !== null;

    this.vscodeCommand = vscodeResult;
    this.capabilities = {
      // In remote-url-scheme mode the client's VS Code handles the URL, so the
      // server's binary presence is irrelevant to whether the UI should show.
      vscode: vscodeOpenMode === 'remote-url-scheme' ? true : localVscodeAvailable,
      vscodeOpenMode,
      vscodeRemoteHost,
    };

    logger.info(
      {
        vscode: this.capabilities.vscode,
        vscodeCommand: vscodeResult,
        vscodeOpenMode,
        vscodeRemoteHost,
      },
      'System capabilities detected'
    );
  }

  /**
   * Get all detected capabilities.
   * @throws Error if detect() has not been called
   */
  getCapabilities(): SystemCapabilities {
    if (!this.capabilities) {
      throw new Error('SystemCapabilitiesService not initialized. Call detect() first.');
    }
    return this.capabilities;
  }

  /**
   * Check if VS Code is available.
   */
  hasVSCode(): boolean {
    return this.capabilities?.vscode ?? false;
  }

  /**
   * Get the VS Code command to use ('code' or 'code-insiders').
   * Returns null if VS Code is not available.
   */
  getVSCodeCommand(): 'code' | 'code-insiders' | null {
    return this.vscodeCommand;
  }

  /**
   * Get the resolved VS Code "Open" mode.
   * @throws Error if detect() has not been called
   */
  getVSCodeOpenMode(): VSCodeOpenMode {
    if (!this.capabilities) {
      throw new Error('SystemCapabilitiesService not initialized. Call detect() first.');
    }
    return this.capabilities.vscodeOpenMode;
  }

  /**
   * Get the remote host embedded in `vscode://vscode-remote/...` URLs. `null`
   * means the client falls back to `window.location.hostname`.
   * @throws Error if detect() has not been called
   */
  getVSCodeRemoteHost(): string | null {
    if (!this.capabilities) {
      throw new Error('SystemCapabilitiesService not initialized. Call detect() first.');
    }
    return this.capabilities.vscodeRemoteHost;
  }

  /**
   * Detect VS Code availability.
   * Checks for 'code' first, then falls back to 'code-insiders'.
   */
  private async detectVSCode(): Promise<'code' | 'code-insiders' | null> {
    // Try 'code' first
    if (await this.isCommandAvailable('code')) {
      return 'code';
    }

    // Try 'code-insiders' as fallback
    if (await this.isCommandAvailable('code-insiders')) {
      return 'code-insiders';
    }

    return null;
  }

  /**
   * Check if a command is available in PATH using 'which'.
   */
  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(['which', command], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}
