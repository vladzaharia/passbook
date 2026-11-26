import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { WalletIdentitySchema } from '@/shared/contracts/identities.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { formatCount, formatDay } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  Callout,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadMore,
  RowLink,
  StatusPill,
} from '@/web/ui/index.ts';
import { useOrgList, useOrgNames } from '../../orgs/queries.ts';
import { ATTENTION_COPY, expiryPhrase, identityAttention } from './attention.ts';
import { IdentityStatusPill, KIND_LABEL, renewalText, STATUS_OPTIONS } from './identity-status.tsx';
import { useWalletIdentityPages } from './managed-queries.ts';
import { NewManagedIdentityDialog } from './new-managed-dialog.tsx';
import { PlatformSection } from './platform-section.tsx';
import { UploadIdentityDialog } from './upload-dialog.tsx';

type Row = z.infer<typeof WalletIdentitySchema>;
const Icon = ENTITY.identity.icon;
const ALL = 'all';
const KINDS = [
  { value: ALL, label: 'any' },
  { value: 'platform', label: KIND_LABEL.platform },
  { value: 'managed', label: KIND_LABEL.managed },
  { value: 'own', label: KIND_LABEL.own },
];

/** The Apple tab of Platform › Wallet accounts. */
export function IdentitiesPanel() {
  const [kind, setKind] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [org, setOrg] = useState(ALL);
  const list = useWalletIdentityPages({
    ...(kind !== ALL ? { kind: kind as Row['kind'] } : {}),
    ...(status !== ALL ? { status: status as Row['status'] } : {}),
    ...(org !== ALL ? { orgId: org } : {}),
  });
  const orgs = useOrgList();
  const orgName = useOrgNames();
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtering = kind !== ALL || status !== ALL || org !== ALL;
  const empty = !list.isPending && !list.isError && rows.length === 0 && !filtering;
  const now = Date.now();
  const attention = useMemo(() => identityAttention(rows, now), [rows, now]);
  const create = (variant: 'primary' | 'outline') => (
    <Button
      variant={variant}
      iconStart={<ACTION_ICON.create aria-hidden />}
      onClick={() => setCreating(true)}
    >
      New managed ID
    </Button>
  );
  const columns = useMemo<DataColumnDef<Row, never>[]>(
    () => [
      {
        header: 'Identifier',
        id: 'identifier',
        cell: ({ row }) => (
          <div className="flex min-h-10 min-w-0 items-center gap-3">
            <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <span className="flex min-w-0 items-center gap-2">
              <RowLink
                to="/admin/platform/wallet-accounts/$identityId"
                params={{ identityId: row.original.id }}
                className="truncate font-mono text-xs"
              >
                {row.original.identifier}
              </RowLink>
              {row.original.isDefault ? <StatusPill status="default" /> : null}
            </span>
          </div>
        ),
      },
      {
        header: 'Organization',
        id: 'org',
        meta: { nowrap: true, hideBelow: 'md' },
        cell: ({ row }) => orgName(row.original.orgId),
      },
      {
        header: 'Kind',
        id: 'kind',
        meta: { nowrap: true, hideBelow: 'md' },
        cell: ({ row }) => KIND_LABEL[row.original.kind],
      },
      {
        header: 'Status',
        id: 'status',
        cell: ({ row }) => <IdentityStatusPill status={row.original.status} />,
      },
      {
        header: 'Expires',
        id: 'expires',
        meta: { nowrap: true, hideBelow: 'md' },
        cell: ({ row }) => formatDay(row.original.notAfter, '—'),
      },
      {
        header: 'Renews',
        id: 'renews',
        meta: { nowrap: true, hideBelow: 'lg' },
        cell: ({ row }) => renewalText(row.original),
      },
      {
        header: 'Passes',
        id: 'passes',
        meta: { numeric: true, hideBelow: 'md' },
        cell: ({ row }) => formatCount(row.original.passCount),
      },
    ],
    [orgName],
  );
  return (
    <>
      <PlatformSection />
      {attention ? (
        <Callout
          className="mb-6"
          actionsAside
          tone={attention.tone}
          title={`${attention.identity.label}: certificate ${
            attention.reason === 'expiring' && attention.days !== null
              ? `${expiryPhrase(attention.days)}, ${formatDay(attention.identity.notAfter, '')}`
              : ATTENTION_COPY[attention.reason]
          }`}
          actions={
            <Button asChild size="sm" variant="outline">
              <Link
                to="/admin/platform/wallet-accounts/$identityId"
                params={{ identityId: attention.identity.id }}
              >
                Open identity
              </Link>
            </Button>
          }
        >
          {attention.count > 1 ? `${attention.count - 1} more need a look.` : null}
        </Callout>
      ) : null}
      <h2 className="sr-only">Apple identities</h2>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            iconStart={<ACTION_ICON.upload aria-hidden />}
            onClick={() => setUploading(true)}
          >
            Upload
          </Button>
          {create('primary')}
        </div>
      </div>
      <FilterBar
        filters={[
          {
            id: 'kind',
            label: 'Kind',
            value: kind,
            defaultValue: ALL,
            options: KINDS,
            onChange: setKind,
          },
          {
            id: 'status',
            label: 'Status',
            value: status,
            defaultValue: ALL,
            options: [{ value: ALL, label: 'any' }, ...STATUS_OPTIONS],
            onChange: setStatus,
          },
          {
            id: 'org',
            label: 'Organization',
            value: org,
            defaultValue: ALL,
            options: [
              { value: ALL, label: 'any' },
              ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
            ],
            onChange: setOrg,
          },
        ]}
        onClear={() => {
          setKind(ALL);
          setStatus(ALL);
          setOrg(ALL);
        }}
      />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Apple identities"
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          data={rows}
          getRowId={(i) => i.id}
          empty={
            <EmptyState
              art="certificate"
              title={empty ? 'No identities' : 'No matches'}
              action={empty ? create('primary') : undefined}
            />
          }
          footer={<LoadMore query={list} shown={rows.length} noun={['identity', 'identities']} />}
          columns={columns}
        />
      )}
      <UploadIdentityDialog open={uploading} onOpenChange={setUploading} />
      <NewManagedIdentityDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
