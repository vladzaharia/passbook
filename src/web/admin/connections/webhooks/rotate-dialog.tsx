import { useState } from 'react';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  RadioGroup,
  SecretReveal,
} from '../../../ui/index.ts';
import { useEndpointActions } from './api.ts';
import { OVERLAP_OPTIONS } from './labels.ts';

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
  const { rotate } = useEndpointActions(endpointId);
  const [overlap, setOverlap] = useState<'0' | '24' | '72'>('24');
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  async function submit() {
    setError(undefined);
    try {
      setSecret((await rotate.mutateAsync(Number(overlap) as 0 | 24 | 72)).secret);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const close = (next: boolean) => {
    if (next || rotate.isPending) return;
    onOpenChange(false);
    setSecret(undefined);
    setError(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (secret && !next ? undefined : close(next))}>
      <DialogContent
        title={secret ? 'New signing secret' : 'Rotate secret'}
        description={secret ? undefined : 'Requests are signed with the new secret from now on.'}
        closeButton={!secret}
        size="md"
        footer={
          secret ? undefined : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button loading={rotate.isPending} onClick={() => void submit()}>
                Rotate
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <SecretReveal
            fields={[{ label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' }]}
            onDone={() => close(false)}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <RadioGroup
              legend="Keep the old secret for"
              orientation="horizontal"
              options={OVERLAP_OPTIONS}
              value={overlap}
              onValueChange={(v) => setOverlap(v === '0' || v === '72' ? v : '24')}
            />
            <p className="text-xs text-fg-muted">
              {overlap === '0'
                ? 'The old secret stops working now. Update your receiver first.'
                : 'Both secrets sign each request until the old one expires.'}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
