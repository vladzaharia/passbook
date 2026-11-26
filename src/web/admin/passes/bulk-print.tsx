import { Printer } from 'lucide-react';
import { useRef, useState } from 'react';
import { BulkPrintStartedSchema, PRINT_BULK_MAX } from '@/shared/contracts/prints.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { api } from '../../lib/api.ts';
import { modeHeaders } from '../../lib/mode.ts';
import { DropdownMenuItem, toast } from '../../ui/index.ts';
import { OperationSheet } from '../../ui/operation/index.ts';
import { AdminOperations } from '../operations/admin-operation.tsx';
import { printNote } from '../operations/notes.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';

/** The PDF goes through fetch so Test mode's header travels with it; a plain link would not carry it. */
async function savePdf(orgId: string, jobId: string): Promise<void> {
  const res = await fetch(
    `/api/v1/passes/bulk-print/${encodeURIComponent(jobId)}/pdf?orgId=${encodeURIComponent(orgId)}`,
    { headers: modeHeaders(), credentials: 'same-origin' },
  );
  if (!res.ok) throw new Error(PRINT_COPY.couldNotPrint);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tickets.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Bulk Print of a selection: prints the passes that have no active print, then one combined PDF. The job shows as
 * an operation in a sheet (the tray takes over when it is closed); Download is the same authorized call as ever.
 * The hook keeps the sheet outside the menu, which unmounts when it closes.
 */
export function useBulkPrint({
  ids,
  orgId,
  disabled,
}: {
  ids: string[];
  orgId: string | undefined;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [opId, setOpId] = useState<string | null>(null);
  const zone = useOrgTimeZone(orgId);
  const tooLong = ids.length > PRINT_BULK_MAX;
  const off = disabled || !orgId || tooLong || busy;
  const jobRef = useRef<string | null>(null);
  async function run() {
    if (!orgId) return;
    setBusy(true);
    try {
      const started = await api.post('/api/v1/passes/bulk-print', BulkPrintStartedSchema, {
        ids,
        orgId,
      });
      if (started.count === 0) {
        toast.warning(PRINT_COPY.bulkNone);
        return;
      }
      // The job is queued, but nothing can show it: say so instead of leaving the person guessing.
      if (!started.operationId) {
        toast.info(PRINT_COPY.bulkSlow);
        return;
      }
      jobRef.current = started.jobId;
      setOpId(started.operationId);
    } catch (error) {
      toast.error(error, PRINT_COPY.couldNotPrint);
    } finally {
      setBusy(false);
    }
  }
  const panel = (
    <AdminOperations>
      <OperationSheet
        id={opId}
        zone={zone}
        doneNote={printNote}
        onClose={() => setOpId(null)}
        next={{
          label: PRINT_COPY.bulkDownload,
          onClick: () => {
            if (orgId && jobRef.current)
              void savePdf(orgId, jobRef.current).catch((e: unknown) =>
                toast.error(e, PRINT_COPY.couldNotPrint),
              );
          },
        }}
      />
    </AdminOperations>
  );
  return {
    off,
    run: () => void run(),
    title: tooLong ? PRINT_COPY.bulkCap(PRINT_BULK_MAX) : undefined,
    panel,
  };
}

export function PrintMenuItem({ print }: { print: ReturnType<typeof useBulkPrint> }) {
  return (
    <DropdownMenuItem disabled={print.off} title={print.title} onSelect={print.run}>
      <Printer aria-hidden />
      {PRINT_COPY.print}
    </DropdownMenuItem>
  );
}
