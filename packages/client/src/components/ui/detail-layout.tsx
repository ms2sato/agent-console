interface SectionHeaderProps {
  title: string;
}

export function SectionHeader({ title }: SectionHeaderProps) {
  return (
    <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3 pb-1 border-b border-slate-700">
      {title}
    </h3>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}

export function DetailRow({ label, value, mono, muted }: DetailRowProps) {
  const valueClassName = [
    mono ? 'font-mono text-sm' : '',
    muted ? 'text-gray-600' : 'text-gray-200',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex">
      <span className="w-32 text-gray-400 shrink-0">{label}:</span>
      <span className={valueClassName}>{value}</span>
    </div>
  );
}
