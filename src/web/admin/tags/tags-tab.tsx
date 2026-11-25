import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadMore,
  SegmentedControl,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import type { ScanningSearch } from '../scanning/search.ts';
import { useTagList } from './api.ts';
import { KindPill } from './enroll-result.tsx';
import { TagCode } from './tag-code.tsx';
import { WorksWithChip } from './tag-row.tsx';
import { TagSheet } from './tag-sheet.tsx';
import { StateBadge, TAG_STATE_FILTERS } from './tags-state.tsx';
import { tagName } from './words.ts';

const KeysetsView = lazy(() =>
  import('../scanning/tags/keysets/keysets-view.tsx').then((m) => ({ default: m.KeysetsView })),
);

/**
 * Scanning > Tags: the org's tags in the current mode. Filter by state, search by name or code,
 * open one for its binding. Tags are assigned from a pass or a scanner, not here.
 */
export function TagsTab({ search }: { search: ScanningSearch }) {
  const scope = useOrgScope();
  const orgId = scope.orgId;
  if (!orgId) return <OrgChooser inline />;
  const canOperate = Boolean(scope.membership?.capabilities.includes('passes:operate'));
  const canManage = Boolean(scope.membership?.capabilities.includes('scanning:manage'));
  return (
    <TagsViews
      key={orgId}
      orgId={orgId}
      search={search}
      canManage={canManage}
      readOnly={!canOperate}
    />
  );
}

/** Tags, and Secure keys beside them: one more view of the same tab. */
function TagsViews({
  orgId,
  search,
  canManage,
  readOnly,
}: {
  orgId: string;
  search: ScanningSearch;
  canManage: boolean;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const view = search.tagView ?? 'tags';
  const set = (patch: Partial<ScanningSearch>) =>
    void navigate({ to: '.', search: (prev) => ({ ...prev, ...patch }), replace: true });
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Tags view"
        value={view}
        options={[
          { value: 'tags', label: KEYSET_COPY.tabs.tags },
          { value: 'keys', label: KEYSET_COPY.tabs.keys },
        ]}
        onValueChange={(next) =>
          set({
            tagView: next === 'keys' ? 'keys' : undefined,
            tag: undefined,
            keyset: undefined,
          })
        }
      />
      {view === 'keys' ? (
        <Suspense fallback={<SkeletonRows label="Loading keys" />}>
          <KeysetsView
            orgId={orgId}
            canManage={canManage}
            open={search.keyset}
            onOpen={(keyset) => set({ keyset })}
          />
        </Suspense>
      ) : (
        <Inventory orgId={orgId} search={search} readOnly={readOnly} />
      )}
    </div>
  );
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
        empty={<EmptyState art="badge" title={TAG_COPY.inventory.empty.headline} />}
      />
      {search.tag ? (
        <TagSheet id={search.tag} readOnly={readOnly} onClose={() => set({ tag: undefined })} />
      ) : null}
    </>
  );
}
