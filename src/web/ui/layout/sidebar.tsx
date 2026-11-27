import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment, lazy, Suspense } from 'react';
import { useIdpConnected } from '../../admin/idp/status-queries.ts';
import { cn } from '../../lib/cn.ts';
import { adminNavGroups, isActivePath } from '../../lib/nav.ts';
import { useAdminScope, useOrgScope } from '../../lib/org-filter.tsx';
import { readTabScope, useRememberedScope } from '../../lib/scope-store.ts';
import { useSession } from '../../lib/session.ts';
import { useTemplateReviews } from '../../lib/template-reviews.ts';
import { ActiveIndicator } from '../active-indicator.tsx';

const BrandCount = lazy(() =>
  import('../../admin/brand/sidebar-count.tsx').then((m) => ({ default: m.BrandCount })),
);

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isAdmin } = useSession();
  const scope = useOrgScope();
  const ready = !scope.isLoading && !scope.isError;
  // Account and the chooser sit outside a scope: they show the one this tab last had open.
  const remembered = useRememberedScope();
  const shown = useAdminScope() ?? readTabScope() ?? remembered;
  const membership = ready
    ? scope.memberships.find((m) => shown?.kind === 'org' && m.orgId === shown.orgId)
    : undefined;
  const polaris = useIdpConnected();
  const groups = adminNavGroups(
    shown,
    isAdmin,
    membership,
    { polaris },
    ready ? scope.memberships : [],
  );
  const reviews = useTemplateReviews(
    shown?.kind === 'org' ? shown.orgId : undefined,
    Boolean(membership?.capabilities.includes('templates:review')),
  );
  const pending = reviews.data?.items.length ?? 0;
  return (
    <nav aria-label="Admin" className="relative flex flex-col gap-0.5 p-2">
      <ActiveIndicator />
      {groups.map((group, g) => (
        <Fragment key={group[0]?.section}>
          {g > 0 ? <div aria-hidden className="mx-3 my-1.5 h-px bg-border" /> : null}
          {group.map((item) => {
            const active = isActivePath(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                search={item.search}
                onClick={onNavigate}
                activeOptions={{ exact: item.section === '' }}
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
                {item.section === '/templates' && pending > 0 ? (
                  <span
                    role="status"
                    aria-label={`${pending} to review`}
                    className="ml-auto grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs font-medium text-accent-on tabular-nums"
                  >
                    {pending}
                  </span>
                ) : null}
                {item.section === '/brand' && shown?.kind === 'org' ? (
                  <Suspense fallback={null}>
                    <BrandCount orgId={shown.orgId} />
                  </Suspense>
                ) : null}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
