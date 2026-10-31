import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Mail, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { DeliveryEntrySchema, type PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';
import { formatDate, newKey } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;
type Entry = z.infer<typeof DeliveryEntrySchema>;
const ListSchema = z.object({ items: z.array(DeliveryEntrySchema) });

const TONE: Record<Entry['state'], 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  sent: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
  pending: 'info',
  enqueued: 'info',
  processing: 'info',
};

export function DeliveryTab({ pass }: { pass: Pass }) {
  const actions = usePassActions(pass.id);
  const delivery = useQuery({
    queryKey: ['admin', 'passes', 'delivery', pass.id],
    queryFn: ({ signal }) =>
      api.get('/api/v1/delivery', ListSchema, { query: { passId: pass.id }, signal }),
    initialData: { items: pass.deliveries },
    staleTime: 0,
  });
  const [to, setTo] = useState('');
  const [attach, setAttach] = useState(false);
  const [error, setError] = useState<string>();
  // One key per click intent: a retry of the same click cannot send twice.
  const key = useRef(newKey());

  async function resend(address?: string) {
    const withAttachment = attach;
    setError(undefined);
    try {
      await actions.resendEmail.mutateAsync({
        ...(address ? { to: address } : {}),
        ...(withAttachment ? { attach: true } : {}),
        key: key.current,
      });
      key.current = newKey();
      toast.success('Email queued');
      void delivery.refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function retry(entry: Entry) {
    try {
      if (entry.kind === 'email') await actions.resendEmail.mutateAsync({ key: newKey() });
      else await actions.refreshFromSource.mutateAsync();
      toast.success('Retry queued');
      void delivery.refetch();
    } catch (cause) {
      toast.error(cause);
    }
  }

  // Cell renderers are component types to TanStack Table: keep the array stable or rows remount.
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const columns = useMemo<ColumnDef<Entry, never>[]>(
    () => [
      { id: 'kind', header: 'Kind', enableSorting: false, cell: ({ row }) => row.original.kind },
      {
        id: 'state',
        header: 'State',
        enableSorting: false,
        cell: ({ row }) => (
          <StatusPill status={row.original.state} tone={TONE[row.original.state]} />
        ),
      },
      {
        id: 'attempts',
        header: 'Attempts',
        enableSorting: false,
        cell: ({ row }) => row.original.attempts,
      },
      {
        id: 'error',
        header: 'Error',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.errorCode ?? ''}</span>
        ),
      },
      {
        id: 'created',
        header: 'Created',
        enableSorting: false,
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: 'retry',
        header: () => <span className="sr-only">Retry</span>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.state === 'failed' || row.original.state === 'partial' ? (
            <Button size="sm" variant="outline" onClick={() => void retryRef.current(row.original)}>
              Retry
            </Button>
          ) : null,
      },
    ],
    [],
  );

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title="Outbox"
          actions={
            <Button
              size="sm"
              variant="outline"
              iconStart={<RefreshCw aria-hidden />}
              loading={delivery.isFetching}
              onClick={() => void delivery.refetch()}
            >
              Refresh
            </Button>
          }
        />
        <CardBody>
          {delivery.isError ? (
            <ErrorState error={delivery.error} onRetry={() => void delivery.refetch()} />
          ) : (
            <DataTable
              caption="Delivery history"
              columns={columns}
              data={delivery.data.items}
              getRowId={(r) => r.id}
              empty={<EmptyState icon={Mail} title="Nothing sent yet" />}
            />
          )}
          <p className="mt-2 text-xs text-fg-muted">Accepted means handed off, not received.</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Resend email" />
        <CardBody className="grid max-w-md gap-3">
          <FormField
            label="Send to"
            help={
              pass.holderEmail ? `Default: ${pass.holderEmail}` : 'The pass has no holder email.'
            }
            error={error}
          >
            {(c) => (
              <Input
                {...c}
                type="email"
                autoComplete="off"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label="Attach .pkpass"
            checked={attach}
            onCheckedChange={(c) => setAttach(c === true)}
          />
          <div>
            <Button
              loading={actions.resendEmail.isPending}
              disabled={!to.trim() && !pass.holderEmail}
              onClick={() => void resend(to.trim() || undefined)}
            >
              Resend email
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
