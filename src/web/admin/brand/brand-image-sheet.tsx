import { useState } from 'react';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { Button, Dialog, DialogContent, ErrorState, SkeletonRows, toast } from '@/web/ui/index.ts';
import { isSetupChanged, usePassSetup, useSavePassSetup } from './api.ts';
import { AssetTile } from './asset-tile.tsx';
import type { StagedImage } from './draft.ts';

const COPY = PASS_FIX_COPY.sheet;

/**
 * The Logo (or Icon) sheet: the Brand page's own asset field in a dialog (a bottom sheet on a
 * phone), so a pass screen can fix a missing image without leaving. Save commits the staged PNG
 * with the same PATCH the page sends.
 */
export function BrandImageSheet({
  orgId,
  slot,
  open,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  slot: 'logo' | 'icon';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (slot: 'logo' | 'icon') => void;
}) {
  const setup = usePassSetup(orgId);
  const save = useSavePassSetup(orgId);
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const close = (next: boolean) => {
    if (!next) setStaged(null);
    onOpenChange(next);
  };

  async function commit() {
    if (!staged || !setup.data) return;
    try {
      await save.mutateAsync({
        expectedRevision: setup.data.revision,
        brand: { [slot]: { sha: staged.sha } },
      });
      onSaved(slot);
      close(false);
    } catch (cause) {
      if (isSetupChanged(cause)) {
        toast.error(COPY.stale, 'Could not save');
        void setup.refetch();
      } else toast.error(cause, 'Could not save');
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={COPY.title[slot]}
        size="sm"
        footer={
          <>
            <Button variant="outline" disabled={save.isPending} onClick={() => close(false)}>
              {COPY.cancel}
            </Button>
            <Button loading={save.isPending} disabled={!staged || !setup.data} onClick={commit}>
              {COPY.save}
            </Button>
          </>
        }
      >
        {setup.isPending ? (
          <SkeletonRows rows={2} label="Loading brand" />
        ) : setup.isError ? (
          <ErrorState
            inline
            subject="the brand"
            error={setup.error}
            onRetry={() => setup.refetch()}
          />
        ) : (
          <AssetTile
            orgId={orgId}
            slot={slot}
            tag={null}
            src={staged?.url}
            alt={`New ${slot}`}
            staged={staged !== null}
            canEdit
            fixedSize={slot === 'icon'}
            onStage={(image) => setStaged(image)}
            onClear={() => setStaged(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
