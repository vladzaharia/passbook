import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Copy, MonitorSmartphone, Play, Plus, Radio, ScanLine } from 'lucide-react';
import { useState } from 'react';
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
  toast,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { useScanEvents } from '../scanner-api.ts';
import { SetupChecklist } from '../setup-checklist.tsx';
import { useScanningSessions, useUpdateSession } from './api.ts';
import { sessionAccepts, sessionRuleLabel } from './draft.ts';
import { type HoursDialog, HoursDialogs, HoursMenuItems } from './session-hours-actions.tsx';
import { SessionStatePill, sessionState } from './session-state.tsx';

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
  const events = useScanEvents(orgId, Boolean(orgId));
  const eventName = (id: string) =>
    events.data?.items.find((e) => e.orgId === orgId && e.id === id)?.name;
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
        <SetupChecklist onNew={canManage ? onNew : undefined} />
        <EmptyState
          art="scanner"
          title="No scanning sessions"
          action={
            canManage ? (
              <Button iconStart={<Plus aria-hidden />} onClick={onNew}>
                New scanning session
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  const online = items.reduce((n, s) => n + s.onlineCount, 0);
  return (
    <div className="grid gap-6">
      <SetupChecklist onNew={canManage ? onNew : undefined} />
      <div className="flex flex-wrap gap-2 text-sm text-fg-muted">
        <Badge>
          <Radio aria-hidden />
          {items.filter((s) => sessionState(s) === 'running').length} running
        </Badge>
        <Badge>
          <MonitorSmartphone aria-hidden />
          {online} {online === 1 ? 'device' : 'devices'} online
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
              {canManage ? <CardMenu session={s} onDuplicate={onDuplicate} /> : null}
            </div>
            <CardBody className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <SessionStatePill session={s} />
                <ModePill mode={s.mode} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric value={s.today} label="Today" />
                <Metric value={s.deviceCount} label="Devices" />
                <Metric value={s.onlineCount} label="Online" />
              </div>
              <p className="text-sm text-fg-muted">
                {sessionAccepts(
                  s,
                  s.accepts && 'eventId' in s.accepts ? eventName(s.accepts.eventId) : undefined,
                )}{' '}
                · {sessionRuleLabel(s)}
              </p>
              {canManage ? (
                <Button asChild variant="ghost" size="sm" iconStart={<ScanLine aria-hidden />}>
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
function CardMenu({
  session: s,
  onDuplicate,
}: {
  session: ScanningSession;
  onDuplicate: (s: ScanningSession) => void;
}) {
  const [dialog, setDialog] = useState<HoursDialog>();
  return (
    <>
      <MoreMenu>
        {s.status !== 'active' ? <ResumeItem session={s} /> : null}
        <HoursMenuItems session={s} onDialog={setDialog} />
        <DropdownMenuItem onSelect={() => onDuplicate(s)}>
          <Copy aria-hidden />
          Duplicate session
        </DropdownMenuItem>
      </MoreMenu>
      <HoursDialogs session={s} dialog={dialog} onClose={() => setDialog(undefined)} />
    </>
  );
}
function ResumeItem({ session: s }: { session: ScanningSession }) {
  const update = useUpdateSession(s.id);
  return (
    <DropdownMenuItem
      disabled={update.isPending}
      onSelect={() => {
        update
          .mutateAsync({ status: 'active', revision: s.updatedAt })
          .catch((error: unknown) => toast.error(error, 'Could not change session'));
      }}
    >
      <Play aria-hidden />
      Resume session
    </DropdownMenuItem>
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
