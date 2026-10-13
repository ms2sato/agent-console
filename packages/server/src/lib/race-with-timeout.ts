/**
 * Race `promise` against a timer that rejects with `new Error(errorMessage)`.
 *
 * The timer is cleared on every settle path (resolve, reject, timeout), so a
 * promise that wins the race never leaves a live timer behind. Callers detect
 * a timeout by comparing `err.message` with the `errorMessage` they passed.
 *
 * The raced promise is not cancelled on timeout; only the caller stops waiting.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
