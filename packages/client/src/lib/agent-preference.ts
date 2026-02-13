const STORAGE_KEY = 'agent-console:last-selected-agent';

export function getLastSelectedAgentId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveLastSelectedAgentId(agentId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, agentId);
  } catch {
    // Ignore localStorage errors
  }
}
