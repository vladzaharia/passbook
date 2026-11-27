import type { OverlapHours } from '@/shared/contracts/webhook-secrets.ts';
import { Button, Dialog, DialogContent } from '../../../ui/index.ts';
import { RotateSecretForm, useRotateSecret } from '../../../ui/webhook-setup/index.ts';
import { useSecretCalls } from './api.ts';
import { FocusOnMount } from './focus-on-mount.tsx';

/**
 * Rotate the signing secret, on the kit's form: the old one keeps signing for the chosen time
 * (each request carries a signature per live secret), so receivers switch without a gap. The new
 * one shows once.
 */
export function RotateDialog({
  endpointId,
  open,
  onOpenChange,
}: {
  endpointId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rotate } = useSecretCalls();
  const state = useRotateSecret((hours: OverlapHours) => rotate(endpointId, hours));
  const close = (next: boolean) => {
    if (next || state.busy) return;
    onOpenChange(false);
    state.reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (state.secret && !next ? undefined : close(next))}>
      <DialogContent
        title={state.secret ? 'New signing secret' : 'Rotate secret'}
        closeButton={!state.secret}
        size="md"
        footer={
          state.secret ? undefined : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" form={state.formId} loading={state.busy}>
                Rotate
              </Button>
            </>
          )
        }
      >
        {state.secret ? (
          <FocusOnMount label="New signing secret">
            <RotateSecretForm state={state} onDone={() => close(false)} />
          </FocusOnMount>
        ) : (
          <RotateSecretForm state={state} onDone={() => close(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
