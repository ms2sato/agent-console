/**
 * Formats a timestamp as relative time for recent timestamps,
 * or as a locale-formatted date for older timestamps.
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats a timestamp as an absolute locale string.
 */
export function formatAbsoluteTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Formats a byte count as a human-readable string with a scaled unit
 * (B / KB / MB / GB), one decimal place for scaled units.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}
