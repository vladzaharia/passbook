import type { ColumnDef } from '@tanstack/react-table';
import { Ban, QrCode } from 'lucide-react';
import type { ScannerSetup as ScannerDto } from '@/shared/contracts/scan-setups.ts';
import { Badge, Button, RowActions, RowLink, StatusPill } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { RelTime } from '../../passes/detail/rel-time.tsx';
import { acceptsText, scannerStatus } from './labels.ts';

export interface ScannerActions {
  onPair: (s: ScannerDto) => void;
  onRevoke: (s: ScannerDto) => void;
}

/** The second line under a name: what paired, or that nothing has. */
export const deviceLine = (s: ScannerDto): string =>
  s.adminSession
    ? `Admin · ${s.adminUser?.name ?? 'No owner'}`
    : s.deviceRole === 'customer'
      ? 'Customer screen'
      : s.deviceRole === 'monitor'
        ? 'Desk monitor'
        : s.kind === 'terminal'
          ? 'Till · token'
          : (s.pairedLabel ?? 'Not paired');

export function scannerActions(s: ScannerDto, a: ScannerActions) {
  const revoked = s.status === 'revoked';
  return [
    ...(revoked || s.adminSession || s.kind === 'terminal'
      ? []
      : [
          {
            label: s.status === 'paired' ? 'Pair again' : 'Pair',
            icon: QrCode,
            onSelect: () => a.onPair(s),
          },
        ]),
    ...(revoked
      ? []
      : [{ label: 'Revoke', icon: Ban, destructive: true, onSelect: () => a.onRevoke(s) }]),
  ];
}

export function scannerColumns(
  a: ScannerActions,
  now: number,
  eventName: (id: string) => string | undefined,
  canManage: boolean,
): ColumnDef<ScannerDto, never>[] {
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
      header: 'Accepts',
      id: 'accepts',
      meta: { nowrap: true },
      cell: ({ row }) => {
        const accepts = row.original.accepts;
        const name = accepts && 'eventId' in accepts ? eventName(accepts.eventId) : undefined;
        return acceptsText(row.original, name);
      },
    },
    {
      header: 'Staff',
      id: 'staff',
      meta: { hideBelow: 'xl', stackHidden: true, nowrap: true },
      cell: ({ row }) =>
        row.original.staff?.name ??
        (row.original.settings.staffSignIn ? (
          '—'
        ) : (
          <span className="text-fg-muted">Sign-in off</span>
        )),
    },
    {
      header: 'Today',
      id: 'today',
      meta: { hideBelow: 'lg', numeric: true },
      cell: ({ row }) => (
        <span className={row.original.today === 0 ? 'text-fg-muted' : undefined}>
          {row.original.today}
        </span>
      ),
    },
    {
      header: 'Last seen',
      id: 'seen',
      meta: { hideBelow: 'lg', nowrap: true },
      cell: ({ row }) =>
        row.original.lastSeenAt === null ? (
          <span className="text-fg-muted">Never</span>
        ) : (
          <RelTime at={row.original.lastSeenAt} now={now} />
        ),
    },
    {
      header: () => <span className="sr-only">Actions</span>,
      id: 'actions',
      cell: ({ row }) => {
        if (!canManage) return null;
        const s = row.original;
        const menu = scannerActions(s, a);
        // A scanner nobody has paired shows the safe action as a button, the rest in the menu.
        const unpaired = s.status === 'not_paired' && !s.adminSession && s.kind !== 'terminal';
        return (
          <div className="flex items-center justify-end gap-1">
            {unpaired ? (
              <Button
                variant="ghost"
                size="sm"
                iconStart={<QrCode aria-hidden />}
                onClick={() => a.onPair(s)}
              >
                Pair
              </Button>
            ) : null}
            <RowActions label={`Actions for ${s.name}`} actions={unpaired ? menu.slice(1) : menu} />
          </div>
        );
      },
    },
  ];
}
