import type { VSCodeOpenMode } from '@agent-console/shared';

interface SystemCapabilities {
  vscode: boolean;
  vscodeOpenMode: VSCodeOpenMode;
  vscodeRemoteHost: string | null;
}

let cachedCapabilities: SystemCapabilities | null = null;

export function setCapabilities(capabilities: SystemCapabilities): void {
  cachedCapabilities = capabilities;
}

export function hasVSCode(): boolean {
  return cachedCapabilities?.vscode ?? false;
}

export function getVSCodeOpenMode(): VSCodeOpenMode {
  // Default 'local-spawn' if not yet initialized (defensive; setCapabilities runs before UI).
  return cachedCapabilities?.vscodeOpenMode ?? 'local-spawn';
}

export function getVSCodeRemoteHost(): string | null {
  return cachedCapabilities?.vscodeRemoteHost ?? null;
}
