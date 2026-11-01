import { Search, SlidersHorizontal } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { actionLabel } from '@/web/lib/actions.ts';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadMore,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from '@/web/ui/index.ts';
import { useOrgList, useOrgNames } from '../orgs/queries.ts';
import { formatDateTime } from '../overview/format.ts';
import { type AuditSearch, dayToMs, msToDay } from './audit-search.ts';
import { EntryDrawer } from './entry-drawer.tsx';
import { actorText, targetText } from './labels.ts';
import { useAuditLog } from './queries.ts';

const ALL = 'all';

/** Text fields wait for a pause so the URL and the query change once. */
function useDebounced(value: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const t = setTimeout(() => onCommit(draft.trim()), 250);
    return () => clearTimeout(t);
  }, [draft, value, onCommit]);
  return [draft, setDraft] as const;
}

function TextFilter({
  label,
  value,
  onCommit,
  className,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  type?: string;
}) {
  const [draft, setDraft] = useDebounced(value, onCommit);
  return (
    <Input
      type={type}
      aria-label={label}
      placeholder={placeholder}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function Filters({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const orgs = useOrgList();
  const patch = (p: AuditSearch) => onSearch({ ...search, ...p });
  const text = (k: 'action' | 'actorId' | 'targetType' | 'targetId') => (v: string) =>
    patch({ [k]: v || undefined });
  const extra = [search.actorId, search.targetType, search.targetId].filter(Boolean).length;
  const active = Object.values(search).some((v) => v !== undefined);

  return (
    <search aria-label="Filters" className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-muted"
        />
        <TextFilter
          label="Action"
          type="search"
          placeholder="Search action"
          className="pl-9"
          value={search.action ?? ''}
          onCommit={text('action')}
        />
      </div>
      <div className="w-full sm:w-44">
        <Select
          aria-label="Org"
          className="w-full"
          value={search.orgId ?? ALL}
          onValueChange={(v) => patch({ orgId: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Org: all' },
            ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
          ]}
        />
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
        <Input
          type="date"
          aria-label="From"
          className="sm:w-40"
          value={msToDay(search.from)}
          onChange={(e) => patch({ from: dayToMs(e.target.value, false) })}
        />
        <Input
          type="date"
          aria-label="To"
          className="sm:w-40"
          value={msToDay(search.to)}
          onChange={(e) => patch({ to: dayToMs(e.target.value, true) })}
        />
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <SlidersHorizontal aria-hidden />
            Filters{extra > 0 ? ` (${extra})` : ''}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex flex-col gap-4">
          <FormField label="Actor ID">
            {(p) => (
              <TextFilterField {...p} value={search.actorId ?? ''} onCommit={text('actorId')} />
            )}
          </FormField>
          <FormField label="Target type">
            {(p) => (
              <TextFilterField
                {...p}
                value={search.targetType ?? ''}
                onCommit={text('targetType')}
              />
            )}
          </FormField>
          <FormField label="Target ID">
            {(p) => (
              <TextFilterField {...p} value={search.targetId ?? ''} onCommit={text('targetId')} />
            )}
          </FormField>
        </PopoverContent>
      </Popover>
      {active ? (
        <Button variant="ghost" size="sm" onClick={() => onSearch({})}>
          Clear
        </Button>
      ) : null}
    </search>
  );
}

function TextFilterField({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange'
>) {
  const [draft, setDraft] = useDebounced(value, onCommit);
  return <Input {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} />;
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
            stack={false}
            loading={log.isPending}
            data={rows}
            getRowId={(r) => String(r.id)}
            onRowClick={(r) => onSearch({ ...filters, entry: r.id })}
            empty={
              <EmptyState
                art="log"
                variant={filtered ? 'filtered' : 'empty'}
                title={filtered ? 'No entries match' : 'No entries'}
              />
            }
            columns={[
              {
                header: 'Time',
                id: 'at',
                cell: ({ row }) => (
                  <button
                    type="button"
                    className="rounded-sm text-left whitespace-nowrap text-fg hover:underline"
                    onClick={() => onSearch({ ...filters, entry: row.original.id })}
                  >
                    {formatDateTime(row.original.at)}
                    <span className="sr-only"> details for {actionLabel(row.original.action)}</span>
                  </button>
                ),
              },
              {
                header: 'Action',
                id: 'action',
                cell: ({ row }) => (
                  <div className="min-w-0">
                    <p>{actionLabel(row.original.action)}</p>
                    <code className="font-mono text-xs text-fg-muted">{row.original.action}</code>
                  </div>
                ),
              },
              {
                header: 'Actor',
                id: 'actor',
                cell: ({ row }) => actorText(row.original),
              },
              {
                header: 'Target',
                id: 'target',
                cell: ({ row }) => targetText(row.original),
              },
              {
                header: 'Org',
                id: 'org',
                meta: { hideBelow: 'xl' },
                cell: ({ row }) => (row.original.orgId ? orgName(row.original.orgId) : '—'),
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
