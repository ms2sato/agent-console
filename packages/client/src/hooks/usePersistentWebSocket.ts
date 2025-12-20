import { useEffect, useRef } from 'react';
import type { DependencyList } from 'react';

type UsePersistentWebSocketOptions<K> = {
  key: K;
  connect: (key: K) => void;
  disconnect: (key: K) => void;
  keyEquals?: (a: K, b: K) => boolean;
  deps?: DependencyList;
};

/**
 * Persist WebSocket singletons across unmounts, disconnecting only when the key changes.
 */
export function usePersistentWebSocket<K>({
  key,
  connect,
  disconnect,
  keyEquals = Object.is,
  deps,
}: UsePersistentWebSocketOptions<K>): void {
  const prevRef = useRef<K | null>(null);
  const effectDeps = deps ?? [key];

  useEffect(() => {
    const prev = prevRef.current;
    if (prev && !keyEquals(prev, key)) {
      disconnect(prev);
    }
    prevRef.current = key;
    connect(key);
    // Intentionally no cleanup to keep singleton connections alive across unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, effectDeps);
}
