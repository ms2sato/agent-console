export interface TerminalStateSaverOptions {
  throttleMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface TerminalStateSaver {
  schedule: () => void;
  flush: () => void;
  clear: () => void;
}

export function createTerminalStateSaver<TSnapshot>(
  getSnapshot: () => TSnapshot | null,
  saveSnapshot: (snapshot: TSnapshot) => Promise<void>,
  options: TerminalStateSaverOptions = {}
): TerminalStateSaver {
  const throttleMs = options.throttleMs ?? 1000;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedAt = 0;

  const clear = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clear();
    const snapshot = getSnapshot();
    if (!snapshot) {
      return;
    }
    lastSavedAt = now();
    void saveSnapshot(snapshot);
  };

  const schedule = () => {
    const elapsed = now() - lastSavedAt;
    if (elapsed >= throttleMs) {
      flush();
      return;
    }

    if (timer) {
      return;
    }

    const delayMs = Math.max(throttleMs - elapsed, 0);
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  return { schedule, flush, clear };
}
