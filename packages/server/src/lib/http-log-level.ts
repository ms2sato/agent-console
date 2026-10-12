/**
 * Access-log level for a response. The status the response actually carries is
 * the fact, independent of whether a handler recorded an error on the context.
 */
export function resolveHttpResLevel(status: number): 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}
