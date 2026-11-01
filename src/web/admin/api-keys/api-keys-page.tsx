import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiKeyListSchema, type ApiKeySchema } from '@/shared/contracts/api-keys.ts';
import { api } from '@/web/lib/api.ts';
import { useOrgFilter } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { formatDay } from '../overview/format.ts';
import { CreateKeyDialog } from './create-key-dialog.tsx';

type ApiKey = z.infer<typeof ApiKeySchema>;
const KEYS = ['api-keys'] as const;

export function keyState(key: ApiKey, now: number): 'revoked' | 'expired' | 'active' {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
  return 'active';
}

export function ApiKeysPage() {
  const client = useQueryClient();
  const orgName = useOrgNames();
  const { orgId } = useOrgFilter();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey>();
  const list = useQuery({
    queryKey: KEYS,
    queryFn: ({ signal }) => api.get('/api/v1/api-keys', ApiKeyListSchema, { signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/api-keys/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: KEYS }),
  });
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="API keys"
        actions={
          <Button iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            New API key
          </Button>
        }
      />
      {list.isPending ? (
        <SkeletonRows label="Loading API keys" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="API keys"
          data={list.data.items.filter((k) => !orgId || k.orgId === orgId)}
          getRowId={(k) => k.id}
          empty={
            <EmptyState
              icon={KeyRound}
              title="No API keys"
              action={
                <Button iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                  New API key
                </Button>
              }
            />
          }
          columns={[
            { header: 'Name', accessorKey: 'name', meta: { nowrap: true } },
            {
              header: 'Prefix',
              accessorKey: 'prefix',
              cell: ({ row }) => (
                <code className="font-mono text-xs">wlt_{row.original.prefix}</code>
              ),
            },
            {
              header: 'Org',
              id: 'org',
              meta: { nowrap: true },
              cell: ({ row }) => orgName(row.original.orgId),
            },
            {
              header: 'Scopes',
              id: 'scopes',
              meta: { hideBelow: 'xl', stackHidden: true },
              cell: ({ row }) => (
                <span className="flex flex-wrap gap-1">
                  {row.original.scopes.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </span>
              ),
            },
            {
              header: 'Last used',
              id: 'used',
              meta: { hideBelow: 'xl', stackHidden: true, nowrap: true },
              cell: ({ row }) => formatDay(row.original.lastUsedAt, 'Never'),
            },
            {
              header: 'Expires',
              id: 'expires',
              meta: { nowrap: true },
              cell: ({ row }) => formatDay(row.original.expiresAt, 'Never'),
            },
            {
              header: 'Status',
              id: 'status',
              cell: ({ row }) => {
                const s = keyState(row.original, now);
                return (
                  <StatusPill
                    status={s}
                    tone={s === 'active' ? 'success' : s === 'expired' ? 'warning' : 'neutral'}
                  >
                    {s[0]?.toUpperCase()}
                    {s.slice(1)}
                  </StatusPill>
                );
              },
            },
            {
              header: () => <span className="sr-only">Actions</span>,
              id: 'actions',
              cell: ({ row }) =>
                row.original.revokedAt === null ? (
                  <Button variant="outline" size="sm" onClick={() => setRevoking(row.original)}>
                    Revoke
                    <span className="sr-only"> {row.original.name}</span>
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Requests using this key fail immediately. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          toast.success('Key revoked');
        }}
      />
    </>
  );
}
