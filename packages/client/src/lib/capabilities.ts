interface SystemCapabilities {
  vscode: boolean;
}

let cachedCapabilities: SystemCapabilities | null = null;

export function setCapabilities(capabilities: SystemCapabilities): void {
  cachedCapabilities = capabilities;
}

export function hasVSCode(): boolean {
  return cachedCapabilities?.vscode ?? false;
}
