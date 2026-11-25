import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { BroadcastDto, BroadcastState } from '@/shared/contracts/broadcasts.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { ENTITY } from '../../lib/entities.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  RowLink,
  SkeletonRows,
  StatusPill,
} from '../../ui/index.ts';
import { ForbiddenPage } from '../../ui/layout/error-pages.tsx';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { useBroadcastPages } from './api.ts';
import { countsLine, KIND_LABEL, STATE_FILTERS, whenLine } from './labels.ts';
import { BroadcastProgress } from './progress.tsx';
import { RuleEditor } from './rule-editor.tsx';
import { useRules } from './rules-api.ts';
import { type EditingRule, RulesSection } from './rules-section.tsx';

const ALL = 'all';

export interface MessagesSearch {
  state?: BroadcastState | undefined;
  /** `change` shows field changes; without it the list is messages only. */
  kind?: 'change' | undefined;
}

export function MessagesPage({
  search,
  onSearch,
}: {
  search: MessagesSearch;
  onSearch: (patch: Partial<MessagesSearch>) => void;
}) {
  const scope = useOrgScope();
  if (scope.isLoading) return <SkeletonRows label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!scope.orgId) return <OrgChooser />;
  if (!scope.membership?.capabilities.includes('messages:read')) return <ForbiddenPage />;
  return (
    <ScopedMessagesPage
      key={scope.orgId}
      orgId={scope.orgId}
      canCreate={scope.membership?.capabilities.includes('messages:manage') === true}
      search={search}
      onSearch={onSearch}
    />
  );
}

function ScopedMessagesPage({
  orgId,
  canCreate,
  search,
  onSearch,
}: {
  orgId: string;
  canCreate: boolean;
  search: MessagesSearch;
  onSearch: (patch: Partial<MessagesSearch>) => void;
}) {
  const list = useBroadcastPages({ orgId, state: search.state, kind: search.kind ?? 'message' });
  const rules = useRules(orgId);
  const [editing, setEditing] = useState<EditingRule>(null);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Test mode already says so in the header; a pill on every row would repeat it.
  const mixed = rows.some((r) => r.mode !== 'test');
  // The kind is a subtitle only when the list holds more than one.
  const kinds = new Set(rows.map((r) => r.kind)).size > 1;
  const columns = useMemo<DataColumnDef<BroadcastDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Message',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-80">
            <span className="flex min-w-0 items-center gap-2">
              <RowLink to="/admin/messages/$broadcastId" params={{ broadcastId: row.original.id }}>
                {row.original.name}
              </RowLink>
              {mixed ? <ModePill mode={row.original.mode} compact /> : null}
            </span>
            {kinds ? (
              <span className="block truncate text-xs text-fg-muted">
                {KIND_LABEL[row.original.kind]}
              </span>
            ) : null}
            {/* Phones show one row per message: the columns that fit nowhere move under the name. */}
            <span className="mt-1 flex flex-col gap-1 text-xs text-fg-muted md:hidden">
              <span>{whenLine(row.original)}</span>
              {row.original.state === 'sending' ? (
                <BroadcastProgress broadcast={row.original} className="w-40" />
              ) : countsLine(row.original) ? (
                <span>{countsLine(row.original)}</span>
              ) : null}
            </span>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'State',
        meta: { nowrap: true },
        cell: ({ row }) => (
          <StatusPill status={row.original.state}>
            {row.original.state === 'sent' ? 'Completed' : undefined}
          </StatusPill>
        ),
      },
      {
        id: 'progress',
        header: 'Progress',
        meta: { hideBelow: 'md', stackHidden: true },
        cell: ({ row }) => {
          const b = row.original;
          return b.state === 'sending' ? (
            <BroadcastProgress broadcast={b} className="w-40" />
          ) : (
            <span className="text-fg-muted">{countsLine(b) || '—'}</span>
          );
        },
      },
      {
        id: 'when',
        header: 'When',
        meta: { nowrap: true, hideBelow: 'md', stackHidden: true },
        cell: ({ row }) => whenLine(row.original),
      },
    ],
    [mixed, kinds],
  );

  const filtered = Boolean(search.state || search.kind);
  const clear = () => onSearch({ state: undefined, kind: undefined });
  const create = (variant: 'primary' | 'outline') =>
    canCreate ? (
      <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
        <Link to="/admin/messages/new">New message</Link>
      </Button>
    ) : null;
  // Nothing sent and nothing automatic: one empty state for the page, not one per section.
  const bare =
    !list.isPending &&
    !list.isError &&
    rows.length === 0 &&
    !filtered &&
    !rules.isPending &&
    (rules.data?.items.length ?? 0) === 0;

  return (
    <>
      <PageHeader title="Messages" actions={bare ? undefined : create('primary')} />
      {bare ? (
        <EmptyState
          art={ENTITY.broadcast.art}
          title="No messages yet"
          action={
            canCreate ? (
              <div className="flex flex-wrap justify-center gap-2 max-sm:flex-col max-sm:[&>*]:w-full">
                {create('primary')}
                <Button
                  variant="outline"
                  iconStart={<Plus aria-hidden />}
                  onClick={() => setEditing({})}
                >
                  New automatic message
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Sent" />
            {list.isError && rows.length === 0 ? (
              <ErrorState inline error={list.error} onRetry={() => void list.refetch()} />
            ) : (
              <DataTable
                bare
                caption="Messages"
                columns={columns}
                data={rows}
                getRowId={(r) => r.id}
                loading={list.isPending}
                fetching={list.isFetching && !list.isFetchingNextPage}
                filtered={filtered}
                toolbar={
                  <div className="px-3 py-3">
                    <FilterBar
                      filters={[
                        {
                          id: 'state',
                          label: 'State',
                          value: search.state ?? ALL,
                          defaultValue: ALL,
                          options: [
                            { value: ALL, label: 'All' },
                            ...STATE_FILTERS.map(([value, label]) => ({ value, label })),
                          ],
                          onChange: (v) =>
                            onSearch({ state: v === ALL ? undefined : (v as BroadcastState) }),
                        },
                        {
                          id: 'kind',
                          label: 'Show',
                          value: search.kind ?? 'message',
                          defaultValue: 'message',
                          options: [
                            { value: 'message', label: 'Messages' },
                            { value: 'change', label: 'Field changes' },
                          ],
                          onChange: (v) =>
                            onSearch({ kind: v === 'change' ? 'change' : undefined }),
                        },
                      ]}
                      onClear={clear}
                    />
                  </div>
                }
                emptyFiltered={<FilteredEmpty inline entity="broadcast" onClear={clear} />}
                empty={<EmptyState inline art={ENTITY.broadcast.art} title="No messages" />}
                footer={
                  <div className="px-3 pb-3">
                    <LoadMore
                      query={list}
                      shown={rows.length || undefined}
                      noun={['message', 'messages']}
                      scoped
                    />
                  </div>
                }
              />
            )}
          </Card>
          <RulesSection orgId={orgId} onEdit={setEditing} />
        </div>
      )}
      {editing ? (
        <RuleEditor
          key={editing.rule?.id ?? 'new'}
          orgId={orgId}
          rule={editing.rule}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
