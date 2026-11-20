import { Download } from 'lucide-react';
import type { z } from 'zod';
import type { ReceiptSchema } from '@/shared/contracts/retention.ts';
import { CLASS_RECEIPT_LABEL, RETENTION_COPY } from '@/shared/copy/retention.ts';
import { DATA_CLASSES, isRetentionClass } from '@/shared/privacy/data-classes.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import { modeHeaders } from '@/web/lib/mode.ts';
import { saveFromApi } from '@/web/lib/save-file.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { type RetentionScope, retentionBase, useReceipts } from './queries.ts';

type Receipt = z.infer<typeof ReceiptSchema>;

export const receiptScope = (r: Receipt) =>
  isRetentionClass(r.cls) ? DATA_CLASSES[r.cls].label : (CLASS_RECEIPT_LABEL[r.cls] ?? r.cls);

function counts(r: Receipt) {
  const parts = [`${formatCount(r.deleted)} deleted`];
  if (r.anonymised > 0) parts.push(`${formatCount(r.anonymised)} anonymised`);
  if (r.policyDays !== null) parts.push(`${r.policyDays}-day window`);
  return parts.join(', ');
}

/** Counts and policy of each deletion run, never what was deleted. */
export function ReceiptsCard({
  scope,
  orgId,
  enabled = true,
}: {
  scope: RetentionScope;
  orgId: string;
  enabled?: boolean;
}) {
  const query = useReceipts(scope, orgId, enabled);
  const items = query.data?.items ?? [];
  const save = (r: Receipt) =>
    saveFromApi(
      `${retentionBase(scope, orgId)}/receipts/${encodeURIComponent(r.id)}/download`,
      `retention-receipt-${r.id}.json`,
      modeHeaders(),
      'Could not download the receipt.',
    ).catch((cause: unknown) => toast.error(cause, 'Could not download'));
  return (
    <Card id="receipts">
      <CardHeader title={RETENTION_COPY.receiptsTitle} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{RETENTION_COPY.receiptsLede}</p>
        {query.isPending ? (
          <SkeletonRows rows={3} label="Loading receipts" />
        ) : query.isError ? (
          <ErrorState subject="receipts" error={query.error} onRetry={() => query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState inline art="log" mood="flat" title={RETENTION_COPY.noReceipts} />
        ) : (
          <ListRows label="Retention receipts">
            {items.map((r) => (
              <ListRow
                key={r.id}
                rowId={r.id}
                title={receiptScope(r)}
                pills={
                  <Badge tone={r.verified ? 'success' : 'danger'}>
                    {r.verified ? RETENTION_COPY.verified : RETENTION_COPY.unverified}
                  </Badge>
                }
                meta={`${formatDateTime(r.ranAt)} · ${counts(r)}`}
                trailing={
                  <Button
                    variant="ghost"
                    size="sm"
                    iconStart={<Download aria-hidden />}
                    aria-label={`Download receipt, ${receiptScope(r)}, ${formatDateTime(r.ranAt)}`}
                    onClick={() => void save(r)}
                  >
                    {RETENTION_COPY.download}
                  </Button>
                }
              />
            ))}
          </ListRows>
        )}
      </CardBody>
    </Card>
  );
}
