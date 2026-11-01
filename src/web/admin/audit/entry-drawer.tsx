import type { z } from 'zod';
import type { AuditEntrySchema } from '@/shared/contracts/audit.ts';
import { DiffViewer, JsonViewer, KeyValue, Sheet, SheetContent } from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { actionLabel, actorText, targetText } from './labels.ts';
import { describeDetail } from './redact.ts';

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export function EntryDrawer({
  entry,
  orgName,
  onClose,
}: {
  entry: AuditEntry | undefined;
  orgName: (id: string | null) => string;
  onClose: () => void;
}) {
  const view = describeDetail(entry?.detail);
  return (
    <Sheet open={entry !== undefined} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={entry ? actionLabel(entry.action) : 'Audit entry'} className="w-96">
        {entry ? (
          <div className="flex flex-col gap-5 overflow-y-auto p-4">
            <KeyValue
              items={[
                { label: 'Action', value: entry.action, mono: true },
                { label: 'Time', value: formatDateTime(entry.at) },
                {
                  label: 'Actor',
                  value: actorText(entry),
                },
                {
                  label: 'Target',
                  value: targetText(entry) || null,
                },
                { label: 'Org', value: entry.orgId ? orgName(entry.orgId) : null },
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
