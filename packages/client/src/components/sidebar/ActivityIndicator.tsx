import type { AgentActivityState } from '@agent-console/shared';

interface ActivityIndicatorProps {
  state: AgentActivityState;
  className?: string;
}

/**
 * Colored dot indicating activity state.
 * - asking: yellow with pulse animation
 * - idle: gray, no animation
 * - active: blue with subtle pulse
 */
export function ActivityIndicator({ state, className = '' }: ActivityIndicatorProps) {
  const baseClasses = 'inline-block w-2 h-2 rounded-full shrink-0';

  const stateClasses: Record<AgentActivityState, string> = {
    asking: 'bg-yellow-400 animate-pulse',
    idle: 'bg-gray-400',
    active: 'bg-blue-400 animate-[pulse_2s_ease-in-out_infinite]',
    unknown: 'bg-gray-600',
  };

  return (
    <span
      className={`${baseClasses} ${stateClasses[state]} ${className}`}
      aria-label={`Activity: ${state}`}
    />
  );
}
