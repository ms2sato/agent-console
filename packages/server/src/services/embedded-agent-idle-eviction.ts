export interface IdleEvictionTimersOptions {
  /**
   * Milliseconds of continuous idleness after which `onExpire` fires for a
   * worker. A non-positive value disables the mechanism entirely: `touch`
   * becomes a no-op and no timer is ever armed.
   */
  idleTimeoutMs: number;
  /**
   * Called when a worker's countdown elapses. The receiver owns the
   * commit-point decision (re-checking whether the worker may actually be
   * dropped right now) and either evicts or calls `touch` again to re-arm.
   * This class draws no conclusion from the callback's outcome.
   */
  onExpire: (workerId: string) => void;
}

/**
 * Per-worker idle countdown used by the restore/eviction track.
 *
 * This is deliberately separate from `EmbeddedAgentWorkerService`: the timing
 * policy ("how long is idle too long, and when does the countdown restart") is
 * pure and can be exercised in isolation with short real timeouts, while the
 * service keeps the parts that need worker state — deciding which workers are
 * *eligible* for idle eviction, and making the commit-point decision when a
 * countdown elapses. Keeping them apart means neither has to be mocked to test
 * the other.
 *
 * The class knows nothing about workers, subprocesses, or engines. It counts
 * down and calls back.
 */
export class IdleEvictionTimers {
  private readonly idleTimeoutMs: number;
  private readonly onExpire: (workerId: string) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: IdleEvictionTimersOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onExpire = options.onExpire;
  }

  /** Whether the idle-eviction mechanism is active at all. */
  get enabled(): boolean {
    return this.idleTimeoutMs > 0;
  }

  /**
   * (Re)start this worker's countdown, cancelling any countdown already in
   * flight for it. No-op when disabled.
   */
  touch(workerId: string): void {
    if (!this.enabled) return;

    this.clear(workerId);

    const timer = setTimeout(() => {
      // Drop the entry BEFORE calling back: `onExpire` is allowed to call
      // `touch(workerId)` to re-arm at the commit point, and that new timer
      // must not be clobbered by this expiring one's own cleanup.
      this.timers.delete(workerId);
      this.onExpire(workerId);
    }, this.idleTimeoutMs);

    // A pending eviction countdown must never keep the process alive. The
    // handle's type differs across runtimes, so `unref` is called defensively.
    timer.unref?.();

    this.timers.set(workerId, timer);
  }

  /** Stop tracking this worker. Idempotent, and safe for an unknown id. */
  clear(workerId: string): void {
    const timer = this.timers.get(workerId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(workerId);
  }

  /** Stop tracking every worker (server shutdown). */
  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Whether a countdown is currently in flight for this worker. */
  isArmed(workerId: string): boolean {
    return this.timers.has(workerId);
  }
}
