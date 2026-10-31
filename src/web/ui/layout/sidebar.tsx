import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { ADMIN_NAV, isActivePath } from '../../lib/nav.ts';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Admin" className="flex flex-col gap-0.5 p-2">
      {ADMIN_NAV.map((item) => {
        const active = isActivePath(pathname, item.to);
        return (
          <Link
            key={item.to}
            to={item.to as never}
            onClick={onNavigate}
            activeOptions={{ exact: item.to === '/admin' }}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors',
              active
                ? 'bg-state-selected-fill text-fg-strong'
                : 'text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong',
            )}
          >
            <item.icon aria-hidden className={cn('size-4', active && 'text-accent-fg')} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
