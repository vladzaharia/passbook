import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment } from 'react';
import { cn } from '../../lib/cn.ts';
import { ADMIN_NAV_GROUPS, isActivePath } from '../../lib/nav.ts';
import { ActiveIndicator } from '../active-indicator.tsx';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Admin" className="relative flex flex-col gap-0.5 p-2">
      <ActiveIndicator />
      {ADMIN_NAV_GROUPS.map((group, g) => (
        <Fragment key={group[0]?.to}>
          {g > 0 ? <div aria-hidden className="mx-3 my-1.5 h-px bg-border" /> : null}
          {group.map((item) => {
            const active = isActivePath(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to as never}
                onClick={onNavigate}
                activeOptions={{ exact: item.to === '/admin' }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm pointer-coarse:min-h-11',
                  'transition-[color,background-color] duration-(--wl-dur-hover)',
                  active
                    ? 'text-fg-strong'
                    : 'text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong',
                )}
              >
                <item.icon aria-hidden className={cn('size-4', active && 'text-accent-fg')} />
                {item.label}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
