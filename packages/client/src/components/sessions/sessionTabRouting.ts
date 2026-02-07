export type TabLike = {
  id: string;
  workerType: 'agent' | 'terminal' | 'git-diff' | 'sdk';
};

export function isWorkerIdReady(
  urlWorkerId: string | undefined,
  tabs: TabLike[],
  pendingWorkerId: string | null
): boolean {
  if (!urlWorkerId) return false;
  if (tabs.some(tab => tab.id === urlWorkerId)) return true;
  return pendingWorkerId === urlWorkerId;
}

export function getDefaultTabId(tabs: TabLike[]): string | null {
  return tabs.find(tab => tab.workerType === 'agent')?.id ?? tabs[0]?.id ?? null;
}
