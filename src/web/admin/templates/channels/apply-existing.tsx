import { useState } from 'react';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { Button, toast } from '../../../ui/index.ts';
import { useApplyToExistingPasses } from './api.ts';
import { ReviewDialog } from './review-dialog.tsx';

/** Passes that carry their own channel choices go back to following the template. */
export function ApplyExisting({
  templateId,
  orgId,
  disabled,
}: {
  templateId: string;
  orgId: string;
  /** Unsaved edits: apply what is saved, not what is drafted. */
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const apply = useApplyToExistingPasses(templateId, orgId);
  return (
    <>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {CHANNEL_COPY.applyExisting}
      </Button>
      <ReviewDialog
        open={open}
        onOpenChange={setOpen}
        title={CHANNEL_COPY.applyTitle}
        confirmLabel="Apply"
        lines={[CHANNEL_COPY.applyBody]}
        onConfirm={async () => {
          try {
            const n = await apply.mutateAsync();
            toast.success(n === 0 ? CHANNEL_COPY.applyNone : CHANNEL_COPY.applyDone);
          } catch {
            throw new Error(CHANNEL_COPY.applyFailed);
          }
        }}
      />
    </>
  );
}
