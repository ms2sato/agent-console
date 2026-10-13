/**
 * Race `promise` against a timer that rejects on timeout.
 *
 * `onTimeout` is either a message (rejects with `new Error(message)`) or a
 * factory returning the error to reject with, for callers whose timeout error
 * is a typed class that downstream code recognises (e.g. by `instanceof`).
 *
 * The timer is cleared on every settle path (resolve, reject, timeout), so a
 * promise that wins the race never leaves a live timer behind. Callers detect
 * a timeout by comparing `err.message` with the message they passed, or by
 * recognising the error the factory built.
 *
 * The raced promise is not cancelled on timeout; only the caller stops waiting.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: string | (() => Error),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(typeof onTimeout === 'string' ? new Error(onTimeout) : onTimeout());
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
