import type { z } from 'zod';
import type { AuditEntrySchema } from '@/shared/contracts/audit.ts';
import { actionLabel } from '@/web/lib/actions.ts';
import { DiffViewer, JsonViewer, KeyValue, Sheet, SheetContent } from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { actorRef, targetRef } from './labels.ts';
import { describeDetail } from './redact.ts';
import { RefChip } from './ref-chip.tsx';

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** The one place raw codes show: the action code under the label, the request id below. */
export function EntryDrawer({
  entry,
  orgName,
  onClose,
}: {
  entry: AuditEntry | undefined;
  orgName: (id: string | null) => string | undefined;
  onClose: () => void;
}) {
  const view = describeDetail(entry?.detail);
  const target = entry ? targetRef(entry) : undefined;
  return (
    <Sheet open={entry !== undefined} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        title={entry ? actionLabel(entry.action) : 'Audit entry'}
        className="w-96"
        header={
          entry ? (
            <div className="min-w-0">
              <p aria-hidden className="truncate text-sm font-semibold text-fg-strong">
                {actionLabel(entry.action)}
              </p>
              <code className="font-mono text-xs text-fg-muted">{entry.action}</code>
            </div>
          ) : undefined
        }
      >
        {entry ? (
          <div className="flex flex-col gap-5 overflow-y-auto p-4">
            <KeyValue
              items={[
                { label: 'Time', value: formatDateTime(entry.at) },
                { label: 'Actor', value: <RefChip value={actorRef(entry)} /> },
                { label: 'Target', value: target ? <RefChip value={target} /> : null },
                { label: 'Organization', value: entry.orgId ? orgName(entry.orgId) : null },
                { label: 'Request', value: entry.requestId, mono: true },
              ]}
            />
            <section aria-label="Detail" className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-fg-strong">Detail</h3>
              {view.kind === 'none' ? (
                <p className="text-sm text-fg-muted">No detail.</p>
              ) : view.kind === 'diff' ? (
                <DiffViewer before={view.before ?? ''} after={view.after ?? ''} />
              ) : (
                <JsonViewer value={view.value} label="Detail JSON" />
              )}
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
