import type { ConnectionStatus } from '../../components/Terminal';
import type { PocSnapshot } from './poc-terminal-store';

export interface StatusChangeArgs {
  status: ConnectionStatus;
  exitInfo?: { code: number; signal: string | null };
}

/**
 * Map a store snapshot to the production `onStatusChange(status, exitInfo?)`
 * argument shape. `PocStatus` is the same union as `ConnectionStatus`, so status
 * passes through; the only real transform is normalizing `exitInfo: null`
 * (snapshot representation) to `undefined` (callback contract). Typing the
 * return `status` as `ConnectionStatus` also structurally pins that the two
 * unions stay in sync — a divergence would fail to compile here.
 */
export function toStatusChangeArgs(
  snapshot: Pick<PocSnapshot, 'status' | 'exitInfo'>,
): StatusChangeArgs {
  return { status: snapshot.status, exitInfo: snapshot.exitInfo ?? undefined };
}
