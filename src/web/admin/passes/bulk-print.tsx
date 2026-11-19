import { Printer } from 'lucide-react';
import { useState } from 'react';
import {
  BulkPrintStartedSchema,
  BulkPrintStatusSchema,
  PRINT_BULK_MAX,
} from '@/shared/contracts/prints.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { api } from '../../lib/api.ts';
import { modeHeaders } from '../../lib/mode.ts';
import { Button, DropdownMenuItem, toast } from '../../ui/index.ts';

const POLL_MS = 2000;
const POLL_TRIES = 60;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n: number) => `${n} ${n === 1 ? 'ticket' : 'tickets'}`;

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

/** Waits for the render job, then offers the PDF. Runs on after the selection is gone. */
async function whenReady(
  orgId: string,
  jobId: string,
  count: number,
  preparing: string | number,
): Promise<void> {
  const path = `/api/v1/passes/bulk-print/${encodeURIComponent(jobId)}`;
  for (let i = 0; i < POLL_TRIES; i++) {
    await wait(POLL_MS);
    const status = await api.get(path, BulkPrintStatusSchema, { query: { orgId } });
    if (status.state === 'failed') {
      toast.dismiss(preparing);
      throw new Error(PRINT_COPY.bulkFailed);
    }
    if (status.state === 'ready') {
      toast.dismiss(preparing);
      toast.action(PRINT_COPY.bulkReady(plural(status.count || count), status.lossy), {
        label: PRINT_COPY.bulkDownload,
        onClick: () =>
          void savePdf(orgId, jobId).catch((e: unknown) =>
            toast.error(e, PRINT_COPY.couldNotPrint),
          ),
      });
      return;
    }
  }
  toast.dismiss(preparing);
  throw new Error(PRINT_COPY.bulkSlow);
}

/**
 * Bulk Print of a selection: prints the passes that have no active print, then one combined PDF.
 * `menu` renders a menu item (below lg), `button` a bar button.
 */
export function BulkPrintAction({
  ids,
  orgId,
  disabled,
  as,
}: {
  ids: string[];
  orgId: string | undefined;
  disabled: boolean;
  as: 'button' | 'menu';
}) {
  const [busy, setBusy] = useState(false);
  const tooLong = ids.length > PRINT_BULK_MAX;
  const off = disabled || !orgId || tooLong || busy;
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
      const left = started.skipped.length;
      const preparing = toast.info(PRINT_COPY.bulkPreparing(plural(started.count), left));
      void whenReady(orgId, started.jobId, started.count, preparing).catch((e: unknown) =>
        toast.error(e, PRINT_COPY.couldNotPrint),
      );
    } catch (error) {
      toast.error(error, PRINT_COPY.couldNotPrint);
    } finally {
      setBusy(false);
    }
  }
  const title = tooLong ? PRINT_COPY.bulkCap(PRINT_BULK_MAX) : undefined;
  return as === 'menu' ? (
    <DropdownMenuItem disabled={off} title={title} onSelect={() => void run()}>
      <Printer aria-hidden />
      {PRINT_COPY.print}
    </DropdownMenuItem>
  ) : (
    <span title={title}>
      <Button
        variant="outline"
        disabled={off}
        iconStart={<Printer aria-hidden />}
        onClick={() => void run()}
      >
        {PRINT_COPY.print}
      </Button>
    </span>
  );
}
