import { ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadMore,
  PageHeader,
  Select,
} from '@/web/ui/index.ts';
import { useOrgList, useOrgNames } from '../orgs/queries.ts';
import { formatDateTime } from '../overview/format.ts';
import { type AuditSearch, dayToMs, msToDay } from './audit-search.ts';
import { EntryDrawer } from './entry-drawer.tsx';
import { useAuditLog } from './queries.ts';

const ALL = 'all';

interface FilterDraft {
  orgId: string;
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}

const toDraft = (s: AuditSearch): FilterDraft => ({
  orgId: s.orgId ?? ALL,
  action: s.action ?? '',
  actorId: s.actorId ?? '',
  targetType: s.targetType ?? '',
  targetId: s.targetId ?? '',
  from: msToDay(s.from),
  to: msToDay(s.to),
});

function Filters({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const orgs = useOrgList();
  const [draft, setDraft] = useState(() => toDraft(search));
  useEffect(
    () => setDraft(toDraft(search)),
    // Re-sync when the URL changes from outside (back button, links).
    [search],
  );
  const set = (k: keyof FilterDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const text = (k: keyof FilterDraft, label: string) => (
    <FormField label={label}>
      {(p) => <Input {...p} value={draft[k]} onChange={(e) => set(k)(e.target.value)} />}
    </FormField>
  );

  function apply() {
    const trim = (v: string) => v.trim() || undefined;
    onSearch({
      orgId: draft.orgId === ALL ? undefined : draft.orgId,
      action: trim(draft.action),
      actorId: trim(draft.actorId),
      targetType: trim(draft.targetType),
      targetId: trim(draft.targetId),
      from: dayToMs(draft.from, false),
      to: dayToMs(draft.to, true),
    });
  }

  return (
    <form
      aria-label="Filters"
      className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <FormField label="Organization">
        {(p) => (
          <Select
            {...p}
            value={draft.orgId}
            onValueChange={set('orgId')}
            options={[
              { value: ALL, label: 'All organizations' },
              ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
            ]}
          />
        )}
      </FormField>
      {text('action', 'Action')}
      {text('actorId', 'Actor ID')}
      {text('targetType', 'Target type')}
      {text('targetId', 'Target ID')}
      <FormField label="From">
        {(p) => (
          <Input
            {...p}
            type="date"
            value={draft.from}
            onChange={(e) => set('from')(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="To">
        {(p) => (
          <Input {...p} type="date" value={draft.to} onChange={(e) => set('to')(e.target.value)} />
        )}
      </FormField>
      <div className="flex items-end gap-2">
        <Button type="submit">Apply</Button>
        <Button variant="outline" onClick={() => onSearch({})}>
          Clear
        </Button>
      </div>
    </form>
  );
}

export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const orgName = useOrgNames();
  const log = useAuditLog(search);
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = search.entry === undefined ? undefined : rows.find((r) => r.id === search.entry);
  const { entry: _entry, ...filters } = search;
  const filtered = Object.values(filters).some((v) => v !== undefined);

  return (
    <>
      <PageHeader title="Audit log" />
      <Filters search={filters} onSearch={onSearch} />
      {log.isError ? (
        <ErrorState error={log.error} onRetry={() => log.refetch()} />
      ) : (
        <>
          <DataTable
            caption="Audit log"
            loading={log.isPending}
            data={rows}
            getRowId={(r) => String(r.id)}
            empty={
              <EmptyState icon={ScrollText} title={filtered ? 'No entries match' : 'No entries'} />
            }
            columns={[
              {
                header: 'Time',
                id: 'at',
                cell: ({ row }) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSearch({ ...filters, entry: row.original.id })}
                  >
                    {formatDateTime(row.original.at)}
                    <span className="sr-only"> details for {row.original.action}</span>
                  </Button>
                ),
              },
              {
                header: 'Action',
                id: 'action',
                cell: ({ row }) => <code className="font-mono text-xs">{row.original.action}</code>,
              },
              {
                header: 'Actor',
                id: 'actor',
                cell: ({ row }) =>
                  `${row.original.actorType}${row.original.actorId ? `: ${row.original.actorId}` : ''}`,
              },
              {
                header: 'Target',
                id: 'target',
                cell: ({ row }) =>
                  row.original.targetType
                    ? `${row.original.targetType}: ${row.original.targetId ?? ''}`
                    : '',
              },
              {
                header: 'Org',
                id: 'org',
                cell: ({ row }) => (row.original.orgId ? orgName(row.original.orgId) : ''),
              },
            ]}
          />
          <LoadMore
            hasMore={Boolean(log.hasNextPage)}
            loading={log.isFetchingNextPage}
            onLoadMore={() => log.fetchNextPage()}
            shown={rows.length}
          />
        </>
      )}
      <EntryDrawer entry={selected} orgName={orgName} onClose={() => onSearch(filters)} />
    </>
  );
}
