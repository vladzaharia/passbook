import { useState } from 'react';
import type { OverlapHours } from '@/shared/contracts/webhook-secrets.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  RadioGroup,
  SecretReveal,
} from '../../../ui/index.ts';
import { OVERLAP_OPTIONS } from '../../../ui/webhooks/labels.ts';
import { useSecretCalls } from './api.ts';
import { FocusOnMount } from './focus-on-mount.tsx';

/**
 * Rotate the signing secret. The old one keeps signing for the chosen time (each request carries a
 * signature per live secret), so receivers switch without a gap. The new one shows once.
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
  const [busy, setBusy] = useState(false);
  const [overlap, setOverlap] = useState<`${OverlapHours}`>('24');
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  async function submit() {
    setError(undefined);
    setBusy(true);
    try {
      setSecret((await rotate(endpointId, Number(overlap) as OverlapHours)).secret);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const close = (next: boolean) => {
    if (next || busy) return;
    onOpenChange(false);
    setSecret(undefined);
    setError(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (secret && !next ? undefined : close(next))}>
      <DialogContent
        title={secret ? 'New signing secret' : 'Rotate secret'}
        closeButton={!secret}
        size="md"
        footer={
          secret ? undefined : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button loading={busy} onClick={() => void submit()}>
                Rotate
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <FocusOnMount label="New signing secret">
            <SecretReveal
              fields={[
                { label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' },
              ]}
              onDone={() => close(false)}
            />
          </FocusOnMount>
        ) : (
          <div className="flex flex-col gap-4">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <RadioGroup
              legend="Keep the old secret for"
              orientation="horizontal"
              options={OVERLAP_OPTIONS}
              value={overlap}
              onValueChange={(v) =>
                setOverlap(OVERLAP_OPTIONS.find((o) => o.value === v)?.value ?? '24')
              }
            />
            <p className="text-xs text-fg-muted">
              {overlap === '0'
                ? 'The old secret stops working now. Update your receiver first.'
                : 'Both secrets sign each request until the old one expires. If it leaked, choose Now.'}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
