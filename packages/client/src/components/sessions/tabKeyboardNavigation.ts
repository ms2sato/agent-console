/**
 * Returns the new tab index for a keyboard navigation key, or null if the key
 * is not a navigation key (so callers can decide whether to preventDefault).
 */
export function getNextTabIndex(
  key: string,
  currentIndex: number,
  totalTabs: number,
): number | null {
  if (totalTabs === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (currentIndex + 1) % totalTabs;
    case 'ArrowLeft':
      return (currentIndex - 1 + totalTabs) % totalTabs;
    case 'Home':
      return 0;
    case 'End':
      return totalTabs - 1;
    default:
      return null;
  }
}
