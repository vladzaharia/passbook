import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { DataTable, EmptyState, ErrorState, FilterBar, LoadMore } from '@/web/ui/index.ts';
import type { ScanningSearch } from '../scanning/search.ts';
import { useTagList } from './api.ts';
import { KindPill } from './enroll-result.tsx';
import { TagCode } from './tag-code.tsx';
import { WorksWithChip } from './tag-row.tsx';
import { TagSheet } from './tag-sheet.tsx';
import { StateBadge, TAG_STATE_FILTERS } from './tags-state.tsx';
import { tagName } from './words.ts';

/**
 * Scanning > Tags: the org's tags in the current mode. Filter by state, search by name or code,
 * open one for its binding. Tags are assigned from a pass or a scanner, not here.
 */
export function TagsTab({ search }: { search: ScanningSearch }) {
  const scope = useOrgScope();
  const orgId = scope.orgId;
  if (!orgId) return <EmptyState art="badge" title="Select an organization" />;
  const canOperate = Boolean(scope.membership?.capabilities.includes('passes:operate'));
  return <Inventory key={orgId} orgId={orgId} search={search} readOnly={!canOperate} />;
}

function Inventory({
  orgId,
  search,
  readOnly,
}: {
  orgId: string;
  search: ScanningSearch;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const state = search.tagState;
  const [q, setQ] = useState(search.tagQ ?? '');
  const query = useTagList(orgId, state, search.tagQ);
  const set = (patch: Partial<ScanningSearch>) =>
    void navigate({ to: '.', search: (prev) => ({ ...prev, ...patch }), replace: true });
  const columns: DataColumnDef<Tag>[] = [
    {
      id: 'tag',
      header: 'Tag',
      cell: ({ row }) => (
        <button
          type="button"
          className="text-left underline-offset-2 hover:underline"
          onClick={() => set({ tag: row.original.id })}
        >
          <span className="text-fg-strong">{tagName(row.original)}</span>{' '}
          <TagCode hint={row.original.hint} className="text-xs text-fg-muted" />
        </button>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      cell: ({ row }) => <KindPill assurance={row.original.assurance} />,
    },
    {
      id: 'person',
      header: 'Holder',
      cell: ({ row }) =>
        row.original.binding?.holderName ?? row.original.binding?.passTitle ?? null,
    },
    {
      id: 'works',
      header: 'Works with',
      cell: ({ row }) => <WorksWithChip tag={row.original} pass={false} />,
    },
    { id: 'state', header: 'Status', cell: ({ row }) => <StateBadge state={row.original.state} /> },
    {
      id: 'used',
      header: 'Last used',
      cell: ({ row }) => formatDateTime(row.original.lastSeenAt, TAG_COPY.neverUsed),
    },
  ];
  if (query.isError && !query.isFetchNextPageError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(state || search.tagQ);
  return (
    <>
      <DataTable
        caption="Tags"
        data={rows}
        columns={columns}
        getRowId={(t) => t.id}
        loading={query.isPending}
        fetching={query.isFetching && !query.isPending}
        filtered={filtered}
        toolbar={
          <FilterBar
            search={{
              value: q,
              onChange: (value) => {
                setQ(value);
                set({ tagQ: value.trim() || undefined });
              },
              placeholder: TAG_COPY.inventory.search,
            }}
            filters={[
              {
                id: 'state',
                label: 'Status',
                value: state ?? 'any',
                defaultValue: 'any',
                options: TAG_STATE_FILTERS,
                onChange: (v) =>
                  set({ tagState: v === 'any' ? undefined : (v as ScanningSearch['tagState']) }),
              },
            ]}
            onClear={() => {
              setQ('');
              set({ tagQ: undefined, tagState: undefined });
            }}
          />
        }
        footer={
          <LoadMore query={query} shown={rows.length || undefined} noun={['tag', 'tags']} scoped />
        }
        empty={
          <EmptyState
            art="badge"
            title={TAG_COPY.inventory.empty.headline}
            description={TAG_COPY.inventory.empty.sub}
          />
        }
      />
      {search.tag ? (
        <TagSheet id={search.tag} readOnly={readOnly} onClose={() => set({ tag: undefined })} />
      ) : null}
    </>
  );
}
