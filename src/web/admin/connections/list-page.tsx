import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Cable, Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectionSchema } from '@/shared/contracts/connections.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import { Button, DataTable, EmptyState, ErrorState, PageHeader, Select } from '../../ui/index.ts';
import { formatDate } from '../passes/format.ts';
import { useConnections, useConnectorNames } from './api.ts';
import { ErrorLine } from './error-line.tsx';
import { HealthPill } from './health.tsx';
import { HEALTH_FILTERS, modeLabel } from './labels.ts';

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
  const connectorName = useConnectorNames();
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
        meta: { stackHidden: true },
        header: 'Connector',
        enableSorting: false,
        cell: ({ row }) => connectorName(row.original.connectorType),
      },
      {
        id: 'org',
        header: 'Org',
        enableSorting: false,
        cell: ({ row }) => orgNames.get(row.original.orgId) ?? row.original.orgId,
      },
      {
        id: 'mode',
        header: 'Mode',
        enableSorting: false,
        cell: ({ row }) => modeLabel(row.original.mode),
      },
      {
        id: 'health',
        header: 'Health',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <HealthPill health={row.original.enabled ? row.original.health : 'disabled'} />
            <ErrorLine code={row.original.lastErrorCode} />
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
        meta: { hideBelow: 'lg', stackHidden: true },
        header: 'Auto create',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm text-fg-muted">{row.original.autoCreate ? 'On' : 'Off'}</span>
        ),
      },
    ],
    [orgNames, connectorName],
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
      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Select
          aria-label="Org"
          className="sm:w-44"
          value={orgId ?? ALL}
          onValueChange={(v) => onSearch({ orgId: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Org: all' },
            ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
          ]}
        />
        <Select
          aria-label="Health"
          className="sm:w-44"
          value={search.health ?? ALL}
          onValueChange={(v) => onSearch({ health: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Health: all' },
            ...HEALTH_FILTERS.map(([value, label]) => ({ value, label })),
          ]}
        />
        {orgId || search.health ? (
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:col-span-2"
            onClick={() => onSearch({ orgId: undefined, health: undefined })}
          >
            Clear
          </Button>
        ) : null}
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
