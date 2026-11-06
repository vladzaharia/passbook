import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScanOutcomeSchema } from '@/shared/contracts/scan.ts';
import type { ScanRecordDto } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { scanId } from '@/web/scan/platform/id.ts';
import {
  Button,
  ConfirmDialog,
  KeyValue,
  Sheet,
  SheetContent,
  StatusPill,
} from '@/web/ui/index.ts';

export function ScanDetail({ row, onClose }: { row: ScanRecordDto; onClose: () => void }) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const undo = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/scans/${encodeURIComponent(row.id)}/undo`, ScanOutcomeSchema, {
        idempotencyKey: scanId(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning'] });
      onClose();
    },
  });
  const canUndo = !row.undoneAt && row.kind === 'check_in' && row.outcome === 'ok';
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent title="Scan" className="sm:w-[440px]">
          <div className="flex flex-col gap-5 p-5">
            <h2 className="text-lg font-semibold">{row.passTitle ?? 'Unknown code'}</h2>
            <StatusPill status={row.undoneAt ? 'undone' : row.outcome} />
            <KeyValue
              items={[
                { label: 'Time', value: formatDateTime(row.at) },
                { label: 'What', value: row.actionLabel ?? row.reason },
                {
                  label: 'Pass',
                  value: row.passId ? (
                    <a
                      className="text-accent-fg"
                      href={`/admin/passes/${encodeURIComponent(row.passId)}`}
                    >
                      {row.passTitle ?? row.passId}
                    </a>
                  ) : (
                    'Unknown code'
                  ),
                },
                { label: 'Template', value: row.templateName },
                { label: 'Event', value: row.eventName },
                { label: 'Scanner', value: row.scannerName ?? 'Admin console' },
                { label: 'Staff', value: row.staffName },
                { label: 'Approved by', value: row.approvedBy },
                { label: 'How', value: row.method },
                { label: 'Amount', value: row.amount },
                {
                  label: 'Before → after',
                  value:
                    row.before !== null || row.after !== null
                      ? `${JSON.stringify(row.before)} → ${JSON.stringify(row.after)}`
                      : null,
                },
                { label: 'Pass version', value: row.passVersion },
                { label: 'Override', value: row.override ? 'Yes' : 'No' },
                ...(row.undoneAt
                  ? [
                      {
                        label: 'Undone',
                        value: `${formatDateTime(row.undoneAt)} · ${row.undoneBy ?? 'Admin console'}`,
                      },
                    ]
                  : []),
              ]}
            />
            <details>
              <summary className="cursor-pointer text-sm font-medium">Details</summary>
              <div className="pt-3">
                <KeyValue
                  items={[
                    { label: 'Reason', value: row.reason, mono: true },
                    { label: 'Scan ID', value: row.id, mono: true },
                  ]}
                />
              </div>
            </details>
            {canUndo ? (
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                Undo check-in
              </Button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Undo check-in?"
        description="The pass can be checked in again."
        confirmLabel="Undo check-in"
        onConfirm={() => undo.mutateAsync().then(() => undefined)}
      />
    </>
  );
}
