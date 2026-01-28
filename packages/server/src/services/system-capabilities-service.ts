import { createLogger } from '../lib/logger.js';

const logger = createLogger('system-capabilities');

/**
 * System capabilities detected at startup.
 */
export interface SystemCapabilities {
  /** Whether VS Code (or Insiders) is available */
  vscode: boolean;
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

  /**
   * Detect all system capabilities.
   * Should be called once at application startup.
   */
  async detect(): Promise<void> {
    const vscodeResult = await this.detectVSCode();

    this.vscodeCommand = vscodeResult;
    this.capabilities = {
      vscode: vscodeResult !== null,
    };

    logger.info(
      { vscode: this.capabilities.vscode, vscodeCommand: vscodeResult },
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

// Singleton pattern for backward compatibility with existing code
let systemCapabilitiesInstance: SystemCapabilitiesService | null = null;

/**
 * Get the SystemCapabilitiesService singleton.
 * @throws Error if not initialized
 */
export function getSystemCapabilities(): SystemCapabilitiesService {
  if (!systemCapabilitiesInstance) {
    throw new Error('SystemCapabilitiesService not initialized');
  }
  return systemCapabilitiesInstance;
}

/**
 * Set the SystemCapabilitiesService singleton.
 * Used by AppContext to set the singleton.
 * @internal For AppContext initialization only.
 */
export function setSystemCapabilities(instance: SystemCapabilitiesService): void {
  if (systemCapabilitiesInstance) {
    throw new Error('SystemCapabilitiesService already initialized');
  }
  systemCapabilitiesInstance = instance;
}

/**
 * Reset the singleton for testing.
 * @internal For testing only.
 */
export function resetSystemCapabilities(): void {
  systemCapabilitiesInstance = null;
}
