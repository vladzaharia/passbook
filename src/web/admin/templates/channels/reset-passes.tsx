import { useState } from 'react';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { Button, toast } from '../../../ui/index.ts';
import { useResetPasses } from './api.ts';
import { ReviewDialog } from './review-dialog.tsx';

const COPY = TEMPLATE_BRAND_COPY.reset;

/**
 * The foot of the channel list: how many passes carry their own choice, and Reset N passes, which
 * sends only those channels back to following the template.
 */
export function ResetPasses({
  templateId,
  orgId,
  passes,
  overrides,
  disabled,
  canReset,
}: {
  templateId: string;
  orgId: string;
  passes: number;
  overrides: Record<Channel, number>;
  /** Unsaved edits: reset what is saved, not what is drafted. */
  disabled: boolean;
  canReset: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reset = useResetPasses(templateId, orgId);
  const lines = CHANNELS.filter((c) => (overrides[c] ?? 0) > 0).map((c) =>
    scanLine(COPY.line, { channel: CHANNEL_LABEL[c], n: overrides[c] ?? 0 }),
  );
  if (passes === 0) return <p className="text-sm text-fg-muted">{COPY.none}</p>;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-fg-muted">
        {passes === 1 ? COPY.one : scanLine(COPY.some, { n: passes })}
      </p>
      {canReset ? (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
          {passes === 1 ? COPY.buttonOne : scanLine(COPY.button, { n: passes })}
        </Button>
      ) : null}
      <ReviewDialog
        open={open}
        onOpenChange={setOpen}
        title={COPY.title}
        confirmLabel="Reset"
        lines={[...lines, COPY.body]}
        onConfirm={async () => {
          try {
            const { done, remaining } = await reset.mutateAsync();
            if (remaining > 0) toast.warning(scanLine(COPY.partial, { done, total: passes }));
            else toast.success(COPY.done);
          } catch {
            throw new Error(COPY.failed);
          }
        }}
      />
    </div>
  );
}
