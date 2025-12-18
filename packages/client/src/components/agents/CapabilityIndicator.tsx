export interface CapabilityIndicatorProps {
  enabled: boolean;
  label: string;
}

export function CapabilityIndicator({ enabled, label }: CapabilityIndicatorProps) {
  return (
    <span className={enabled ? 'text-green-400' : 'text-gray-600'}>
      {enabled ? '✓' : '✗'} {label}
    </span>
  );
}
