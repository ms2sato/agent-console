import type { ConnectionStatus } from '../Terminal';
import type { AgentActivityState } from '@agent-console/shared';

type WorkerType = 'agent' | 'terminal' | 'git-diff' | 'sdk';

function getNonAgentStatusColor(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-green-500';
    case 'connecting':
      return 'bg-yellow-500';
    case 'exited':
      return 'bg-red-500';
    case 'disconnected':
      return 'bg-gray-500';
  }
}

export function getConnectionStatusColor(
  status: ConnectionStatus,
  activityState: AgentActivityState,
  workerType: WorkerType
): string {
  if (workerType !== 'agent' && workerType !== 'sdk') {
    return getNonAgentStatusColor(status);
  }

  // Connected with known activity state shows green (fully operational)
  if (status === 'connected' && activityState !== 'unknown') {
    return 'bg-green-500';
  }

  switch (status) {
    case 'connected':
    case 'connecting':
      return 'bg-yellow-500';
    case 'exited':
      return 'bg-red-500';
    case 'disconnected':
      return 'bg-gray-500';
  }
}

export function getConnectionStatusText(
  status: ConnectionStatus,
  activityState: AgentActivityState,
  exitInfo: { code: number; signal: string | null } | null,
  workerType: WorkerType
): string {
  switch (status) {
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      if (workerType !== 'agent' && workerType !== 'sdk') {
        return 'Connected';
      }
      return activityState === 'unknown' ? 'Starting Claude...' : 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'exited': {
      const code = exitInfo?.code ?? 'unknown';
      const signal = exitInfo?.signal ? `, signal: ${exitInfo.signal}` : '';
      return `Exited (code: ${code}${signal})`;
    }
  }
}
