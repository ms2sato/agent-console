import { useMyOpenTodoCount } from '../../hooks/useMyOpenTodoCount';

/** The number of open to-do items assigned to the current user; renders nothing at zero. */
export function TodoCountBadge() {
  const count = useMyOpenTodoCount();
  if (count === 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium leading-none"
      >
        {count}
      </span>
      <span className="sr-only">{count} open to-do items assigned to you</span>
    </>
  );
}
