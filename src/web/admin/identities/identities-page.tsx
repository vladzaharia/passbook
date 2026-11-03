import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { formatCount } from '@/web/lib/format.ts';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  RowLink,
  StatusPill,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { ApnsPill, ExpiryPill } from './expiry.tsx';
import { useIdentityPages } from './queries.ts';
import { UploadIdentityDialog } from './upload-dialog.tsx';

type Identity = z.infer<typeof IdentitySchema>;
const Icon = ENTITY.identity.icon;

export function IdentitiesPage() {
  const list = useIdentityPages();
  const orgName = useOrgNames();
  const [uploading, setUploading] = useState(false);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const empty = !list.isPending && !list.isError && rows.length === 0;
  const upload = (variant: 'primary' | 'outline') => (
    <Button
      variant={variant}
      iconStart={<ACTION_ICON.upload aria-hidden />}
      onClick={() => setUploading(true)}
    >
      Upload
    </Button>
  );
  const columns = useMemo<ColumnDef<Identity, never>[]>(() => {
    const now = Date.now();
    return [
      {
        header: 'Identity',
        id: 'label',
        cell: ({ row }) => (
          <div className="flex min-h-10 min-w-0 items-center gap-3">
            <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <div className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <RowLink
                  to="/admin/identities/$identityId"
                  params={{ identityId: row.original.id }}
                >
                  {row.original.label}
                </RowLink>
                {row.original.isDefault ? <StatusPill status="default" /> : null}
              </span>
              <span className="block truncate font-mono text-xs text-fg-muted">
                {row.original.passTypeIdentifier}
              </span>
            </div>
          </div>
        ),
      },
      {
        header: 'Owner',
        id: 'org',
        meta: { nowrap: true, hideBelow: 'lg' },
        cell: ({ row }) => orgName(row.original.orgId),
      },
      {
        header: 'Certificate',
        id: 'expiry',
        cell: ({ row }) => <ExpiryPill identity={row.original} now={now} />,
      },
      { header: 'APNs', id: 'apns', cell: ({ row }) => <ApnsPill identity={row.original} /> },
      {
        header: 'Passes',
        id: 'passes',
        meta: { numeric: true, hideBelow: 'lg', stackHidden: true },
        cell: ({ row }) => formatCount(row.original.passCount),
      },
    ];
  }, [orgName]);
  return (
    <>
      <PageHeader title="Apple identities" actions={upload(empty ? 'outline' : 'primary')} />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Apple identities"
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          data={rows}
          getRowId={(i) => i.id}
          empty={<EmptyState art="certificate" title="No identities" action={upload('primary')} />}
          footer={<LoadMore query={list} shown={rows.length} noun={['identity', 'identities']} />}
          columns={columns}
        />
      )}
      <UploadIdentityDialog open={uploading} onOpenChange={setUploading} />
    </>
  );
}
