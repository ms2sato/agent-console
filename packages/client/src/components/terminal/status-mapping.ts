import type { ConnectionStatus } from './terminal-contract';
import type { TerminalSnapshot } from './terminal-store';

export interface StatusChangeArgs {
  status: ConnectionStatus;
  exitInfo?: { code: number; signal: string | null };
}

/**
 * Map a store snapshot to the production `onStatusChange(status, exitInfo?)`
 * argument shape. `TerminalStatus` is the same union as `ConnectionStatus`, so status
 * passes through; the only real transform is normalizing `exitInfo: null`
 * (snapshot representation) to `undefined` (callback contract). Typing the
 * return `status` as `ConnectionStatus` also structurally pins that the two
 * unions stay in sync — a divergence would fail to compile here.
 */
export function toStatusChangeArgs(
  snapshot: Pick<TerminalSnapshot, 'status' | 'exitInfo'>,
): StatusChangeArgs {
  return { status: snapshot.status, exitInfo: snapshot.exitInfo ?? undefined };
}
