import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Upload } from 'lucide-react';
import { useMemo } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { formatDay } from '../../lib/format.ts';
import { BELOW_MD, useMediaQuery } from '../../lib/media.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Badge,
  Button,
  CountLink,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  RowLink,
  SegmentedControl,
  StatusPill,
} from '../../ui/index.ts';
import { useRecentUploads, useTemplatePages } from './api.ts';
import { originLabel, TemplateGallery, TemplateStill } from './gallery.tsx';
import { styleList } from './labels.ts';
import { RecentUploads, uploadsNeedAttention } from './recent-uploads.tsx';
import type { TemplateListSearch } from './search.ts';

const ALL = 'all';
const VIEWS = [
  { value: 'gallery', label: 'Gallery' },
  { value: 'table', label: 'Table' },
] as const;

function columns(
  archived: boolean,
  orgId: string | undefined,
): ColumnDef<TemplateSummaryDto, never>[] {
  return [
    {
      id: 'name',
      header: 'Template',
      cell: ({ row }) => (
        <span className="flex min-w-0 max-w-80 items-center gap-3">
          <TemplateStill template={row.original} className="w-7 shrink-0" />
          <RowLink
            to="/admin/templates/$templateId"
            params={{ templateId: row.original.id }}
            search={{ orgId }}
            inactive={row.original.status === 'archived'}
          >
            {row.original.name}
          </RowLink>
        </span>
      ),
    },
    {
      id: 'origin',
      header: 'Origin',
      cell: ({ row }) => <Badge>{originLabel(row.original.origin)}</Badge>,
    },
    {
      id: 'org',
      header: 'Organization',
      meta: { hideBelow: 'lg', nowrap: true },
      cell: ({ row }) => row.original.orgName ?? 'All organizations',
    },
    {
      id: 'styles',
      header: 'Styles',
      meta: { hideBelow: 'xl', nowrap: true },
      cell: ({ row }) => styleList(row.original.styles),
    },
    {
      id: 'updated',
      header: 'Updated',
      meta: { hideBelow: 'xl', nowrap: true },
      cell: ({ row }) => (
        <span className="text-fg-muted tabular-nums">{formatDay(row.original.updatedAt)}</span>
      ),
    },
    {
      id: 'passes',
      header: 'Passes',
      meta: { numeric: true },
      cell: ({ row }) => (
        <CountLink
          count={row.original.passCount}
          to="/admin/passes"
          search={{ templateId: row.original.id }}
          aria-label={`${row.original.passCount} passes from ${row.original.name}`}
        />
      ),
    },
    ...(archived
      ? [
          {
            id: 'status',
            header: 'Status',
            cell: ({ row }) => <StatusPill status={row.original.status} />,
          } satisfies ColumnDef<TemplateSummaryDto, never>,
        ]
      : []),
  ];
}

export function TemplatesListPage({
  search,
  onSearch,
}: {
  search: TemplateListSearch;
  onSearch: (patch: Partial<TemplateListSearch>) => void;
}) {
  const { orgId, membership } = useOrgScope();
  const canAuthor = membership?.capabilities.includes('templates:author') ?? false;
  const uploads = useRecentUploads(canAuthor ? orgId : undefined);
  const uploadsFirst = uploadsNeedAttention(uploads.data?.items ?? [], Date.now());
  const phone = useMediaQuery(BELOW_MD);
  const list = useTemplatePages({
    orgId,
    origin: search.origin,
    includeArchived: search.archived,
    q: search.q,
  });
  const [q, setQ] = useDebouncedCommit(search.q ?? '', (next) =>
    onSearch({ q: next || undefined }),
  );
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = Boolean(search.q || search.origin || search.archived);
  const view = phone ? 'gallery' : (search.view ?? 'gallery');
  const cols = useMemo(() => columns(Boolean(search.archived), orgId), [search.archived, orgId]);
  const clear = () => {
    setQ('');
    onSearch({ q: undefined, origin: undefined, archived: undefined });
  };
  const toolbar = (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <FilterBar
        className="min-w-0 flex-1"
        search={{ value: q, onChange: setQ, placeholder: 'Search templates' }}
        filters={[
          {
            id: 'origin',
            label: 'Origin',
            value: search.origin ?? ALL,
            defaultValue: ALL,
            options: [
              { value: ALL, label: 'All' },
              { value: 'baked', label: 'Built-in' },
              { value: 'uploaded', label: 'Uploaded' },
            ],
            onChange: (v) =>
              onSearch({ origin: v === ALL ? undefined : (v as 'baked' | 'uploaded') }),
          },
          {
            id: 'archived',
            label: 'Archived',
            value: search.archived ? 'show' : 'hide',
            defaultValue: 'hide',
            options: [
              { value: 'hide', label: 'Hidden' },
              { value: 'show', label: 'Shown' },
            ],
            onChange: (v) => onSearch({ archived: v === 'show' || undefined }),
          },
        ]}
        onClear={clear}
      />
      {phone ? null : (
        <SegmentedControl
          label="View"
          options={VIEWS}
          value={view}
          onValueChange={(v) => onSearch({ view: v === 'gallery' ? undefined : v })}
        />
      )}
    </div>
  );
  const truth = !list.isPending && !list.isError && !filtered && items.length === 0;
  const upload = (variant: 'primary' | 'outline') => (
    <Button asChild variant={variant} iconStart={<Upload aria-hidden />}>
      <Link to="/admin/templates/upload" search={{ orgId }}>
        Upload template
      </Link>
    </Button>
  );
  const footer = (
    <LoadMore
      query={list}
      shown={items.length || undefined}
      noun={['template', 'templates']}
      scoped
    />
  );

  return (
    <>
      <PageHeader
        title="Templates"
        actions={canAuthor ? upload(truth ? 'outline' : 'primary') : undefined}
      />
      {canAuthor && uploadsFirst ? <RecentUploads orgId={orgId} className="mt-0 mb-6" /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          title="Could not load templates"
          onRetry={() => void list.refetch()}
        />
      ) : truth ? (
        <EmptyState
          art="template"
          title="No templates yet"
          action={canAuthor ? upload('primary') : undefined}
        />
      ) : view === 'gallery' ? (
        <div
          aria-busy={(list.isFetching && !list.isPending && !list.isFetchingNextPage) || undefined}
          className="flex flex-col"
        >
          {toolbar}
          {filtered && items.length === 0 && !list.isPending ? (
            <FilteredEmpty entity="template" onClear={clear} />
          ) : (
            <TemplateGallery items={items} loading={list.isPending} />
          )}
          {footer}
        </div>
      ) : (
        <DataTable
          caption="Templates"
          columns={cols}
          data={items}
          getRowId={(r) => r.id}
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          filtered={filtered}
          toolbar={toolbar}
          emptyFiltered={<FilteredEmpty entity="template" onClear={clear} />}
          footer={footer}
        />
      )}
      {canAuthor && !uploadsFirst ? <RecentUploads orgId={orgId} /> : null}
    </>
  );
}
