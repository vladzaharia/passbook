import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Cable, Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectionSchema } from '@/shared/contracts/connections.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
} from '../../ui/index.ts';
import { formatDate } from '../passes/format.ts';
import { useConnections } from './api.ts';
import { HealthPill } from './health.tsx';

type Connection = z.infer<typeof ConnectionSchema>;
const ALL = 'all';

export interface ConnectionListSearch {
  orgId?: string | undefined;
  health?: string | undefined;
}

export function ConnectionsListPage({
  search,
  onSearch,
}: {
  search: ConnectionListSearch;
  onSearch: (patch: Partial<ConnectionListSearch>) => void;
}) {
  const { orgId: globalOrg } = useOrgFilter();
  const orgId = search.orgId ?? globalOrg;
  const orgs = useOrgOptions();
  const list = useConnections({ orgId, health: search.health });
  const orgNames = useMemo(
    () => new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name])),
    [orgs.data],
  );
  const columns = useMemo<ColumnDef<Connection, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Connection',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            to={`/admin/connections/${row.original.id}` as never}
            className="font-medium text-accent-fg hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: 'type',
        header: 'Connector',
        enableSorting: false,
        cell: ({ row }) => row.original.connectorType,
      },
      {
        id: 'org',
        header: 'Org',
        enableSorting: false,
        cell: ({ row }) => orgNames.get(row.original.orgId) ?? row.original.orgId,
      },
      { id: 'mode', header: 'Mode', enableSorting: false, cell: ({ row }) => row.original.mode },
      {
        id: 'health',
        header: 'Health',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            <HealthPill health={row.original.enabled ? row.original.health : 'disabled'} />
            {row.original.lastErrorCode ? (
              <span className="font-mono text-xs text-danger">{row.original.lastErrorCode}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'last',
        header: 'Last success',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-fg-muted">{formatDate(row.original.lastSuccessAt)}</span>
        ),
      },
      {
        id: 'auto',
        header: 'Auto create',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.autoCreate ? <Badge tone="info">On</Badge> : <Badge>Off</Badge>,
      },
    ],
    [orgNames],
  );

  return (
    <>
      <PageHeader
        title="Connections"
        actions={
          <Button asChild iconStart={<Plus aria-hidden />}>
            <Link to="/admin/connections/new">New connection</Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Org"
          className="w-44"
          value={orgId ?? ALL}
          onValueChange={(v) => onSearch({ orgId: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Org: all' },
            ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
          ]}
        />
        <Select
          aria-label="Health"
          className="w-44"
          value={search.health ?? ALL}
          onValueChange={(v) => onSearch({ health: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Health: all' },
            ...['healthy', 'degraded', 'failing', 'paused', 'disabled', 'unknown'].map((h) => ({
              value: h,
              label: h,
            })),
          ]}
        />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Connections"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={list.isPending}
          empty={
            <EmptyState
              icon={Cable}
              title="No connections"
              action={
                <Button asChild>
                  <Link to="/admin/connections/new">New connection</Link>
                </Button>
              }
            />
          }
        />
      )}
    </>
  );
}
