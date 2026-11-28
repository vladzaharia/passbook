import { Link } from '@tanstack/react-router';
import type { ScannerSetup as ScannerDto } from '@/shared/contracts/scan-setups.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { Badge, RowLink, StatusPill } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { RelTime } from '../../../ui/rel-time.tsx';
import { acceptsText, scannerStatus } from './labels.ts';

/** The second line under a name: what paired, or that nothing has. */
export const deviceLine = (s: ScannerDto): string =>
  s.adminSession
    ? `Admin · ${s.adminUser?.name ?? 'No owner'}`
    : s.deviceRole === 'customer'
      ? 'Customer display'
      : s.deviceRole === 'monitor'
        ? 'Desk monitor'
        : s.kind === 'terminal'
          ? 'Till · token'
          : (s.pairedLabel ?? 'Not paired');

export function scannerColumns(
  now: number,
  eventName: (id: string) => string | undefined,
  session: (id: string | undefined) => { id: string; name: string; orgId: string } | undefined,
): DataColumnDef<ScannerDto, never>[] {
  return [
    {
      header: 'Name',
      id: 'name',
      meta: { grow: true },
      cell: ({ row }) => {
        const s = row.original;
        return (
          <div className="min-w-0">
            <RowLink
              to="/admin/scanning/scanners/$scannerId"
              params={{ scannerId: s.id }}
              inactive={s.status === 'revoked'}
            >
              {s.name}
            </RowLink>
            <span className="block truncate text-xs text-fg-muted">{deviceLine(s)}</span>
          </div>
        );
      },
    },
    {
      header: 'Status',
      id: 'status',
      meta: { nowrap: true },
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2">
          {row.original.adminSession && row.original.status !== 'revoked' ? (
            <Badge>Admin session</Badge>
          ) : (
            <StatusPill status={scannerStatus(row.original)} />
          )}
          <ModePill mode={row.original.mode} compact />
        </span>
      ),
    },
    {
      header: 'Session',
      id: 'session',
      meta: { nowrap: true },
      cell: ({ row }) => {
        const found = session(row.original.sessionId);
        return found ? (
          <Link
            to="/admin/o/$orgId/scanning/sessions/$sessionId"
            params={{ orgId: found.orgId, sessionId: found.id }}
            className="inline-flex items-center font-medium text-accent-fg pointer-coarse:min-h-11"
          >
            {found.name}
          </Link>
        ) : (
          <span className="text-fg-muted">—</span>
        );
      },
    },
    {
      header: 'Accepts',
      id: 'accepts',
      meta: { nowrap: true, hideBelow: 'lg' },
      cell: ({ row }) => {
        if (row.original.deviceRole === 'customer' || row.original.deviceRole === 'monitor')
          return <span className="text-fg-muted">—</span>;
        const accepts = row.original.accepts;
        const name = accepts && 'eventId' in accepts ? eventName(accepts.eventId) : undefined;
        return acceptsText(row.original, name);
      },
    },
    {
      header: 'Staff',
      id: 'staff',
      meta: { hideBelow: 'lg', stackHidden: true, nowrap: true },
      cell: ({ row }) =>
        row.original.staff?.name ??
        (row.original.settings.staffSignIn ? '—' : <span className="text-fg-muted">No PIN</span>),
    },
    {
      header: 'Today',
      id: 'today',
      meta: { hideBelow: 'md', numeric: true },
      cell: ({ row }) => (
        <span className={row.original.today === 0 ? 'text-fg-muted' : undefined}>
          {row.original.today}
        </span>
      ),
    },
    {
      header: 'Last seen',
      id: 'seen',
      meta: { hideBelow: 'md', nowrap: true },
      cell: ({ row }) =>
        row.original.lastSeenAt === null ? (
          <span className="text-fg-muted">Never</span>
        ) : (
          <RelTime at={row.original.lastSeenAt} now={now} />
        ),
    },
  ];
}
