import { Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowUpRight,
  Copy,
  ListChecks,
  MonitorSmartphone,
  Radio,
  ScanLine,
} from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DropdownMenuItem,
  EmptyState,
  ErrorState,
  MoreMenu,
  Skeleton,
  StatusPill,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { useScanningSessions } from './api.ts';
import { sessionAccepts, sessionRuleLabel } from './draft.ts';

export function SessionsTab({
  canManage,
  onNew,
  onDuplicate,
}: {
  canManage: boolean;
  onNew: () => void;
  onDuplicate: (s: ScanningSession) => void;
}) {
  const { orgId } = useOrgScope();
  const query = useScanningSessions(orgId);
  const items = query.data?.pages.flatMap((p) => p.items).filter((s) => s.orgId === orgId) ?? [];
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.isPending)
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-52" />
        ))}
      </div>
    );
  if (!items.length)
    return (
      <div>
        <div className="grid gap-4 rounded-lg border border-border bg-surface-raised p-4 sm:grid-cols-3">
          {[
            {
              icon: ListChecks,
              title: '1. Set shared rules',
              detail: 'Choose passes and admission.',
            },
            {
              icon: MonitorSmartphone,
              title: '2. Add devices',
              detail: 'Pair scanners and displays.',
            },
            { icon: Activity, title: '3. Follow activity', detail: 'See check-ins in one place.' },
          ].map(({ icon: Icon, title, detail }) => (
            <div key={title} className="flex min-w-0 items-start gap-3">
              <span className="rounded-md bg-surface-sunken p-2">
                <Icon className="size-4 text-fg-muted" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold text-fg-strong">{title}</p>
                <p className="mt-1 text-xs text-fg-muted">{detail}</p>
              </div>
            </div>
          ))}
        </div>
        <EmptyState
          art="scanner"
          title="No scanning sessions"
          description="Create a session to share admission rules across devices."
          action={canManage ? <Button onClick={onNew}>New scanning session</Button> : undefined}
        />
      </div>
    );
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap gap-2 text-sm text-fg-muted">
        <Badge>
          <Radio aria-hidden />
          {items.filter((s) => s.status === 'active').length} running
        </Badge>
        <Badge>
          <MonitorSmartphone aria-hidden />
          {items.reduce((n, s) => n + s.onlineCount, 0)} devices online
        </Badge>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {items.map((s) => (
          <Card key={s.id} className="overflow-hidden">
            <div className="flex items-start justify-between gap-3 border-b border-border p-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">
                  <Link
                    className="inline-flex items-center gap-2 text-fg-strong hover:text-accent-fg"
                    to="/admin/scanning/sessions/$sessionId"
                    params={{ sessionId: s.id }}
                  >
                    {s.name}
                    <ArrowUpRight className="size-4 shrink-0" aria-hidden />
                  </Link>
                </h2>
                <p className="mt-1 truncate text-xs text-fg-muted">{s.orgName}</p>
              </div>
              {canManage ? (
                <MoreMenu>
                  <DropdownMenuItem onSelect={() => onDuplicate(s)}>
                    <Copy aria-hidden />
                    Duplicate session
                  </DropdownMenuItem>
                </MoreMenu>
              ) : null}
            </div>
            <CardBody className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  status={s.status}
                  tone={
                    s.status === 'active'
                      ? 'success'
                      : s.status === 'paused'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {s.status === 'active' ? 'Running' : s.status === 'paused' ? 'Paused' : 'Ended'}
                </StatusPill>
                <ModePill mode={s.mode} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric value={s.today} label="Today" />
                <Metric value={s.deviceCount} label="Devices" />
                <Metric value={s.onlineCount} label="Online" />
              </div>
              <p className="text-sm text-fg-muted">
                {sessionAccepts(s)} · {sessionRuleLabel(s)}
              </p>
              {canManage ? (
                <Button asChild variant="outline" iconStart={<ScanLine aria-hidden />}>
                  <a
                    href={`/scan?admin=1&orgId=${encodeURIComponent(s.orgId)}&sessionId=${encodeURIComponent(s.id)}`}
                  >
                    Scan as Admin
                  </a>
                </Button>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more sessions
        </Button>
      ) : null}
    </div>
  );
}
export function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums text-fg-strong">{value}</p>
      <p className="text-xs text-fg-muted">{label}</p>
    </div>
  );
}
