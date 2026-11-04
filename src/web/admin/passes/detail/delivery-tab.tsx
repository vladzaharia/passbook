import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { DeliveryEntrySchema, type PassDetailDto } from '@/shared/contracts/passes.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { api } from '../../../lib/api.ts';
import { DELIVERY_ICON } from '../../../lib/entities.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { deliveryKindLabel } from '../../../lib/status.ts';
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
  IconButton,
  Input,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';
import { newKey } from '../format.ts';

type Entry = z.infer<typeof DeliveryEntrySchema>;
const ListSchema = z.object({ items: z.array(DeliveryEntrySchema) });

/**
 * Why a push went, from its outbox id: `push:<pass>:<version>` is a published version,
 * `push:<pass>:<reason>:<id>` a forced one (refresh). Emails say nothing more than their kind.
 */
export function deliveryReason(entry: Pick<Entry, 'id' | 'kind'>): string | null {
  if (entry.kind !== 'push') return null;
  const part = entry.id.split(':')[2] ?? '';
  if (/^\d+$/.test(part)) return `Version ${part}`;
  if (part === 'refresh') return 'Refresh';
  if (part === 'publish') return 'Update';
  return null;
}

/** A push with no registered device reached nothing: neutral, never "Sent". */
const noDevices = (e: Entry) => e.state === 'cancelled' && e.errorCode === 'NO_DEVICES';

function SendEmailCard({
  pass,
  sent,
  onSent,
}: {
  pass: PassDetailDto;
  sent: boolean;
  onSent: () => void;
}) {
  const actions = usePassActions(pass.id);
  const [to, setTo] = useState(pass.holderEmail ?? '');
  const [attach, setAttach] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(0);
  // One key per click intent: a retry of the same click cannot send twice.
  const key = useRef(newKey());

  async function send() {
    setError(undefined);
    const address = to.trim();
    try {
      await actions.resendEmail.mutateAsync({
        ...(address && address.toLowerCase() !== pass.holderEmail?.toLowerCase()
          ? { to: address }
          : {}),
        ...(attach ? { attach: true } : {}),
        key: key.current,
      });
      key.current = newKey();
      setDone((n) => n + 1);
      toast.sent(`Email queued to ${address || pass.holderEmail}`);
      onSent();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader title={sent ? 'Resend email' : 'Send email'} />
      <CardBody>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <FormField label="Send to" error={error}>
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
              type="submit"
              iconStart={<ACTION_ICON.sendEmail aria-hidden />}
              loading={actions.resendEmail.isPending}
              done={done}
              disabled={!to.trim()}
            >
              {sent ? 'Resend email' : 'Send email'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function DeliveryTab({ pass }: { pass: PassDetailDto }) {
  const actions = usePassActions(pass.id);
  const delivery = useQuery({
    queryKey: ['admin', 'passes', 'delivery', pass.id],
    queryFn: ({ signal }) =>
      api.get('/api/v1/delivery', ListSchema, { query: { passId: pass.id }, signal }),
    initialData: { items: pass.deliveries },
    staleTime: 0,
  });
  const items = delivery.data.items;
  const sent = items.some((d) => d.kind === 'email');

  async function retry(entry: Entry) {
    try {
      if (entry.kind === 'email') await actions.resendEmail.mutateAsync({ key: newKey() });
      else await actions.refreshFromSource.mutateAsync();
      toast.success('Retry queued');
      void delivery.refetch();
    } catch (cause) {
      toast.error(cause, 'Could not retry');
    }
  }

  // Cell renderers are component types to TanStack Table: keep the array stable or rows remount.
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const columns = useMemo<ColumnDef<Entry, never>[]>(
    () => [
      {
        id: 'kind',
        header: 'Kind',
        cell: ({ row }) => {
          const Icon = DELIVERY_ICON[row.original.kind];
          return (
            <span className="inline-flex items-center gap-2">
              {Icon ? <Icon aria-hidden className="size-4 text-fg-muted" /> : null}
              {deliveryKindLabel(row.original.kind)}
            </span>
          );
        },
      },
      {
        id: 'reason',
        header: 'Reason',
        meta: { nowrap: true },
        cell: ({ row }) =>
          deliveryReason(row.original) ?? <span className="text-fg-subtle">—</span>,
      },
      {
        id: 'state',
        header: 'State',
        cell: ({ row }) => (
          <StatusPill status={noDevices(row.original) ? 'no_devices' : row.original.state} />
        ),
      },
      {
        id: 'attempts',
        header: 'Attempts',
        meta: { numeric: true },
        cell: ({ row }) => row.original.attempts,
      },
      {
        id: 'error',
        header: 'Error',
        cell: ({ row }) =>
          row.original.errorCode && !noDevices(row.original) ? (
            <span className="font-mono text-xs text-fg-muted">{row.original.errorCode}</span>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      {
        id: 'created',
        header: 'Created',
        meta: { nowrap: true },
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        id: 'retry',
        header: () => <span className="sr-only">Retry</span>,
        cell: ({ row }) =>
          row.original.state === 'failed' || row.original.state === 'partial' ? (
            <Button
              size="sm"
              variant="ghost"
              iconStart={<ACTION_ICON.refresh aria-hidden />}
              onClick={() => void retryRef.current(row.original)}
            >
              Retry
            </Button>
          ) : null,
      },
    ],
    [],
  );

  return (
    <div className="grid min-w-0 gap-6">
      <SendEmailCard pass={pass} sent={sent} onSent={() => void delivery.refetch()} />
      <Card className="min-w-0">
        <CardHeader
          title="Outbox"
          actions={
            <IconButton
              size="sm"
              label="Reload list"
              data-busy={delivery.isFetching ? 'spin' : undefined}
              icon={<ACTION_ICON.refresh aria-hidden />}
              onClick={() => void delivery.refetch()}
            />
          }
        />
        {delivery.isError ? (
          <CardBody>
            <ErrorState inline error={delivery.error} onRetry={() => void delivery.refetch()} />
          </CardBody>
        ) : (
          <DataTable
            caption="Delivery history"
            bare
            stack={false}
            columns={columns}
            data={items}
            getRowId={(r) => r.id}
            fetching={delivery.isFetching}
            empty={<EmptyState inline art="envelope" title="Nothing sent yet" />}
          />
        )}
      </Card>
    </div>
  );
}
