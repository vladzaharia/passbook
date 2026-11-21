import { Plus } from 'lucide-react';
import { useState } from 'react';
import { KEYSET_COPY } from '@/shared/copy/tag-keysets.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { Badge, Button, DataTable, EmptyState, ErrorState, StatusPill } from '@/web/ui/index.ts';
import { type Keyset, useKeysets, useKeysetWrites } from './api.ts';
import { NewKeysetDialog } from './key-forms.tsx';
import { KeysetSheet } from './keyset-sheet.tsx';
import { activeVersion, kindOf, retiringVersion, tagCount } from './words.ts';

/**
 * Scanning > Tags > Secure keys: the org's keysets in the current mode. Open one for its versions and the
 * ways to rotate, revoke, import and move tags. Keys are never listed: they are shown once, when made.
 */
export function KeysetsView({
  orgId,
  canManage,
  open,
  onOpen,
}: {
  orgId: string;
  canManage: boolean;
  open: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const query = useKeysets(orgId);
  const writes = useKeysetWrites(orgId);
  const [creating, setCreating] = useState(false);
  const columns: DataColumnDef<Keyset>[] = [
    {
      id: 'name',
      header: 'Keyset',
      cell: ({ row }) => (
        <button
          type="button"
          className="text-left text-fg-strong underline-offset-2 hover:underline"
          onClick={() => onOpen(row.original.id)}
        >
          {row.original.name}
        </button>
      ),
    },
    { id: 'kind', header: 'Keys', cell: ({ row }) => <Badge>{kindOf(row.original)}</Badge> },
    {
      id: 'version',
      header: 'Version',
      cell: ({ row }) => {
        const active = activeVersion(row.original);
        const retiring = retiringVersion(row.original);
        return active
          ? `v${active.version}${retiring ? ` · v${retiring.version} retiring` : ''}`
          : null;
      },
    },
    { id: 'tags', header: 'Tags', cell: ({ row }) => tagCount(row.original) },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <StatusPill status={row.original.disabledAt === null ? 'active' : 'disabled'} />
      ),
    },
    { id: 'created', header: 'Created', cell: ({ row }) => formatDateTime(row.original.createdAt) },
  ];
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const rows = query.data?.items ?? [];
  const add = canManage ? (
    <Button iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      {KEYSET_COPY.add}
    </Button>
  ) : null;
  return (
    <>
      {rows.length ? <div className="mb-4 flex justify-end">{add}</div> : null}
      <DataTable
        caption="Secure keysets"
        data={rows}
        columns={columns}
        getRowId={(k) => k.id}
        loading={query.isPending}
        empty={<EmptyState art="badge" title={KEYSET_COPY.empty.title} action={add} />}
      />
      {open ? (
        <KeysetSheet
          orgId={orgId}
          id={open}
          canManage={canManage}
          onClose={() => onOpen(undefined)}
        />
      ) : null}
      {creating ? (
        <NewKeysetDialog create={writes.create} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
