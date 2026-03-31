import { Link } from '@tanstack/react-router';

interface BreadcrumbItem {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

interface PageBreadcrumbProps {
  items: BreadcrumbItem[];
}

export function PageBreadcrumb({ items }: PageBreadcrumbProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={index} className="contents">
            {index > 0 && <span>/</span>}
            {isLast ? (
              <span className="text-white">{item.label}</span>
            ) : (
              <Link to={item.to as string} params={item.params} className="hover:text-white">
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </div>
  );
}
